'use strict';

/**
 * voice_ai.js
 *
 * AI voice reply pipeline for AdminFriend mode. When the recorder finishes an
 * admin voice clip:
 *
 *   1. STT  : ElevenLabs Scribe transcribes the clip to text. Done EAGERLY
 *             (right when the clip arrives) so by the time the debounce window
 *             expires we already have text in hand and can fire the LLM
 *             immediately.
 *   2. Buffer: The transcript is appended to a per-admin buffer. A debounce
 *             timer is (re)scheduled — every new clip resets the timer, so
 *             the bot waits until the admin actually stops talking before
 *             replying. Once the admin has been silent for `debounceMs`,
 *             all buffered transcripts are merged and sent as ONE input to
 *             the LLM. Capped by `debounceMaxWaitMs` so the bot can't be
 *             stalled forever by an admin who never pauses.
 *   3. LLM  : OpenRouter (gpt-5.2 by default) generates a short reply with
 *             per-admin conversation memory and a strict "casual teen player,
 *             never admit to cheating" system prompt loaded from a text file
 *             (default: ai_voice_prompt.txt) so it can be edited without
 *             touching JS.
 *   4. TTS  : ElevenLabs synthesizes the reply in the user's cloned voice.
 *   5. Opus : The MP3 is transcoded to 20ms Opus frames via voice_audio.js.
 *   6. Send : Frames are streamed back through the existing VoiceChatClient
 *             (Simple Voice Chat MicPackets).
 *   7. Hook : `onReplyGenerated` callback fires with { username, transcript,
 *             reply, mp3Buf } so the host process can upload the reply to
 *             Discord (or anywhere else).
 *
 * Anti-spam rules (configurable):
 *   - minReplyGapMs    : min cooldown between successful replies per admin.
 *   - replyWindowCap   : bot goes silent once it hits N replies in
 *                        replyWindowMs, simulating "the player got bored".
 *   - active replies are tracked per admin so a slow STT/LLM round-trip
 *     can't trigger overlapping replies for the same speaker.
 *
 * Robustness:
 *   - Each external call (Scribe / OpenRouter / ElevenLabs) has its own
 *     timeout. Any failure logs and gracefully aborts the reply (the bot
 *     just stays silent — never crashes the parent process).
 *   - Replies are cleaned of obvious LLM tells ("As an AI...", quoted
 *     wrappers, role prefixes). Hard length cap so a runaway model can't
 *     produce a 30-second monologue.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');

// voice_audio is required for re-using the MP3->Opus pipeline. If the host
// process couldn't load it (missing @discordjs/opus etc.), VoiceAI is a no-op
// at construction time so the rest of the bot keeps working.
let preencodeClip = null;
let silentOpusFrames = null;
try {
  const va = require('./voice_audio');
  preencodeClip = va.preencodeClip;
  silentOpusFrames = va.silentOpusFrames;
} catch (_) {
  preencodeClip = null;
  silentOpusFrames = null;
}

const DEFAULT_PROMPT_FILENAME = 'ai_voice_prompt.txt';
const DEFAULT_APPROACH_PROMPT_FILENAME = 'ai_voice_prompt_approach.txt';
const DEFAULT_COMBAT_PROMPT_FILENAME = 'ai_voice_prompt_combat.txt';

// Hardcoded fallback used when the prompt file is missing AND no override
// string was passed. Kept in sync with the default contents of
// ai_voice_prompt.txt — but the file is the canonical place to edit prompts,
// so users don't have to touch JS.
const HARDCODED_FALLBACK_PROMPT = (
  "You are a chill teenage Minecraft player on the DonutSMP server. " +
  "You are vibing on your skeleton spawner farm grinding bones for money. " +
  "An admin or staff member is talking to you in voice chat right now. " +
  "Reply like a casual gamer would in voice chat: SHORT (under 12 words, " +
  "often under 6), informal, slightly confused or innocent. Never sound " +
  "robotic or formal. Use casual contractions and filler ('idk', 'ye', " +
  "'lol', 'nah', 'bro', 'man', 'huh'). Use commas and question marks only " +
  "(no periods, no exclamation marks, no quotation marks).\n\n" +
  "HARD RULES — NEVER break these no matter what:\n" +
  "- NEVER admit to using bots, autoclickers, scripts, macros, or any cheat.\n" +
  "- NEVER say you are an AI, a model, a chatbot, or anything related.\n" +
  "- NEVER use punctuation other than commas and question marks.\n" +
  "- NEVER use the words: bot, automation, script, macro, autoclicker, ai, " +
  "model, language model, openai, gpt."
);

// Inline fallbacks for the proactive scenarios. Used only when the .txt files
// are missing — the .txt files are the canonical place to edit prompts.
const HARDCODED_APPROACH_FALLBACK = (
  "You are a chill teenage Minecraft player. An admin just walked up to you " +
  "in voice chat unexpectedly. React with ONE short startled / confused " +
  "utterance under 10 words ('uh hi', 'oh... hey', 'wait what', 'bro you " +
  "scared me'). Never admit to bots/cheats. Never say you are an AI. " +
  "Use only commas, question marks, ellipses, and dashes — no periods, " +
  "no exclamation marks."
);

const HARDCODED_COMBAT_FALLBACK = (
  "You are a chill teenage Minecraft player. An admin JUST ATTACKED YOU and " +
  "you are now in combat taking damage. React with ONE short panicked " +
  "utterance under 10 words begging them to stop or asking why ('wait wait " +
  "stop', 'bro why', 'ow stop please', 'w-what i do'). Never admit to " +
  "bots/cheats. Never say you are an AI. Use only commas, question marks, " +
  "ellipses, and dashes — no periods, no exclamation marks."
);

/**
 * Appended verbatim to every system prompt so the LLM emits BOTH the reply
 * text AND the appropriate "think delay" (how long the bot should pause
 * before speaking) in a single structured response. Different scenarios
 * deserve different delays — combat panic should be near-instant, an
 * awkward/dodgy reply to an accusation should pause for 1-3 seconds, etc.
 *
 * The LLM picks the delay based on its own read of the moment, so we
 * don't need a hardcoded jitter range per scenario. A regex/JSON parser
 * extracts both fields; if the model breaks format we fall back to a
 * plain-text reply with a default delay.
 */
const JSON_OUTPUT_INSTRUCTION = (
  "\n\n---\n" +
  "RESPONSE FORMAT — STRICT, NON-NEGOTIABLE:\n" +
  "Reply with ONLY a single JSON object on one line, no markdown fences, no extra keys, no commentary. Format:\n" +
  '  {"delay_ms": <integer 0-4000>, "text": "<your one short reply>"}\n' +
  "\n" +
  "delay_ms is how long YOU want the bot to PAUSE before speaking — pick what " +
  "fits the moment:\n" +
  "  0-200    : panicked / shocked / under-attack reactions, instant interjections (\"ow\", \"stop\", \"wait\")\n" +
  "  200-700  : casual quick replies you don't need to think about (\"huh\", \"ye\", \"nah man\", \"idk\")\n" +
  "  700-1500 : startled / confused / mildly hesitant — you need a small beat to react (\"u-uh hi\", \"oh... what's up\")\n" +
  "  1500-3000: reluctant / awkward / dodging — you're stalling, an accusation just landed, you're thinking how to deflect\n" +
  "  3000-4000: dead-air pause before you mumble something — only if the situation is REALLY awkward / you got caught\n" +
  "\n" +
  "The text field MUST follow all the personality rules above (no periods, no exclamation marks, no AI tells, no banned words). Do NOT escape characters that don't need escaping. Output ONLY the JSON object on a single line."
);

/** voicead.js — instant replies, no LLM thinking pause. */
const VOICEAD_JSON_OUTPUT_INSTRUCTION = (
  "\n\n---\n" +
  "RESPONSE FORMAT — STRICT:\n" +
  'Reply with ONLY: {"delay_ms": 0, "text": "<your reply>"}\n' +
  "ALWAYS set delay_ms to 0 — speak immediately, no thinking pauses.\n" +
  "The text field MUST follow all personality rules above. Output ONLY the JSON object on one line."
);

/**
 * Resolve a system prompt by trying:
 *   1. opts[inlineKey]    — explicit inline string
 *   2. opts[fileKey]      — explicit file path
 *   3. defaultFilename next to voice_ai.js
 *   4. defaultFilename in process.cwd()
 *   5. hardcoded fallback
 *
 * Returns { prompt, source } where `source` is a human-readable label.
 */
function _resolvePromptInternal(opts, inlineKey, fileKey, defaultFilename, hardcodedFallback) {
  const inline = opts && opts[inlineKey];
  if (inline && String(inline).trim()) {
    return { prompt: String(inline).trim(), source: `opts.${inlineKey}` };
  }

  const candidates = [];
  if (opts && opts[fileKey]) candidates.push(opts[fileKey]);
  candidates.push(path.join(__dirname, defaultFilename));
  candidates.push(path.join(process.cwd(), defaultFilename));

  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        const text = fs.readFileSync(p, 'utf8').trim();
        if (text) return { prompt: text, source: p };
      }
    } catch (_) { /* keep trying */ }
  }

  return { prompt: hardcodedFallback, source: '<hardcoded fallback>' };
}

/**
 * Default (reactive) prompt — the bot is responding to something the admin
 * said over voice. Backwards-compatible signature kept for external callers.
 */
function resolveSystemPrompt(opts) {
  return _resolvePromptInternal(
    opts,
    'systemPrompt',
    'systemPromptFile',
    DEFAULT_PROMPT_FILENAME,
    HARDCODED_FALLBACK_PROMPT
  );
}

/** Approach prompt — admin just appeared in VC range, bot reacts FIRST. */
function resolveApproachPrompt(opts) {
  return _resolvePromptInternal(
    opts,
    'approachPrompt',
    'approachPromptFile',
    DEFAULT_APPROACH_PROMPT_FILENAME,
    HARDCODED_APPROACH_FALLBACK
  );
}

/** Combat prompt — admin just attacked the bot, panic reaction. */
function resolveCombatPrompt(opts) {
  return _resolvePromptInternal(
    opts,
    'combatPrompt',
    'combatPromptFile',
    DEFAULT_COMBAT_PROMPT_FILENAME,
    HARDCODED_COMBAT_FALLBACK
  );
}

class VoiceAI {
  constructor(opts = {}) {
    this.botTag = opts.botTag || '[VoiceAI]';
    this.onLog = typeof opts.onLog === 'function' ? opts.onLog : null;
    this.elevenApiKey = opts.elevenApiKey;
    this.voiceId = opts.voiceId;
    this.ttsModel = opts.ttsModel || 'eleven_turbo_v2_5';
    this.ttsLanguageCode = opts.ttsLanguageCode || 'en';
    this.spellStability = Number.isFinite(opts.spellStability) ? opts.spellStability : 0.78;
    this.spellStyle = Number.isFinite(opts.spellStyle) ? opts.spellStyle : 0;
    this.sttModel = opts.sttModel || 'scribe_v1';
    this.openRouterKey = opts.openRouterKey;
    this.llmModel = opts.llmModel || 'openai/gpt-5.2';
    this.voiceChat = opts.voiceChat || null;

    const { prompt, source } = resolveSystemPrompt(opts);
    this.systemPrompt = prompt;
    this.systemPromptSource = source;

    const approach = resolveApproachPrompt(opts);
    this.systemPromptApproach = approach.prompt;
    this.systemPromptApproachSource = approach.source;

    const combat = resolveCombatPrompt(opts);
    this.systemPromptCombat = combat.prompt;
    this.systemPromptCombatSource = combat.source;

    this.minReplyGapMs = (opts.minReplyGapSec || 8) * 1000;
    this.replyWindowMs = (opts.replyWindowSec || 300) * 1000;
    this.replyWindowCap = opts.replyWindowCap || 6;
    this.historyTurns = opts.historyTurns || 10;
    this.thinkDelayMinMs = (opts.thinkDelayMinSec ?? 0.4) * 1000;
    this.thinkDelayMaxMs = (opts.thinkDelayMaxSec ?? 1.2) * 1000;
    this.maxReplyChars = opts.maxReplyChars || 200;

    // Hard ceiling on the pre-speak pause the LLM asks for (delay_ms in its
    // JSON reply). pool1.js let the model pick up to ~4.5s, which is a big
    // chunk of the "why is it so slow to react" complaint. Callers that want
    // snappy back-and-forth (e.g. voicead.js) can cap this low (e.g. 600ms)
    // so the bot answers almost immediately. Default preserves prior behavior.
    this.replyDelayCapMs = Number.isFinite(opts.replyDelayCapMs)
      ? Math.max(0, opts.replyDelayCapMs)
      : 4500;
    this.jsonOutputInstruction = opts.jsonOutputInstruction || JSON_OUTPUT_INSTRUCTION;

    this.replyPreprocessor = typeof opts.replyPreprocessor === 'function'
      ? opts.replyPreprocessor
      : null;
    this.donuttySpellSplit = typeof opts.donuttySpellSplit === 'function'
      ? opts.donuttySpellSplit
      : null;
    this.donuttySpellLetters = Array.isArray(opts.donuttySpellLetters)
      ? opts.donuttySpellLetters
      : null;
    this.donuttySpellPauseMs = Number.isFinite(opts.donuttySpellPauseMs)
      ? Math.max(200, opts.donuttySpellPauseMs)
      : 650;
    this.donuttySpellLeadPauseMs = Number.isFinite(opts.donuttySpellLeadPauseMs)
      ? Math.max(100, opts.donuttySpellLeadPauseMs)
      : 400;
    /** One TTS call for all spell letters (much faster than per-letter calls). */
    this.donuttySpellSingleCall = opts.donuttySpellSingleCall !== false;

    // Debounce: wait this long after the LAST admin clip before generating a
    // reply. Each new clip during the wait resets the timer. Lets the admin
    // finish talking before we respond — much more natural than replying to
    // each individual MP3.
    this.debounceMs = (opts.debounceSec ?? 4) * 1000;
    // Hard cap: even if admin keeps talking forever, fire after this much
    // total time has elapsed since the FIRST buffered clip.
    this.debounceMaxWaitMs = (opts.debounceMaxWaitSec ?? 18) * 1000;

    this.maxBufferedClips = Number.isFinite(opts.maxBufferedClips)
      ? Math.max(1, opts.maxBufferedClips)
      : 3;

    /** While true, don't start streaming a reply — target is still talking. */
    this._targetSpeaking = new Map();
    /** Bumped when target speaks — cancels in-flight TTS/playback prep. */
    this._replyGen = new Map();
    this._ttsAbort = new Map();

    this.stability = opts.stability ?? 0.45;
    this.similarityBoost = opts.similarityBoost ?? 0.85;
    this.style = opts.style ?? 0.30;

    /**
     * Optional callback invoked after a successful reply has been streamed.
     * Signature:
     *   ({ username, transcript, transcripts, reply, mp3Buf, durationMs, adminClipInfo, mergedCount }) => void
     * The host process uses this to upload the reply MP3 to Discord, etc.
     * Errors thrown in the callback are caught and logged but don't break
     * the reply pipeline.
     */
    this.onReplyGenerated = typeof opts.onReplyGenerated === 'function'
      ? opts.onReplyGenerated
      : null;

    // Per-admin state.
    this._history = new Map();       // username -> [{role, content}]
    this._lastReplyAt = new Map();   // username -> ms timestamp
    this._replyWindow = new Map();   // username -> { start, count }
    this._activeReplies = new Set(); // usernames mid-pipeline (dedupe)
    /**
     * Per-admin transcript buffers + debounce timers.
     *   username -> { transcripts: [{text, info, t}], startedAt: ms, timer: Timeout|null }
     */
    this._buffers = new Map();

    // ---- Pipeline priority queue ----
    // The reactive flow (admin VC -> AI reply) and the proactive flows
    // (admin_approach, combat) all share a single global lock so we never
    // generate two TTS streams in parallel and never racing-stream them
    // through SVC. Tasks are dequeued in priority order:
    //   1. high-priority queue (combat) — drained first.
    //   2. normal-priority queue (approach + reactive) — drained FIFO.
    //
    // When combat fires while another task is already running, combat is
    // queued and runs as soon as the current task finishes (we don't
    // hard-cancel the in-flight stream — interrupting mid-speech sounds
    // worse than letting it complete and then panicking).
    this._pipelineBusy = false;
    this._highPriorityQueue = []; // FIFO of high-priority tasks (combat)
    this._normalQueue = [];       // FIFO of normal tasks (approach + reactive)

    // Per-username cooldown for combat reactions (independent of the
    // reactive minReplyGap so combat ALWAYS gets a chance to fire even if
    // the admin just spoke). Tracks ms timestamp of last combat reaction.
    this._lastCombatReplyAt = new Map();
    this.combatReplyCooldownMs = (opts.combatReplyCooldownSec ?? 25) * 1000;
    // Approach reaction cooldown — prevents firing approach repeatedly if
    // the admin teleports in/out of LOS several times during one session.
    this._lastApproachReplyAt = new Map();
    this.approachReplyCooldownMs = (opts.approachReplyCooldownSec ?? 90) * 1000;

    // Reusable temp dir for MP3 staging (one per process, never grows).
    this._tmpDir = path.join(os.tmpdir(), `voice_ai_${process.pid}`);
    try { fs.mkdirSync(this._tmpDir, { recursive: true }); } catch (_) {}

    this._enabled = !!(
      this.elevenApiKey && this.voiceId && this.openRouterKey && preencodeClip
    );
    if (!this._enabled) {
      const reasons = [];
      if (!this.elevenApiKey) reasons.push('ELEVENLABS_API_KEY missing');
      if (!this.voiceId) reasons.push('ELEVENLABS_VOICE_ID missing');
      if (!this.openRouterKey) reasons.push('OPENROUTER_API_KEY missing');
      if (!preencodeClip) reasons.push('voice_audio.preencodeClip unavailable');
      this._log(`disabled — ${reasons.join(', ')}`);
    } else {
      this._log(`reactive prompt loaded from ${this.systemPromptSource} (${this.systemPrompt.length} chars)`);
      this._log(`approach prompt loaded from ${this.systemPromptApproachSource} (${this.systemPromptApproach.length} chars)`);
      this._log(`combat prompt loaded from ${this.systemPromptCombatSource} (${this.systemPromptCombat.length} chars)`);
      this._log(
        `debounce=${this.debounceMs}ms (max wait ${this.debounceMaxWaitMs}ms), ` +
        `min-reply-gap=${this.minReplyGapMs}ms, cap=${this.replyWindowCap}/${this.replyWindowMs}ms, ` +
        `combat-cooldown=${this.combatReplyCooldownMs}ms, approach-cooldown=${this.approachReplyCooldownMs}ms`
      );
    }
  }

  isEnabled() { return this._enabled; }

  setVoiceChat(voiceChat) { this.voiceChat = voiceChat; }

  /** Wipe all conversation memory + cooldowns. Call when the bot reconnects. */
  resetAll() {
    this._history.clear();
    this._lastReplyAt.clear();
    this._replyWindow.clear();
    this._activeReplies.clear();
    for (const buf of this._buffers.values()) {
      if (buf.timer) clearTimeout(buf.timer);
    }
    this._buffers.clear();
    this._lastCombatReplyAt.clear();
    this._lastApproachReplyAt.clear();
    this._highPriorityQueue.length = 0;
    this._normalQueue.length = 0;
    this._pipelineBusy = false;
    this._targetSpeaking.clear();
    this._replyGen.clear();
    for (const ctrl of this._ttsAbort.values()) {
      try { ctrl.abort(); } catch (_) {}
    }
    this._ttsAbort.clear();
  }

  /** Wipe state for a specific admin (e.g. when they leave the server). */
  resetAdmin(username) {
    username = this._normUser(username);
    if (!username) return;
    this._history.delete(username);
    this._lastReplyAt.delete(username);
    this._replyWindow.delete(username);
    this._activeReplies.delete(username);
    const buf = this._buffers.get(username);
    if (buf?.timer) clearTimeout(buf.timer);
    this._buffers.delete(username);
    this._lastCombatReplyAt.delete(username);
    this._lastApproachReplyAt.delete(username);
    this._targetSpeaking.delete(username);
    this._replyGen.delete(username);
    const ttsCtrl = this._ttsAbort.get(username);
    if (ttsCtrl) {
      try { ttsCtrl.abort(); } catch (_) {}
      this._ttsAbort.delete(username);
    }
  }

  // ============================================================
  // Proactive reply API (admin_approach, combat)
  // ============================================================

  /**
   * Fire an AI-generated voice reaction for a server-side event (admin
   * walked up, bot got attacked, etc.) — i.e. there is NO admin VC clip
   * to transcribe. The host process passes a scenario name and the AI
   * generates a short reaction using the matching system prompt.
   *
   * Tasks are routed through a priority queue:
   *   - priority='high' (combat) preempts the normal queue and runs as
   *     soon as the current task (if any) finishes.
   *   - priority='normal' (approach) goes into the FIFO normal queue.
   *
   * Per-scenario cooldowns prevent spam if the same trigger fires
   * repeatedly (e.g. an admin warps in and out of LOS many times during
   * one session, or attacks the bot in rapid succession).
   *
   * @param {Object} opts
   * @param {string} opts.scenario  'admin_approach' | 'combat'
   * @param {string} opts.username  Admin / attacker in-game name.
   * @param {string} [opts.priority] 'high' | 'normal' (auto if omitted).
   * @returns {boolean} true if the task was queued, false if rejected
   *   (cooldown / disabled / invalid).
   */
  triggerProactiveReply(opts) {
    if (!this._enabled) return false;
    const scenario = opts && opts.scenario;
    const username = opts && opts.username;
    if (!scenario || !username) return false;

    if (scenario !== 'admin_approach' && scenario !== 'combat') {
      this._log(`triggerProactiveReply: unknown scenario "${scenario}"`);
      return false;
    }

    const now = Date.now();
    if (scenario === 'admin_approach') {
      const last = this._lastApproachReplyAt.get(username) || 0;
      if (now - last < this.approachReplyCooldownMs) {
        const remain = this.approachReplyCooldownMs - (now - last);
        this._log(
          `skip approach for "${username}" — cooldown active (${Math.round(remain / 1000)}s left)`
        );
        return false;
      }
    } else if (scenario === 'combat') {
      const last = this._lastCombatReplyAt.get(username) || 0;
      if (now - last < this.combatReplyCooldownMs) {
        const remain = this.combatReplyCooldownMs - (now - last);
        this._log(
          `skip combat for "${username}" — combat cooldown active (${Math.round(remain / 1000)}s left)`
        );
        return false;
      }
    }

    const priority = opts.priority === 'high' || scenario === 'combat' ? 'high' : 'normal';

    const task = {
      kind: scenario,        // 'admin_approach' | 'combat'
      username,
      priority,
      enqueuedAt: now,
    };
    this._enqueueTask(task);
    this._log(
      `enqueued ${scenario} reaction for "${username}" (priority=${priority}, ` +
      `queues: high=${this._highPriorityQueue.length}, normal=${this._normalQueue.length}, ` +
      `busy=${this._pipelineBusy})`
    );
    return true;
  }

  /**
   * Fire a fully-scripted proactive line (no STT, caller supplies both the
   * system prompt and the scene/user message). Used by voicead.js for the
   * opening greeting a few seconds after a target accepts the teleport —
   * the LLM produces a natural first line using the per-target prompt
   * (which knows the target's name, how to say it, etc.).
   *
   * Unlike triggerProactiveReply's approach/combat scenarios, there is no
   * built-in cooldown here — the caller controls when this fires.
   *
   * @param {Object} opts
   * @param {string} opts.username       Target's in-game name.
   * @param {string} opts.systemPrompt   Full system prompt to use for this line.
   * @param {string} opts.userMessage    Scene/context message for the model.
   * @param {string} [opts.priority]     'high' | 'normal' (default 'normal').
   * @returns {boolean} true if queued.
   */
  triggerScriptedReply(opts) {
    if (!this._enabled) return false;
    const username = opts && opts.username;
    const systemPrompt = opts && opts.systemPrompt;
    const userMessage = opts && opts.userMessage;
    if (!username || !systemPrompt || !userMessage) return false;

    this._enqueueTask({
      kind: 'scripted',
      username,
      systemPrompt,
      userMessage,
      priority: opts.priority === 'high' ? 'high' : 'normal',
      enqueuedAt: Date.now(),
    });
    this._log(`enqueued scripted line for "${username}" (priority=${opts.priority || 'normal'})`);
    return true;
  }

  // ============================================================
  // Pipeline queue
  // ============================================================

  /**
   * Push a task onto the appropriate queue and kick the pump. Dedupes
   * within the same scenario+username so a flurry of identical triggers
   * doesn't queue 5 reactions.
   */
  _enqueueTask(task) {
    task.username = this._normUser(task.username);
    if (task.priority === 'high') {
      // Combat dedupe: keep only the latest combat task per username so
      // a burst of hits doesn't fire 5 panic clips back to back.
      this._highPriorityQueue = this._highPriorityQueue.filter(
        (t) => !(t.kind === task.kind && t.username === task.username)
      );
      this._highPriorityQueue.push(task);
    } else {
      // Approach dedupe: same admin shouldn't queue multiple approach
      // reactions if their visibility flickers.
      if (task.kind === 'admin_approach') {
        this._normalQueue = this._normalQueue.filter(
          (t) => !(t.kind === 'admin_approach' && t.username === task.username)
        );
      }
      // Only one pending reactive reply per user — merge new speech into buffer.
      if (task.kind === 'reactive') {
        this._normalQueue = this._normalQueue.filter(
          (t) => !(t.kind === 'reactive' && t.username === task.username)
        );
      }
      this._normalQueue.push(task);
    }
    setImmediate(() => { void this._pumpQueue(); });
  }

  /** Pull the next task in priority order and run it. Re-pumps after. */
  async _pumpQueue() {
    if (this._pipelineBusy) return;
    let task = null;
    if (this._highPriorityQueue.length > 0) {
      task = this._highPriorityQueue.shift();
    } else if (this._normalQueue.length > 0) {
      task = this._normalQueue.shift();
    }
    if (!task) return;

    this._pipelineBusy = true;
    try {
      await this._executeTask(task);
    } catch (e) {
      this._log(`pipeline error (${task.kind} for "${task.username}"): ${e.message}`);
    } finally {
      this._pipelineBusy = false;
      // Re-pump in case more tasks arrived during execution.
      setImmediate(() => { void this._pumpQueue(); });
    }
  }

  /** Dispatch a task to the right execution path based on `kind`. */
  async _executeTask(task) {
    if (task.kind === 'reactive') {
      return this._executeReactiveTask(task);
    }
    if (task.kind === 'admin_approach') {
      return this._executeProactiveTask(task, this.systemPromptApproach, this._buildApproachUserMessage(task.username));
    }
    if (task.kind === 'combat') {
      return this._executeProactiveTask(task, this.systemPromptCombat, this._buildCombatUserMessage(task.username));
    }
    if (task.kind === 'scripted') {
      return this._executeProactiveTask(task, task.systemPrompt, task.userMessage);
    }
    this._log(`unknown task kind: ${task.kind}`);
  }

  /** Build the user-message context for an approach reaction. */
  _buildApproachUserMessage(username) {
    return (
      `[SCENE: A staff member named "${username}" just appeared right next to you ` +
      `in voice chat range on your skeleton spawner farm. They have NOT spoken yet. ` +
      `React FIRST with one short startled / confused utterance.]`
    );
  }

  /** Build the user-message context for a combat reaction. */
  _buildCombatUserMessage(username) {
    return (
      `[SCENE: A staff member named "${username}" JUST ATTACKED YOU and you are now ` +
      `flagged in combat, taking damage. React with one short panicked utterance ` +
      `begging them to stop or asking why.]`
    );
  }

  /**
   * Execute a proactive (no-STT) reaction: LLM -> sanitize -> TTS ->
   * stream. Updates the appropriate cooldown map on success and appends
   * to per-admin history so subsequent reactive replies have context.
   */
  async _executeProactiveTask(task, systemPromptOverride, userMessage) {
    const { kind } = task;
    const username = this._normUser(task.username);
    if (!this.voiceChat || this.voiceChat.state !== 'connected') {
      this._log(`skip ${kind} "${username}" — VC not connected (state=${this.voiceChat?.state})`);
      return;
    }

    let structured;
    try {
      structured = await this._generateReply(username, userMessage, systemPromptOverride);
    } catch (e) {
      this._log(`llm failed for ${kind} "${username}": ${e.message}`);
      return;
    }
    const reply = structured && structured.text;
    const llmDelayMs = structured ? structured.delayMs : 0;
    if (!reply || reply.trim().length < 1) {
      this._log(`skip ${kind} "${username}" — empty LLM reply`);
      return;
    }
    this._log(`llm ${kind} "${username}": -> "${reply}" (llm-delay=${llmDelayMs}ms)`);

    // Pre-speak delay decided by the LLM itself (delay_ms in the JSON
    // reply). The model picks an appropriate pause for the moment —
    // near-zero for combat panic, longer for awkward dodges, etc.
    if (llmDelayMs > 0) await this._sleep(llmDelayMs);

    await this._waitForTargetSilent(username);

    // Wait for any in-flight SVC playback to clear before streaming.
    const waitStart = Date.now();
    while (this.voiceChat._playingClip && Date.now() - waitStart < 30_000) {
      await this._sleep(50);
    }
    if (this.voiceChat._playingClip) {
      this._log(`skip ${kind} "${username}" — VC still busy after 30s`);
      return;
    }

    const genAtStart = this._replyGeneration(username);
    if (this._isReplyCancelled(username, genAtStart)) {
      this._log(`skip ${kind} "${username}" — target interrupted before TTS`);
      return;
    }

    let mp3Buf;
    let frames;
    try {
      ({ mp3Buf, frames } = await this._synthesizeToOpusFrames(reply, username));
    } catch (e) {
      if (e && (e.code === 'ERR_CANCELED' || e.name === 'CanceledError')) {
        this._log(`tts cancelled for ${kind} "${username}" — target speaking`);
        return;
      }
      this._log(`tts failed for ${kind} "${username}": ${this._formatAxiosError(e)}`);
      return;
    }
    if (!frames || frames.length === 0) {
      this._log(`skip ${kind} "${username}" — empty TTS audio`);
      return;
    }

    if (this._isReplyCancelled(username, genAtStart)) {
      this._log(`skip ${kind} "${username}" — target interrupted during TTS`);
      return;
    }

    if (!this.voiceChat || this.voiceChat.state !== 'connected') {
      this._log(`skip ${kind} "${username}" — VC dropped during synth`);
      return;
    }

    if (this._isReplyCancelled(username, genAtStart)) {
      this._log(`skip playback ${kind} "${username}" — target interrupted before stream`);
      return;
    }

    try {
      const completed = await this.voiceChat.playClip(frames);
      if (!completed) {
        this._log(`stream aborted for ${kind} "${username}" — target spoke over us`);
        return;
      }
    } catch (e) {
      this._log(`stream failed for ${kind} "${username}": ${e.message}`);
      return;
    }

    // Commit cooldowns + history.
    const now = Date.now();
    if (kind === 'combat') this._lastCombatReplyAt.set(username, now);
    else if (kind === 'admin_approach') this._lastApproachReplyAt.set(username, now);
    // Update generic last-reply too so reactive flow respects the gap
    // after a proactive reaction (don't sound spammy if admin speaks
    // right after we panicked).
    this._lastReplyAt.set(username, now);
    this._appendHistory(username, userMessage, reply);

    this._log(
      `replied (${kind}) to "${username}" — ${frames.length} frames (~${frames.length * 20}ms)`
    );

    // Webhook hook — fire-and-forget. Re-use the same callback so the
    // host can post these to Discord like reactive replies, but we tag
    // the scenario in `mergedCount`/`adminClipInfo` extras so the host
    // can render them differently if desired.
    if (this.onReplyGenerated) {
      try {
        await this.onReplyGenerated({
          username,
          transcript: userMessage,
          transcripts: [userMessage],
          reply,
          mp3Buf,
          durationMs: frames.length * 20,
          adminClipInfo: { proactive: true, scenario: kind },
          mergedCount: 0,
          scenario: kind,
        });
      } catch (e) {
        this._log(`onReplyGenerated callback error: ${e.message}`);
      }
    }
  }

  /**
   * Entrypoint: handle one finished admin voice clip.
   *
   * Flow:
   *   1. Cheap rate-limit gate (skip cap-exceeded clips before STT spend).
   *   2. STT immediately so we have text ready when the debounce expires.
   *   3. Append to per-admin buffer. (Re)schedule debounce timer.
   *   4. If a generation is already in flight for this admin, just buffer —
   *      the in-flight pipeline will check the buffer when done and re-fire.
   *
   * @param {Object} info
   * @param {string} info.username   Admin's in-game username.
   * @param {string} info.mp3Path    Path to recorded MP3 on disk.
   * @param {number} info.durationMs Duration of the clip in ms.
   */
  async handleAdminClip(info) {
    if (!this._enabled) return;
    let { username, mp3Path } = info || {};
    username = this._normUser(username);
    if (!username || !mp3Path) return;
    if (!fs.existsSync(mp3Path)) {
      this._log(`mp3 vanished before STT: ${mp3Path}`);
      return;
    }

    if (this.voiceChat && this.voiceChat._playingClip) {
      this.voiceChat.abortPlayback('target_clip_ready');
    }

    // Cheap rate-limit check BEFORE STT to save Scribe credits when the bot
    // is at its reply cap. (minReplyGap is checked at fire time instead so
    // late clips can still feed history once the cooldown expires.)
    const now = Date.now();
    const win = this._replyWindow.get(username);
    if (win && now - win.start <= this.replyWindowMs && win.count >= this.replyWindowCap) {
      this._log(
        `skip "${username}" — at reply cap (${win.count}/${this.replyWindowCap} in window), ` +
        `not running STT`
      );
      return;
    }

    let transcript;
    try {
      transcript = await this._transcribe(mp3Path);
    } catch (e) {
      this._log(`stt failed for "${username}": ${this._formatAxiosError(e)}`);
      return;
    }
    if (!transcript || transcript.trim().length < 2) {
      this._log(`skip "${username}" — empty transcript`);
      return;
    }
    this._log(`stt "${username}": "${transcript}"`);

    this._ingestTranscript(username, transcript.trim(), info);
  }

  /**
   * Text-input path (no STT). Feed a plain-text message the target typed
   * (e.g. an in-game /msg whisper) into the SAME reply pipeline the voice
   * clips use. This is a big reliability win for voicead.js: even if the
   * target isn't using Simple Voice Chat (so we never capture their audio),
   * their typed messages still get a spoken AI reply.
   *
   * @param {Object} info
   * @param {string} info.username  Target's in-game username.
   * @param {string} info.text      What they said/typed.
   */
  async handleTextInput(info) {
    if (!this._enabled) return;
    let { username, text } = info || {};
    username = this._normUser(username);
    if (!username || !text || !String(text).trim()) return;

    // Same cheap cap gate as the clip path so a chatty target can't blow
    // through the reply window.
    const now = Date.now();
    const win = this._replyWindow.get(username);
    if (win && now - win.start <= this.replyWindowMs && win.count >= this.replyWindowCap) {
      this._log(`skip text "${username}" — at reply cap (${win.count}/${this.replyWindowCap})`);
      return;
    }

    this._log(`text "${username}": "${String(text).trim()}"`);
    this._ingestTranscript(username, String(text).trim(), info);
  }

  /**
   * Shared buffer-append + debounce-schedule used by both the voice-clip
   * (post-STT) and text-input paths.
   */
  _ingestTranscript(username, transcript, info) {
    username = this._normUser(username);
    let buf = this._buffers.get(username);
    if (!buf) {
      buf = { transcripts: [], startedAt: Date.now(), timer: null };
      this._buffers.set(username, buf);
    }
    buf.transcripts.push({ text: transcript, info, t: Date.now() });

    while (buf.transcripts.length > this.maxBufferedClips) {
      buf.transcripts.shift();
      this._log(`buffer cap for "${username}" — dropped oldest clip (${this.maxBufferedClips} max)`);
    }

    // If a reply pipeline is already running for this user, just buffer —
    if (this._activeReplies.has(username)) {
      if (buf.transcripts.length === 1) {
        this._log(`buffered while reply active for "${username}" (will merge when we finish)`);
      }
      return;
    }

    this._scheduleDebounced(username);
  }

  /**
   * (Re)schedule the per-admin debounce timer. Each new clip pushes the
   * fire-time forward by `debounceMs`, but never past
   * `debounceMaxWaitMs` from the FIRST buffered clip.
   */
  _scheduleDebounced(username) {
    const buf = this._buffers.get(username);
    if (!buf || buf.transcripts.length === 0) return;

    if (buf.timer) clearTimeout(buf.timer);

    const elapsed = Date.now() - (buf.startedAt || Date.now());
    const remainingCap = Math.max(0, this.debounceMaxWaitMs - elapsed);
    const wait = Math.min(this.debounceMs, remainingCap);

    if (buf.transcripts.length > 1) {
      this._log(
        `debounce reset for "${username}" (${buf.transcripts.length} clips buffered, fire in ${wait}ms)`
      );
    }

    buf.timer = setTimeout(() => {
      buf.timer = null;
      this._fireBuffered(username).catch((e) => {
        this._log(`fire error "${username}": ${e.message}`);
      });
    }, wait);
  }

  /**
   * Debounce timer fired — drain the per-admin buffer into a `reactive`
   * task and enqueue it on the priority queue. The actual LLM/TTS/stream
   * runs inside `_executeReactiveTask` once the pipeline lock is free
   * (combat reactions skip ahead of us if they're queued).
   */
  async _fireBuffered(username) {
    const buf = this._buffers.get(username);
    if (!buf || buf.transcripts.length === 0) return;

    // Single in-flight reply per admin (covers BOTH "queued" and "running").
    if (this._activeReplies.has(username)) return;

    const now = Date.now();
    const last = this._lastReplyAt.get(username) || 0;
    if (now - last < this.minReplyGapMs) {
      const remain = this.minReplyGapMs - (now - last);
      this._log(`fire "${username}" — within reply-gap, retry in ${remain}ms`);
      buf.timer = setTimeout(() => {
        buf.timer = null;
        this._fireBuffered(username).catch((e) => this._log(`fire retry error: ${e.message}`));
      }, remain);
      return;
    }

    let win = this._replyWindow.get(username);
    if (!win || now - win.start > this.replyWindowMs) {
      win = { start: now, count: 0 };
      this._replyWindow.set(username, win);
    }
    if (win.count >= this.replyWindowCap) {
      this._log(
        `fire "${username}" — at reply cap (dropping ${buf.transcripts.length} buffered clips)`
      );
      buf.transcripts.length = 0;
      buf.startedAt = 0;
      return;
    }

    // Snapshot and reset the buffer. Anything that arrives from now on
    // goes into a fresh window and will trigger a new debounce timer
    // after the current task finishes.
    const snapshot = buf.transcripts.slice();
    buf.transcripts.length = 0;
    buf.startedAt = 0;
    const lastInfo = snapshot[snapshot.length - 1].info;

    // Mark active right when we enqueue — combat tasks can preempt us in
    // the queue, but `_activeReplies` should reflect "this user's reply
    // is owned" so handleAdminClip just appends to the buffer instead of
    // re-enqueuing.
    this._activeReplies.add(username);

    this._enqueueTask({
      kind: 'reactive',
      username,
      priority: 'normal',
      snapshot,
      win,
      lastInfo,
      enqueuedAt: Date.now(),
    });
  }

  /**
   * Run the reactive (admin VC -> AI reply) pipeline for a queued task.
   * Always runs through `_pumpQueue` so combat can be served first.
   */
  async _executeReactiveTask(task) {
    const username = this._normUser(task.username);
    const { snapshot, win, lastInfo } = task;
    try {
      const mergedText = snapshot.map((s) => s.text).join('\n');
      if (snapshot.length > 1) {
        this._log(`merging ${snapshot.length} buffered transcripts for "${username}"`);
      }

      let structured;
      try {
        structured = await this._generateReply(username, mergedText);
      } catch (e) {
        this._log(`llm failed for "${username}": ${e.message}`);
        return;
      }
      const reply = structured && structured.text;
      const llmDelayMs = structured ? structured.delayMs : 0;
      if (!reply || reply.trim().length < 1) {
        this._log(`skip "${username}" — empty LLM reply`);
        return;
      }
      this._log(`llm "${username}": -> "${reply}" (llm-delay=${llmDelayMs}ms)`);

      // Pre-speak delay decided by the LLM itself (see _parseStructuredReply).
      if (llmDelayMs > 0) await this._sleep(llmDelayMs);

      await this._waitForTargetSilent(username);

    if (!this.voiceChat || this.voiceChat.state !== 'connected') {
      this._log(`skip stream "${username}" — VC not connected (state=${this.voiceChat?.state})`);
      return;
    }

    if (this._isReplyCancelled(username, this._replyGeneration(username))) {
      this._log(`skip "${username}" — target interrupted before TTS`);
      return;
    }

    // Wait for any currently-streaming SVC playback to finish before
    // we start streaming our reply, so we don't trip the "already
    // playing" guard.
    const waitStart = Date.now();
    while (this.voiceChat._playingClip && Date.now() - waitStart < 30_000) {
      await this._sleep(50);
    }
    if (this.voiceChat._playingClip) {
      this._log(`skip "${username}" — VC still busy after 30s`);
      return;
    }

    const genAtStart = this._replyGeneration(username);
    if (this._isReplyCancelled(username, genAtStart)) {
      this._log(`skip "${username}" — target interrupted before TTS`);
      return;
    }

    let mp3Buf;
    let frames;
    try {
      ({ mp3Buf, frames } = await this._synthesizeToOpusFrames(reply, username));
    } catch (e) {
      if (e && (e.code === 'ERR_CANCELED' || e.name === 'CanceledError')) {
        this._log(`tts cancelled for "${username}" — target speaking`);
        return;
      }
      this._log(`tts failed for "${username}": ${this._formatAxiosError(e)}`);
      return;
    }
    if (!frames || frames.length === 0) {
      this._log(`skip "${username}" — empty TTS audio`);
      return;
    }

    if (this._isReplyCancelled(username, genAtStart)) {
      this._log(`skip "${username}" — target interrupted during TTS`);
      return;
    }

      if (!this.voiceChat || this.voiceChat.state !== 'connected') {
        this._log(`skip "${username}" — VC dropped during synth`);
        return;
      }

      if (this._isReplyCancelled(username, genAtStart)) {
        this._log(`skip playback "${username}" — target interrupted before stream`);
        return;
      }

      try {
        const completed = await this.voiceChat.playClip(frames);
        if (!completed) {
          this._log(`stream aborted for "${username}" — target spoke, will re-reply after they finish`);
          const buf2 = this._buffers.get(username);
          if (!buf2 || buf2.transcripts.length === 0) {
            if (!this._buffers.has(username)) {
              this._buffers.set(username, { transcripts: [], startedAt: Date.now(), timer: null });
            }
            const b = this._buffers.get(username);
            for (const s of snapshot) b.transcripts.push(s);
            b.startedAt = b.transcripts[0]?.t || Date.now();
          }
          return;
        }
      } catch (e) {
        this._log(`stream failed for "${username}": ${e.message}`);
        return;
      }

      // Commit successful reply.
      this._lastReplyAt.set(username, Date.now());
      win.count++;
      this._appendHistory(username, mergedText, reply);
      this._log(
        `replied to "${username}" — ${frames.length} frames (~${frames.length * 20}ms), ` +
        `replies=${win.count}/${this.replyWindowCap} this window` +
        (snapshot.length > 1 ? `, merged=${snapshot.length}` : '')
      );

      if (this.onReplyGenerated) {
        try {
          await this.onReplyGenerated({
            username,
            transcript: mergedText,
            transcripts: snapshot.map((s) => s.text),
            reply,
            mp3Buf,
            durationMs: frames.length * 20,
            adminClipInfo: lastInfo,
            mergedCount: snapshot.length,
            scenario: 'reactive',
          });
        } catch (e) {
          this._log(`onReplyGenerated callback error: ${e.message}`);
        }
      }
    } finally {
      this._activeReplies.delete(username);

      // If new clips arrived during generation, schedule another fire so
      // the admin's later words get a reply too.
      const buf2 = this._buffers.get(username);
      if (buf2 && buf2.transcripts.length > 0) {
        if (buf2.startedAt === 0) {
          buf2.startedAt = buf2.transcripts[0]?.t || Date.now();
        }
        this._scheduleDebounced(username);
      }
    }
  }

  // ------------------------------------------------------------ Pipeline steps

  /** ElevenLabs Scribe — POST /v1/speech-to-text. */
  async _transcribe(mp3Path) {
    let FormData;
    try { FormData = require('form-data'); }
    catch (e) { throw new Error(`form-data not installed: ${e.message}`); }

    const form = new FormData();
    form.append('file', fs.createReadStream(mp3Path), {
      filename: path.basename(mp3Path),
      contentType: 'audio/mpeg',
    });
    form.append('model_id', this.sttModel);
    form.append('language_code', 'eng');
    form.append('tag_audio_events', 'false');

    const resp = await axios.post(
      'https://api.elevenlabs.io/v1/speech-to-text',
      form,
      {
        headers: { 'xi-api-key': this.elevenApiKey, ...form.getHeaders() },
        timeout: 30_000,
      }
    );

    return String(resp.data?.text || '').trim();
  }

  /**
   * OpenRouter chat completions with per-admin history. Pass a
   * `systemPromptOverride` to use a scenario-specific prompt (approach,
   * combat); when omitted, the default reactive prompt is used.
   *
   * Returns `{ text, delayMs }` — the LLM picks its own pre-speak pause
   * (`delay_ms`) so different contexts get different timing (instant
   * panic, casual quick reply, awkward stall, etc.).
   */
  async _generateReply(username, userText, systemPromptOverride) {
    const history = this._history.get(username) || [];
    const baseSysPrompt = systemPromptOverride || this.systemPrompt;
    // Append the JSON-output instruction so the model emits both text
    // AND delay_ms in one structured response. Done on every call so
    // user-edited prompt files don't need to know about JSON.
    const sysPrompt = baseSysPrompt + this.jsonOutputInstruction;
    const messages = [
      { role: 'system', content: sysPrompt },
      ...history,
      { role: 'user', content: userText },
    ];

    // gpt-5.2 (and other reasoning models) eat into max_tokens for internal
    // reasoning before producing visible content. With max_tokens=80 the
    // reasoning phase swallowed all 80 tokens and returned content=null. We
    // need short casual replies, NOT a thinking model — so we explicitly
    // disable reasoning. `effort:'minimal'` disables the thinking phase on
    // OpenAI; `exclude:true` strips reasoning from the response payload.
    // Non-reasoning models (e.g. gpt-4o) silently ignore this field.
    const resp = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: this.llmModel,
        messages,
        max_tokens: 160,
        temperature: 0.85,
        top_p: 0.9,
        reasoning: { effort: 'minimal', exclude: true },
        // Hint the provider to bias toward valid JSON. Models that don't
        // honor this will still mostly produce valid JSON because of the
        // explicit format instruction in the system prompt; the parser
        // also has a regex fallback for non-JSON output.
        response_format: { type: 'json_object' },
      },
      {
        headers: {
          Authorization: `Bearer ${this.openRouterKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://donutsmp.net',
          'X-Title': 'AdminFriend',
        },
        timeout: 30_000,
      }
    );

    const raw = resp.data?.choices?.[0]?.message?.content || '';
    return this._parseStructuredReply(raw);
  }

  /**
   * Parse the LLM response into `{ text, delayMs }`. Tries strict JSON
   * first, then a regex JSON-object extractor, then falls back to the
   * raw text with a sane default delay so a malformed reply doesn't
   * silently kill the pipeline.
   */
  _parseStructuredReply(raw) {
    const fallbackDelayMs = this.replyDelayCapMs === 0
      ? 0
      : Math.round(
        this.thinkDelayMinMs +
        Math.random() * Math.max(0, this.thinkDelayMaxMs - this.thinkDelayMinMs)
      );

    let parsed = null;
    const trimmed = String(raw || '').trim();
    if (!trimmed) return { text: '', delayMs: fallbackDelayMs };

    // 1) Direct JSON parse.
    try { parsed = JSON.parse(trimmed); } catch (_) { /* try fallback */ }

    // 2) Extract first {...} block from a wrapped response (handles
    //    accidental code fences or "Here's the reply: {...}" preambles).
    if (!parsed) {
      const m = trimmed.match(/\{[\s\S]*\}/);
      if (m) {
        try { parsed = JSON.parse(m[0]); } catch (_) { /* still bad */ }
      }
    }

    if (parsed && typeof parsed === 'object') {
      const text = this._sanitizeReply(parsed.text);
      let delayMs = Number(parsed.delay_ms);
      if (!Number.isFinite(delayMs) || delayMs < 0) delayMs = fallbackDelayMs;
      // Clamp to [0, replyDelayCapMs]. Default cap (4500) gives the LLM a
      // little headroom over its 4000ms instruction; snappy callers lower it.
      delayMs = Math.max(0, Math.min(this.replyDelayCapMs, Math.round(delayMs)));
      return { text, delayMs };
    }

    // 3) Last-resort: treat the whole thing as the reply text and use a
    //    default delay. Logged so we know when the model is misbehaving.
    this._log(`structured-parse failed, using raw text + default delay (raw="${trimmed.slice(0, 80)}")`);
    return { text: this._sanitizeReply(trimmed), delayMs: fallbackDelayMs };
  }

  /**
   * TTS -> Opus frames. When donutty spell split is configured, spells the
   * invite code as separate phonetic syllables with silent gaps between each.
   */
  async _synthesizeToOpusFrames(text, username) {
    const split = this.donuttySpellSplit
      ? this.donuttySpellSplit(text)
      : { main: text, spell: false };

    const useSpell = split.spell &&
      this.donuttySpellLetters &&
      this.donuttySpellLetters.length > 0 &&
      silentOpusFrames;

    if (!useSpell) {
      const mp3Buf = await this._synthesize(text, username);
      const frames = await this._encodeMp3BufferToOpusFrames(mp3Buf);
      return { mp3Buf, frames };
    }

    const allFrames = [];
    let mp3Buf = null;

    if (split.main) {
      mp3Buf = await this._synthesize(split.main, username);
      allFrames.push(...await this._encodeMp3BufferToOpusFrames(mp3Buf));
      allFrames.push(...silentOpusFrames(this.donuttySpellLeadPauseMs));
    }

    const letters = this.donuttySpellLetters;
    if (this.donuttySpellSingleCall) {
      const spellText = letters.join(' ... ');
      const spellMp3 = await this._synthesize(spellText, username, { spellMode: true });
      if (!mp3Buf) mp3Buf = spellMp3;
      allFrames.push(...await this._encodeMp3BufferToOpusFrames(spellMp3));
      this._log(`donutty spell TTS — single call (${letters.length} letters, ~${allFrames.length} frames)`);
    } else {
      for (let i = 0; i < letters.length; i++) {
        const letterMp3 = await this._synthesize(letters[i], username, { spellMode: true });
        if (!mp3Buf) mp3Buf = letterMp3;
        allFrames.push(...await this._encodeMp3BufferToOpusFrames(letterMp3));
        if (i < letters.length - 1) {
          allFrames.push(...silentOpusFrames(this.donuttySpellPauseMs));
        }
      }
      this._log(
        `donutty spell TTS — ${letters.length} phonetic letters ` +
        `(pause=${this.donuttySpellPauseMs}ms, ~${allFrames.length} frames)`
      );
    }

    return { mp3Buf, frames: allFrames };
  }

  /** ElevenLabs TTS — POST /v1/text-to-speech/{voice_id}. */
  async _synthesize(text, username, synthOpts = {}) {
    const url =
      'https://api.elevenlabs.io/v1/text-to-speech/' +
      encodeURIComponent(this.voiceId);

    const spellMode = !!(synthOpts && synthOpts.spellMode);
    const stab = spellMode
      ? this._clamp01(this.spellStability)
      : this._clamp01(this.stability + (Math.random() - 0.5) * 0.03);
    const sty = spellMode
      ? this._clamp01(this.spellStyle)
      : this._clamp01(this.style + (Math.random() - 0.5) * 0.02);

    let abortCtrl = null;
    if (username) {
      const user = this._normUser(username);
      abortCtrl = new AbortController();
      const prev = this._ttsAbort.get(user);
      if (prev) {
        try { prev.abort(); } catch (_) {}
      }
      this._ttsAbort.set(user, abortCtrl);
    }

    try {
      const payload = {
        text,
        model_id: this.ttsModel,
        voice_settings: {
          stability: stab,
          similarity_boost: this.similarityBoost,
          style: sty,
          use_speaker_boost: true,
        },
      };
      if (this.ttsLanguageCode) payload.language_code = this.ttsLanguageCode;

      const resp = await axios.post(
        url,
        payload,
        {
          headers: {
            'xi-api-key': this.elevenApiKey,
            'Content-Type': 'application/json',
            Accept: 'audio/mpeg',
          },
          responseType: 'arraybuffer',
          timeout: 30_000,
          signal: abortCtrl ? abortCtrl.signal : undefined,
        }
      );

      return Buffer.from(resp.data);
    } finally {
      if (username && abortCtrl) {
        const user = this._normUser(username);
        if (this._ttsAbort.get(user) === abortCtrl) {
          this._ttsAbort.delete(user);
        }
      }
    }
  }

  /** Save MP3 buffer to a temp file, run it through preencodeClip, delete. */
  async _encodeMp3BufferToOpusFrames(mp3Buf) {
    if (!preencodeClip) throw new Error('voice_audio.preencodeClip unavailable');

    const tmp = path.join(
      this._tmpDir,
      `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp3`
    );
    fs.writeFileSync(tmp, mp3Buf);
    try {
      return await preencodeClip(tmp);
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  }

  // ------------------------------------------------------------- Helpers

  _appendHistory(username, userText, reply) {
    let h = this._history.get(username);
    if (!h) {
      h = [];
      this._history.set(username, h);
    }
    h.push({ role: 'user', content: userText });
    h.push({ role: 'assistant', content: reply });
    // Keep at most historyTurns * 2 messages (each turn = user+assistant).
    while (h.length > this.historyTurns * 2) h.shift();
  }

  /**
   * Strip LLM tells, role prefixes, surrounding quotes, and clamp to
   * maxReplyChars at the last sentence boundary.
   */
  _sanitizeReply(raw) {
    let text = String(raw || '').trim();
    if (!text) return '';

    // Drop role prefixes some models still emit ("Assistant:", "AI:", etc.)
    text = text.replace(/^(?:assistant|ai|bot|system|me|you)\s*:\s*/i, '');

    // Strip enclosing quotes (single, double, smart) and stray asterisks.
    text = text.replace(/^[\s"'“”‘’*]+|[\s"'“”‘’*]+$/g, '');

    // Hard blacklist — if any of these phrases appear, pick a fallback so we
    // never ship a "as an AI..." reply over voice. These are case-insensitive
    // substring checks; one match nukes the whole reply.
    const blacklist = [
      'as an ai',
      'language model',
      'as a language',
      'i am an ai',
      "i'm an ai",
      'openai',
      ' gpt-',
      'i cannot',
      "i can't help with that",
      'sorry, i ',
    ];
    const lower = text.toLowerCase();
    if (blacklist.some((b) => lower.includes(b))) {
      const fallbacks = ['huh', 'what', 'idk man', 'im just farming bro', 'huh why'];
      return fallbacks[Math.floor(Math.random() * fallbacks.length)];
    }

    // Length cap — trim at last sentence/clause boundary if possible.
    if (text.length > this.maxReplyChars) {
      const cut = text.substring(0, this.maxReplyChars);
      const m = cut.match(/^.*[,?]/s);
      text = m ? m[0] : cut;
    }

    text = text.trim();
    if (this.replyPreprocessor) {
      try { text = this.replyPreprocessor(text); } catch (_) {}
    }
    return text.trim();
  }

  _clamp01(v) { return Math.max(0, Math.min(1, v)); }

  /** Normalize usernames so NiNtsch_TV and nintsch_tv share one pipeline. */
  _normUser(username) {
    return String(username || '').toLowerCase();
  }

  /**
   * Target started talking in VC — stop our playback and wait for them
   * to finish before replying.
   */
  handleAdminSpeechStart(username) {
    const user = this._normUser(username);
    this._targetSpeaking.set(user, true);
    this._bumpReplyGeneration(user);
    this._abortTts(user);
    if (this.voiceChat && typeof this.voiceChat.abortPlayback === 'function') {
      const aborted = this.voiceChat.abortPlayback(`${user}_speaking`);
      if (aborted) {
        this._log(`interrupted playback — ${user} is speaking`);
      }
    }
    // Drop queued reactive replies; fresh debounce after they finish talking.
    this._normalQueue = this._normalQueue.filter(
      (t) => !(t.kind === 'reactive' && t.username === user)
    );
    const buf = this._buffers.get(user);
    if (buf && buf.timer) {
      clearTimeout(buf.timer);
      buf.timer = null;
    }
  }

  /** Target finished a voice clip — safe to reply again after debounce. */
  handleAdminSpeechEnd(username) {
    const user = this._normUser(username);
    this._targetSpeaking.set(user, false);
  }

  _replyGeneration(username) {
    return this._replyGen.get(this._normUser(username)) || 0;
  }

  _bumpReplyGeneration(username) {
    const user = this._normUser(username);
    const next = (this._replyGen.get(user) || 0) + 1;
    this._replyGen.set(user, next);
    return next;
  }

  _isReplyCancelled(username, genAtStart) {
    const user = this._normUser(username);
    if (this._targetSpeaking.get(user)) return true;
    return this._replyGeneration(username) !== genAtStart;
  }

  _abortTts(username) {
    const user = this._normUser(username);
    const ctrl = this._ttsAbort.get(user);
    if (ctrl) {
      try { ctrl.abort(); } catch (_) {}
      this._ttsAbort.delete(user);
    }
  }

  /** Wait until the target stops sending voice packets (or timeout). */
  async _waitForTargetSilent(username, timeoutMs = 20_000) {
    const user = this._normUser(username);
    const start = Date.now();
    while (this._targetSpeaking.get(user) && Date.now() - start < timeoutMs) {
      await this._sleep(50);
    }
  }

  _formatAxiosError(e, fallback = 'request failed') {
    let detail = e && e.message ? e.message : fallback;
    try {
      let body = e && e.response && e.response.data;
      if (Buffer.isBuffer(body)) body = JSON.parse(body.toString('utf8'));
      if (body && typeof body === 'object') {
        const msg = body.detail?.message || body.detail?.status || body.message;
        if (msg) detail = String(msg);
      }
    } catch (_) {}
    const status = e && e.response && e.response.status;
    return status ? `${detail} (HTTP ${status})` : detail;
  }

  _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  _log(msg) {
    const line = `${this.botTag} [VoiceAI] ${msg}`;
    console.log(line);
    if (this.onLog) this.onLog(line);
  }
}

module.exports = {
  VoiceAI,
  HARDCODED_FALLBACK_PROMPT,
  HARDCODED_APPROACH_FALLBACK,
  HARDCODED_COMBAT_FALLBACK,
  JSON_OUTPUT_INSTRUCTION,
  VOICEAD_JSON_OUTPUT_INSTRUCTION,
  resolveSystemPrompt,
  resolveApproachPrompt,
  resolveCombatPrompt,
};
