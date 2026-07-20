'use strict';
// voicebot — configuration, chat parsing, prompt loading, speech shaping,
// Discord webhook helpers. Pure/config layer shared by state, bot and index.
const chalk = require('chalk');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Repo-root anchor so player_list.txt / voicead_state.db / prompt files resolve
// to the project root regardless of this module's location.
const ROOTDIR = path.join(__dirname, '..');

// ---- CONFIGURATION ----
const START_BOT = parseInt(process.env.START_BOT, 10) || 1;
const END_BOT = parseInt(process.env.END_BOT, 10) || 1;
const START_DELAY_MS = parseInt(process.env.START_DELAY_MS, 10) || 4000;

const SERVER_HOST = process.env.SERVER_HOST || 'donutsmp.net';
const SERVER_PORT = parseInt(process.env.SERVER_PORT, 10) || 25565;
const MC_VERSION = process.env.MC_VERSION || '1.21';
// Auth cache folders are separate from pool1's .msa-cache-N — voicead uses
// .msa-cache-adbot-N (Java sessions dedicated to this recruiter pool).
const MSA_CACHE_PREFIX = process.env.MSA_CACHE_PREFIX || 'adbot';
const MSA_LABEL = process.env.MSA_LABEL || 'skellybot';

const SCAN_INTERVAL_MS = parseInt(process.env.VOICEAD_SCAN_INTERVAL_MS, 10) || 5 * 60 * 1000;
const TAB_COMPLETE_TIMEOUT_MS = parseInt(process.env.TAB_COMPLETE_TIMEOUT_MS, 10) || 8000;
const TPA_COMMAND = process.env.TPA_COMMAND || '/tpahere';
const TPA_WAIT_MS = parseInt(process.env.TPA_WAIT_MS, 10) || 30_000;
const PENDING_TPA_MS = parseInt(process.env.PENDING_TPA_MS, 10) || 120_000; // keep listening for late accepts
const TPA_CONFIRM_SLOT = parseInt(process.env.TPA_CONFIRM_SLOT, 10) || 16;
const TPA_CONFIRM_GUI_SLOTS = parseInt(process.env.TPA_CONFIRM_GUI_SLOTS, 10) || 27;
const TPA_CONFIRM_OPEN_MS = parseInt(process.env.TPA_CONFIRM_OPEN_MS, 10) || 8000;
const TPA_CONFIRM_DELAY_MS = parseInt(process.env.TPA_CONFIRM_DELAY_MS, 10) || 400;
const GREET_DELAY_MS = parseInt(process.env.GREET_DELAY_MS, 10) || 5_000;
const PITCH_DELAY_MS = parseInt(process.env.PITCH_DELAY_MS, 10) || 3_000;
const ACCEPT_RADIUS = parseFloat(process.env.TPA_ACCEPT_RADIUS || '8');
const CONVO_RADIUS = parseFloat(process.env.CONVO_RADIUS || '48'); // stay in convo while within this range
const TPA_LOOP_GAP_MS = parseInt(process.env.TPA_LOOP_GAP_MS, 10) || 3_000;

// /rtpqueue encounter loop (replaces /tpahere targeting).
const RTPQUEUE_COMMAND = process.env.RTPQUEUE_COMMAND || '/rtpqueue';
const RTPQUEUE_WAIT_MS = parseInt(process.env.RTPQUEUE_WAIT_MS, 10) || 180_000;
const RTPQUEUE_MAX_MS = parseInt(process.env.RTPQUEUE_MAX_MS, 10) || 600_000;
const RTPQUEUE_RETRY_MS = parseInt(process.env.RTPQUEUE_RETRY_MS, 10) || 5000;
const RTPQUEUE_LOOP_GAP_MS = parseInt(process.env.RTPQUEUE_LOOP_GAP_MS, 10) || TPA_LOOP_GAP_MS;
const RTPQUEUE_PAIR_RADIUS = parseFloat(process.env.RTPQUEUE_PAIR_RADIUS || String(CONVO_RADIUS || 48));
// Min position jump (blocks) treated as a teleport.
const RTPQUEUE_MOVE_MIN = parseFloat(process.env.RTPQUEUE_MOVE_MIN || '3');
// Grace period after a teleport before scanning, so entities can load in.
const RTPQUEUE_SETTLE_MS = parseInt(process.env.RTPQUEUE_SETTLE_MS, 10) || 2500;
// Keep scanning for partner after self-teleport even if queue wait elapsed.
const RTPQUEUE_PARTNER_SCAN_MS = parseInt(process.env.RTPQUEUE_PARTNER_SCAN_MS, 10) || 45_000;
const RTPQUEUE_DEBUG = (process.env.RTPQUEUE_DEBUG || 'false').toLowerCase() === 'true';
const RTPQUEUE_RESPAWN_DELAY_MS = parseInt(process.env.RTPQUEUE_RESPAWN_DELAY_MS, 10) || 400;

// /rtpqueue opens a confirmation GUI — must click confirm to actually enter the queue.
const RTPQUEUE_CONFIRM_ENABLED = (process.env.RTPQUEUE_CONFIRM_ENABLED || 'true').toLowerCase() !== 'false';
const RTPQUEUE_CONFIRM_OPEN_MS = parseInt(process.env.RTPQUEUE_CONFIRM_OPEN_MS, 10) || 5000;
const RTPQUEUE_CONFIRM_DELAY_MS = parseInt(process.env.RTPQUEUE_CONFIRM_DELAY_MS, 10) || 400;
// Fallback slot if no confirm-like item is found by keyword/material scan.
const RTPQUEUE_CONFIRM_SLOT = process.env.RTPQUEUE_CONFIRM_SLOT != null
  ? parseInt(process.env.RTPQUEUE_CONFIRM_SLOT, 10)
  : null;
const RTPQUEUE_CONFIRM_KEYWORDS = /\b(confirm|accept|yes|queue|join|teleport|rtp|proceed|continue|ok)\b/i;
const RTPQUEUE_CONFIRM_MATERIALS = /(lime|green)_(wool|dye|concrete|terracotta|stained_glass|carpet)|emerald|slime_ball|nether_star/i;

/** Geyser/Bedrock players join with a "." name prefix — we only target Java. */
function isBedrockName(name) {
  return String(name || '').startsWith('.');
}

/** Best-effort visible text (name + lore) for a GUI slot item. */
function guiItemText(item) {
  if (!item) return '';
  const parts = [];
  const tryJson = (s) => {
    if (typeof s !== 'string') return s;
    try { return JSON.parse(s); } catch (_) { return s; }
  };
  const flatten = (node) => {
    if (node == null) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(flatten).join(' ');
    if (typeof node === 'object') {
      let out = '';
      if (typeof node.text === 'string') out += node.text;
      if (node.extra) out += ' ' + flatten(node.extra);
      if (node.value != null && !node.text) out += ' ' + flatten(node.value);
      if (node.translate) out += ' ' + String(node.translate);
      return out;
    }
    return '';
  };

  if (item.customName) parts.push(flatten(tryJson(item.customName)));
  if (item.displayName) parts.push(String(item.displayName));
  if (item.name) parts.push(String(item.name));
  const lore = item.customLore;
  if (Array.isArray(lore)) for (const l of lore) parts.push(flatten(tryJson(l)));

  try {
    const nbtName = item?.nbt?.value?.display?.value?.Name?.value;
    if (nbtName) parts.push(flatten(tryJson(nbtName)));
    const nbtLore = item?.nbt?.value?.display?.value?.Lore?.value?.value
      || item?.nbt?.value?.display?.value?.Lore?.value;
    if (Array.isArray(nbtLore)) {
      for (const l of nbtLore) parts.push(flatten(typeof l === 'string' ? tryJson(l) : l));
    }
  } catch (_) {}

  return parts.join(' ').replace(/§[0-9a-fk-or]/gi, '').replace(/\s+/g, ' ').trim();
}

// Debug: first /tpahere goes to a fixed username instead of the random pool pick.
const DEBUG_MODE = String(process.env.DEBUG || process.env.debug || '').toLowerCase() === 'true';
const DEBUG_TPAHERE_TARGET = (
  process.env.tpahere ||
  process.env.TPAHERE ||
  process.env.TPAHERE_USERNAME ||
  ''
).trim();

// Voice chat gating — don't /tpahere until SVC UDP is connected.
const REQUIRE_VC = (process.env.VOICEAD_REQUIRE_VC || 'true').toLowerCase() !== 'false';
const VC_READY_TIMEOUT_MS = parseInt(process.env.VC_READY_TIMEOUT_MS, 10) || 90_000;
const VC_RECONNECT_BASE_MS = parseInt(process.env.VC_RECONNECT_BASE_MS, 10) || 5_000;
const VC_RECONNECT_MAX_MS = parseInt(process.env.VC_RECONNECT_MAX_MS, 10) || 30_000;
const VC_HANDSHAKE_STUCK_MS = parseInt(process.env.VC_HANDSHAKE_STUCK_MS, 10) || 12_000;

// Conversation lifecycle
const CONVO_IDLE_MS = parseInt(process.env.CONVO_IDLE_MS, 10) || 90_000;   // no interaction -> end
const CONVO_MAX_MS = parseInt(process.env.CONVO_MAX_MS, 10) || 5 * 60 * 1000; // hard cap
const CONVO_MIN_MS = parseInt(process.env.CONVO_MIN_MS, 10) || 60_000; // min time before leave/idle end
const LEAVE_GRACE_MS = parseInt(process.env.CONVO_LEAVE_GRACE_MS, 10) || 60_000; // target gone this long -> end
/** Don't re-start a convo with the same player right after one ends (proximity/deferred false positives). */
const CONVO_COOLDOWN_MS = parseInt(process.env.CONVO_COOLDOWN_MS, 10) || 10 * 60 * 1000;
const RTP_AFTER_CONVO = (process.env.VOICEAD_RTP_AFTER_CONVO || 'true').toLowerCase() !== 'false';
const RTP_AFTER_CONVO_MS = parseInt(process.env.VOICEAD_RTP_AFTER_CONVO_MS, 10) || 2500;
const RTP_DIRECTIONS = (process.env.VOICEAD_RTP_DIRECTIONS || 'west,east')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// Discord invite (given after player shows interest — not a personal add-friend handoff).
const DISCORD_INVITE = (process.env.VOICEAD_DISCORD_INVITE || 'discord.gg/donutty').trim();
/** MineLink verify + join-team channels (from selfbot2 — for text prompts only, not TTS IDs). */
const DISCORD_VERIFY_CHANNEL_ID = (process.env.VOICEAD_DC_VERIFY_CHANNEL_ID || '1458480715590008998').trim();
const DISCORD_TEAM_CHANNEL_ID = (process.env.VOICEAD_DC_TEAM_CHANNEL_ID || '1458479223084810379').trim();

// Bot log webhook (includes [VC] / [VoiceAI] lines when configured).
const VCBOTLOGS_WEBHOOK = (
  process.env.vcbotlogs ||
  process.env.VCBOTLOGS ||
  ''
).trim();

const PLAYER_LIST_FILE = path.join(ROOTDIR, 'player_list.txt');
const STATE_DB_FILE = path.join(ROOTDIR, 'voicead_state.db');

const JAVA_USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const TAB_PREFIXES = 'abcdefghijklmnopqrstuvwxyz0123456789_'.split('');

// Accept detection: proximity is primary; this regex is a chat fallback.
const ACCEPT_RE = new RegExp(
  process.env.TPA_ACCEPT_REGEX ||
  'accepted (your|the) (teleport|tpa|tpahere)|teleport(ed|ing) to you|has teleported to you',
  'i'
);

/** Chat accept lines must name the target — ignore other players' accepts. */
function parseAcceptUsername(msg) {
  const plain = stripMcColorCodes(String(msg || '')).trim();
  if (!ACCEPT_RE.test(plain)) return null;
  // DonutSMP: "NiNtsch_TV accepted the tpahere."
  let m = plain.match(/^([A-Za-z0-9_]{3,16})\s+accepted\b/i);
  if (m) return m[1];
  m = plain.match(/^([A-Za-z0-9_]{3,16})\s+has teleported\b/i);
  if (m) return m[1];
  m = plain.match(/^([A-Za-z0-9_]{3,16})\s+teleported to you\b/i);
  if (m) return m[1];
  return null;
}

function acceptMessageMatchesTarget(msg, target) {
  const parsed = parseAcceptUsername(msg);
  if (parsed && parsed.toLowerCase() === String(target || '').toLowerCase()) return true;
  const plain = stripMcColorCodes(String(msg || '')).toLowerCase();
  const want = String(target || '').toLowerCase();
  if (!want || !ACCEPT_RE.test(plain)) return false;
  return plain.includes(want);
}
// Fast-fail detection: target offline / request failed.
const TPA_FAIL_RE = new RegExp(
  process.env.TPA_FAIL_REGEX ||
  "couldn't find|could not find|not online|is not online|player not found|no player|you can't teleport to yourself",
  'i'
);

const LOG_SERVER_CHAT = (process.env.VOICEAD_LOG_SERVER_CHAT || 'true').toLowerCase() !== 'false';
const LOG_TARGET_WHISPER = (process.env.VOICEAD_LOG_TARGET_WHISPER || 'true').toLowerCase() !== 'false';

// DonutSMP chat classification (ported from pool1.js).
const _SERVER_COLON_FIELDS = new Set([
  'balance', 'coins', 'warning', 'error', 'note', 'tip', 'next',
  'cooldown', 'time left', 'reason', 'sold', 'bal', 'you', 'server', 'system',
]);
const _SERVER_BRACKET_TAGS = new Set(['server', 'system']);
const _PLAYER_COLON_CHAT_RE = /^[+.\-*~!]*[^\s:]{2,32}:\s/;
// Action-bar / tablist spam — never useful in console.
const _CHAT_SPAM_SUBSTRINGS = ['✎', '❈', '❤', '+400 Bits from Cookie Buff!'];

function stripMcColorCodes(s) {
  return String(s || '').replace(/§[0-9A-FK-OR]/gi, '');
}

/** True if this line is another player's public chat (not server/system). */
function isPlayerChatLine(s) {
  if (typeof s !== 'string') return false;
  const trimmed = stripMcColorCodes(s).trim();
  if (!trimmed) return false;

  // "<RankName> message" — almost always player public chat on Donut.
  if (trimmed.startsWith('<')) {
    const close = trimmed.indexOf('>');
    if (close > 1) {
      const tag = trimmed.slice(1, close).replace(/^[+.\-*~!]+/, '').trim().toLowerCase();
      if (_SERVER_BRACKET_TAGS.has(tag)) return false;
    }
    return true;
  }

  // "+Name: message" / "Name: message" — player unless token is a known server field.
  if (!_PLAYER_COLON_CHAT_RE.test(trimmed)) return false;
  const colon = trimmed.indexOf(':');
  if (colon <= 0) return false;
  const token = trimmed.slice(0, colon).replace(/^[+.\-*~!]+/, '').trim().toLowerCase();
  return !_SERVER_COLON_FIELDS.has(token);
}

function isGarbageChatLine(s) {
  if (typeof s !== 'string') return true;
  const plain = stripMcColorCodes(s).trim();
  if (!plain) return true;
  if (/\uFFFD/.test(plain)) return true;
  if (plain.length < 2) return true;
  if (/^<[\s<>]*$/.test(plain)) return true;
  return false;
}

function isChatSpamLine(s) {
  const plain = stripMcColorCodes(s);
  return _CHAT_SPAM_SUBSTRINGS.some((frag) => plain.includes(frag));
}

/** Should this server line be printed to console? */
function shouldLogServerChatLine(s) {
  if (!LOG_SERVER_CHAT) return false;
  if (isGarbageChatLine(s) || isChatSpamLine(s)) return false;
  if (isPlayerChatLine(s)) return false;
  return true;
}

/** DM/whisper lines (not public tab chat). */
function isWhisperLine(s) {
  const plain = stripMcColorCodes(s).trim();
  return /whispers?(?: to you)?:/i.test(plain) ||
    /^From [A-Za-z0-9_]{3,16}:/i.test(plain) ||
    /^To [A-Za-z0-9_]{3,16}:/i.test(plain);
}

// Suppress protodef parse spam (DonutSMP custom NBT) — bot keeps running.
process.on('uncaughtException', (e) => {
  const msg = (e && e.message) || '';
  if (
    e?.code === 'ERR_OUT_OF_RANGE' ||
    /varint is too big|abnormally large|Missing characters in string|Unexpected buffer end|PartialReadError|Read error|Chunk size|partial packet/i.test(msg)
  ) {
    return;
  }
  console.error(chalk.red('[voicead] Uncaught exception:'), msg);
});

// ============================================================
// Username / spelling helpers
// ============================================================

const DIGIT_WORDS = {
  '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four',
  '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine',
};

/** How to SAY a single character out loud when spelling. */
function spellToken(ch) {
  if (ch === '_') return 'underscore';
  if (DIGIT_WORDS[ch]) return `${DIGIT_WORDS[ch]} (the digit ${ch})`;
  return `the letter ${ch.toUpperCase()}`;
}

/** Human-readable char for the duplicate summary. */
function displayChar(ch) {
  if (ch === '_') return 'underscore';
  if (DIGIT_WORDS[ch]) return `digit ${ch}`;
  return ch.toUpperCase();
}

/**
 * The spoken form of a name: drop digits, turn underscores into spaces.
 * e.g. "meow123" -> "meow", "ry3e_2ns_3" -> "rye ns".
 */
function spokenName(username) {
  let s = String(username || '').replace(/[0-9]/g, '');
  s = s.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  return s || 'friend';
}

/** Build a deterministic, per-character spelling guide the LLM can rely on. */
function buildSpellingGuide(username) {
  const chars = String(username || '').split('');
  const order = chars
    .map((ch, i) => `    position ${i + 1}: ${spellToken(ch)}`)
    .join('\n');

  const counts = {};
  for (const ch of chars) counts[ch] = (counts[ch] || 0) + 1;

  const dupes = Object.entries(counts)
    .filter(([, c]) => c > 1)
    .map(([ch, c]) => {
      const positions = chars
        .map((c2, i) => (c2 === ch ? i + 1 : null))
        .filter((x) => x !== null)
        .join(' and ');
      return `    - "${displayChar(ch)}" appears ${c} times (positions ${positions}) — if asked "whats after ${displayChar(ch)}", ask which one`;
    });

  const dupSection = dupes.length
    ? 'Characters that appear more than once:\n' + dupes.join('\n')
    : 'Every character appears only once, so "whats after X" always has a single answer.';

  return { order, dupSection };
}

/** Scene context injected into every per-target prompt. */
function buildSceneContext(botUsername, targetUsername) {
  const bot = botUsername || 'you';
  return [
    'WHAT JUST HAPPENED (stay in character, use this context):',
    `- Your in-game name is ${bot}. You sent /tpahere to ${targetUsername} on DonutSMP`,
    '- They accepted your teleport request and just arrived standing right next to you',
    '- You are in proximity voice chat together — this is right after the teleport',
    '- You called them over to pitch joining your group for free gear and money',
  ].join('\n');
}

/** Full spoken Discord handoff (LLM + TTS preprocessor normalize to this). */
const DONUTTY_INVITE_SPEECH =
  'bet join donutty on discord, it is discord dot g g slash donutty, I will spell the invite code for you, d, o, n, u, t, t, y';
const DONUTTY_SLOW_SPELL = 'd, o, n, u, t, t, y';
const DONUTTY_SPELL_PLACEHOLDER = '\x00DONUTTY_SPELL\x00';
/** Clear English letter cues for separate TTS calls (bare "d"/"en"/"uh" sound garbled). */
function loadDonuttySpellLetters() {
  const raw = process.env.VOICEAD_SPELL_LETTERS;
  if (raw && raw.trim()) {
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return ['Letter D', 'Letter O', 'Letter N', 'Letter U', 'Letter T', 'Letter T', 'Letter Y'];
}
const DONUTTY_PHONETIC_LETTERS = loadDonuttySpellLetters();
const DONUTTY_SPELL_PAUSE_MS = parseInt(process.env.VOICEAD_SPELL_PAUSE_MS || '300', 10) || 300;
const DONUTTY_SPELL_LEAD_PAUSE_MS = parseInt(process.env.VOICEAD_SPELL_LEAD_PAUSE_MS || '150', 10) || 150;

/** Split reply into main line + donutty letter spelling for slow multi-part TTS. */
function splitDonuttySpell(text) {
  let s = String(text || '').trim();
  if (!s) return { main: '', spell: false };

  const suffixRes = [
    /^(.*?)(?:,?\s*)d,\s*o,\s*n,\s*(?:u|you),\s*t,\s*t,\s*y\s*$/i,
    /^(.*?)(?:,?\s*)d,\s*o,\s*n,\s*u,\s*t,\s*t,\s*y\s*$/i,
    /^(.*?)(?:,?\s*)d\s+o\s+n\s+(?:u|you)\s+t\s+t\s+y\s*$/i,
  ];
  for (const re of suffixRes) {
    const m = s.match(re);
    if (m) return { main: m[1].replace(/,\s*$/, '').trim(), spell: true };
  }

  if (/discord dot g g slash donutty/i.test(s)) {
    const m = s.match(/^(.*?discord dot g g slash donutty)(?:,?\s*d,\s*o,\s*n,\s*u,\s*t,\s*t,\s*y)?\s*$/i);
    if (m) return { main: m[1].trim(), spell: true };
  }

  return { main: s, spell: false };
}

function fixDonuttySpelling(text) {
  let s = String(text || '');
  // Fix preprocessor / LLM mangling ("d o n you t t y", "d, o, n, you, t, t, y").
  s = s.replace(
    /\bd[\s,.\-]+o[\s,.\-]+n[\s,.\-]+(?:you|u)[\s,.\-]+t[\s,.\-]+t[\s,.\-]+y\b/gi,
    DONUTTY_SLOW_SPELL
  );
  s = s.replace(/\bd[\s,]+o[\s,]+n[\s,]+u[\s,]+t[\s,]+t[\s,]+y\b/gi, DONUTTY_SLOW_SPELL);
  s = s.replace(/\bd o n u t t y\b/gi, DONUTTY_SLOW_SPELL);
  // Normalize short invite lines to the full handoff script.
  if (/join donutty on discord/i.test(s) && !/I will spell the invite code for you/i.test(s)) {
    return DONUTTY_INVITE_SPEECH;
  }
  // Ensure invite lines with link but no spell intro still get full script.
  if (/discord dot g g slash donutty/i.test(s) && !/I will spell the invite code for you/i.test(s)) {
    if (/d,\s*o,\s*n,\s*u,\s*t,\s*t,\s*y/i.test(s)) return DONUTTY_INVITE_SPEECH;
  }
  // Ensure invite lines always end with the slow comma spelling.
  if (/donutty|discord dot g g slash donutty/i.test(s)) {
    if (/I will spell the invite code for you/i.test(s)) {
      return s.replace(/d,\s*o,\s*n,\s*(?:u|you),\s*t,\s*t,\s*y\s*$/i, DONUTTY_SLOW_SPELL);
    }
    s = s.replace(
      /(join donutty on discord)(?:[,\s].*)?$/i,
      DONUTTY_INVITE_SPEECH
    );
    s = s.replace(
      /(discord dot g g slash donutty)(?:[,\s].*)?$/i,
      `it is discord dot g g slash donutty, I will spell the invite code for you, ${DONUTTY_SLOW_SPELL}`
    );
  }
  return s.replace(/\s+/g, ' ').trim();
}

/** When the LLM adds commas between every word ("slow" speech), TTS stutters. */
function reduceStutterCommas(text) {
  let s = String(text || '').replace(DONUTTY_SLOW_SPELL, DONUTTY_SPELL_PLACEHOLDER);
  // Keep commas in the full discord invite script — they mark natural pauses.
  if (/I will spell the invite code for you/i.test(s)) {
    return s.replace(DONUTTY_SPELL_PLACEHOLDER, DONUTTY_SLOW_SPELL);
  }
  const commaCount = (s.match(/,/g) || []).length;
  if (commaCount > 2) {
    // Keep single-letter comma chains (spelling); drop commas before normal words.
    s = s.replace(/,\s+(?=[a-zA-Z]{2,})/g, ' ');
  }
  return s.replace(DONUTTY_SPELL_PLACEHOLDER, DONUTTY_SLOW_SPELL);
}

/** Expand abbreviations so TTS reads naturally (rn -> right now, etc.). */
function expandSpeechForTts(text) {
  let s = reduceStutterCommas(fixDonuttySpelling(text));
  if (!s) return s;
  const rules = [
    [/\bwsg\b/gi, 'what is good'],
    [/\brn\b/gi, 'right now'],
    [/\bngl\b/gi, 'not gonna lie'],
    [/\btbh\b/gi, 'to be honest'],
    [/\bfr\b/gi, 'for real'],
    [/\bidk\b/gi, 'I do not know'],
    [/\bim\b/gi, 'I am'],
    [/\bive\b/gi, 'I have'],
    [/\byoure\b/gi, 'you are'],
    [/\btheyre\b/gi, 'they are'],
    [/\bwanna\b/gi, 'want to'],
    [/\bgonna\b/gi, 'going to'],
    [/\bkinda\b/gi, 'kind of'],
    [/\bsorta\b/gi, 'sort of'],
    [/\bcuz\b/gi, 'because'],
    [/\bbc\b/gi, 'because'],
    [/\bprolly\b/gi, 'probably'],
    [/\bdef\b/gi, 'definitely'],
    [/\bchillin\b/gi, 'chilling'],
    // NOTE: do NOT expand bare "u" -> "you" — it breaks "d, o, n, u, t, t, y" spelling.
  ];
  for (const [re, word] of rules) s = s.replace(re, word);
  return s.replace(/\s+/g, ' ').trim();
}

/** Load Donutty Discord server help (MineLink verify steps — from selfbot2). */
function getDiscordServerContext() {
  return loadPromptFile(
    process.env.VOICEAD_DISCORD_CONTEXT_FILE || 'voicead_discord_context.txt',
    ''
  );
}

/** Compose the full per-target system prompt from a base + injected FACTS. */
function buildTargetPrompt(basePrompt, username, botUsername) {
  const nameGuide = buildSpellingGuide(username);
  const discordCtx = getDiscordServerContext();

  const facts = [
    buildSceneContext(botUsername, username),
    '',
    'FACTS ABOUT THE PERSON YOU ARE TALKING TO:',
    `- Their exact in-game username is: ${username}`,
    `- When you SAY their name, call them "${spokenName(username)}" (letters only, never say the digits).`,
    '- Exact character order of their username (use this to spell it or answer "whats after X"):',
    nameGuide.order,
    `  ${nameGuide.dupSection}`,
    '',
    'DISCORD INVITE (only after they show interest):',
    `- The server invite link is ${DISCORD_INVITE}`,
    '- "donutty" is the Discord vanity invite CODE — NOT a player name',
    '- When they show interest, say this EXACT flow in ONE line (then the voice spells letters slowly):',
    `  "${DONUTTY_INVITE_SPEECH}"`,
    '- Do NOT shorten to just "bet join donutty on discord, d, o, n, u, t, t, y" — always include the link and spell intro',
    '- Do NOT mention the discord invite in your first pitch line',
    '',
    'DISCORD SERVER HELP (verification, locked channels, where is gear — use when they ask):',
    `- Verify channel id ${DISCORD_VERIFY_CHANNEL_ID} | Join team channel id ${DISCORD_TEAM_CHANNEL_ID} (say "verify channel" / "join team channel" in voice, not the numbers)`,
    discordCtx ? `\n${discordCtx}` : '',
  ].filter(Boolean).join('\n');

  return `${basePrompt}\n\n${facts}`;
}

// ---- Base prompts (editable .txt with hardcoded fallback) ----
function loadPromptFile(filename, fallback) {
  try {
    const p = path.isAbsolute(filename) ? filename : path.join(ROOTDIR, filename);
    if (fs.existsSync(p)) {
      const t = fs.readFileSync(p, 'utf8').trim();
      if (t) return t;
    }
  } catch (_) { /* fall through */ }
  return fallback;
}

// Neutral fallback prompts — used only if no prompt file is present. The bot's
// personality and goal are up to the owner: copy prompts/*.example.txt to the
// repo root (drop .example) or set VOICEAD_*_FILE to supply your own prompts.
const BASE_CONVO_PROMPT = loadPromptFile(
  process.env.VOICEAD_PROMPT_FILE || 'voicead_prompt.txt',
  'You are a Minecraft player talking to another player in proximity voice chat. ' +
  'Have a natural conversation with them. ' +
  'Speak short and casual, only commas and question marks. Never say you are an AI or a bot. ' +
  'Never say the digits in their name; spell it exactly only if asked.'
);
const BASE_PITCH_PROMPT = loadPromptFile(
  process.env.VOICEAD_PITCH_PROMPT_FILE || 'voicead_pitch_prompt.txt',
  'You are a Minecraft player. The player just accepted your teleport request and came over. ' +
  'Open the conversation in one short, casual line. Use full spoken words only — no rn, u, wanna, gonna. ' +
  'Never say you are an AI or a bot.'
);
const BASE_GREET_PROMPT = loadPromptFile(
  process.env.VOICEAD_GREETING_PROMPT_FILE || 'voicead_greeting_prompt.txt',
  'You are a Minecraft player. Greet the player you just teleported with ONE short friendly line, ' +
  'using the letters-only form of their name. Only commas and question marks. Never say you are an AI or a bot.'
);

// ============================================================
// Discord webhook log sink (vcbotlogs in .env) — embeds, important only
// ============================================================

const WH_COLORS = {
  brand: 0x5865F2,
  ok: 0x57F287,
  warn: 0xFEE75C,
  err: 0xED4245,
  vc: 0xEB459E,
  tpa: 0xF26522,
  talk: 0x00D4AA,
  scan: 0x747F8D,
};

function buildWhEmbed(title, opts = {}) {
  const embed = {
    author: { name: opts.author || 'voicead recruiter' },
    title: opts.emoji ? `${opts.emoji}  ${title}` : title,
    description: opts.description || undefined,
    color: opts.color ?? WH_COLORS.brand,
    fields: (opts.fields || []).filter((f) => f && f.name && f.value).slice(0, 25),
    timestamp: new Date().toISOString(),
    footer: {
      text: opts.botNumber != null
        ? `Bot ${opts.botNumber} • ${SERVER_HOST}`
        : SERVER_HOST,
    },
  };
  return embed;
}

const webhookLogger = {
  queue: [],
  timer: null,
  lastSend: 0,
  minGapMs: 750,

  enabled() {
    return VCBOTLOGS_WEBHOOK.startsWith('http');
  },

  send(payload) {
    if (!this.enabled()) return;
    this.queue.push(payload);
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 900);
  },

  embed(title, opts = {}) {
    this.send({ embeds: [buildWhEmbed(title, opts)] });
  },

  startup() {
    const fields = [
      { name: '🤖 Bots', value: `\`${START_BOT}\` → \`${END_BOT}\``, inline: true },
      { name: '🔄 Scan', value: `every **${Math.round(SCAN_INTERVAL_MS / 1000)}s**`, inline: true },
      { name: '💬 Invite', value: `\`${DISCORD_INVITE}\``, inline: true },
    ];
    if (DEBUG_MODE && DEBUG_TPAHERE_TARGET) {
      fields.push({ name: '🐛 Debug TPA', value: `\`${DEBUG_TPAHERE_TARGET}\``, inline: true });
    }
    this.embed('Recruiter Online', {
      emoji: '🎤',
      color: WH_COLORS.brand,
      description: 'Proximity voice recruiter pool is live on **DonutSMP**.',
      fields,
    });
  },

  async flush() {
    this.timer = null;
    if (!this.queue.length || !this.enabled()) return;

    const payload = this.queue.shift();
    const gap = Math.max(0, this.minGapMs - (Date.now() - this.lastSend));
    if (gap) await sleep(gap);

    try {
      await axios.post(VCBOTLOGS_WEBHOOK, payload, { timeout: 10_000 });
    } catch (_) { /* never break the bot */ }

    this.lastSend = Date.now();
    if (this.queue.length) {
      this.timer = setTimeout(() => this.flush(), this.minGapMs);
    }
  },
};

const TPA_WEBHOOK_INTERVAL_MS = parseInt(process.env.TPA_WEBHOOK_INTERVAL_MS, 10) || 60_000;

/** Rolling /tpahere success counter — one webhook summary per minute, not per player. */
const tpaWebhookStats = {
  /** @type {{ botNumber: number, target: string, at: number }[]} */
  events: [],
  timer: null,

  record(botNumber, target) {
    if (!webhookLogger.enabled()) return;
    this.events.push({ botNumber, target, at: Date.now() });
    if (!this.timer) {
      this.timer = setInterval(() => this.flush(), TPA_WEBHOOK_INTERVAL_MS);
    }
  },

  flush() {
    if (!webhookLogger.enabled()) return;

    const now = Date.now();
    const windowMs = TPA_WEBHOOK_INTERVAL_MS;
    const recent = this.events.filter((e) => e.at >= now - windowMs);
    this.events = this.events.filter((e) => e.at >= now - windowMs * 2);

    if (recent.length === 0) return;

    const byBot = new Map();
    for (const e of recent) {
      byBot.set(e.botNumber, (byBot.get(e.botNumber) || 0) + 1);
    }

    const fields = [...byBot.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([bn, count]) => ({
        name: `Bot ${bn}`,
        value: `\`${count}\``,
        inline: true,
      }));

    const soleBot = byBot.size === 1 ? [...byBot.keys()][0] : null;

    webhookLogger.embed('TPA Activity', {
      emoji: '📨',
      color: WH_COLORS.tpa,
      description:
        `**${recent.length}** successful \`${TPA_COMMAND}\` in the last ` +
        `${Math.round(windowMs / 1000)}s`,
      fields: byBot.size > 1 ? fields : undefined,
      botNumber: soleBot,
    });
  },
};

function bootLog(msg) {
  console.log(msg);
}

function clipField(text, max = 900) {
  const s = String(text || '').trim();
  if (!s) return '*(empty)*';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function truncateLine(s, max = 400) {
  const t = String(s || '').replace(/\r\n/g, '\n').replace(/\n+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Mineflayer player lookup — tab list keys use server casing (e.g. NiNtsch_TV). */
function findBotPlayer(bot, username) {
  if (!bot || !bot.players || !username) return null;
  if (bot.players[username]) return { name: username, player: bot.players[username] };
  const want = String(username).toLowerCase();
  for (const name of Object.keys(bot.players)) {
    if (name.toLowerCase() === want) return { name, player: bot.players[name] };
  }
  return null;
}

const MAX_DISCORD_MP3_BYTES = 23 * 1024 * 1024;

module.exports = {
  acceptMessageMatchesTarget,
  ACCEPT_RADIUS,
  ACCEPT_RE,
  BASE_CONVO_PROMPT,
  BASE_GREET_PROMPT,
  BASE_PITCH_PROMPT,
  bootLog,
  buildSceneContext,
  buildSpellingGuide,
  buildTargetPrompt,
  buildWhEmbed,
  clipField,
  CONVO_COOLDOWN_MS,
  CONVO_IDLE_MS,
  CONVO_MAX_MS,
  CONVO_MIN_MS,
  CONVO_RADIUS,
  DEBUG_MODE,
  DEBUG_TPAHERE_TARGET,
  DIGIT_WORDS,
  DISCORD_INVITE,
  DISCORD_TEAM_CHANNEL_ID,
  DISCORD_VERIFY_CHANNEL_ID,
  displayChar,
  DONUTTY_INVITE_SPEECH,
  DONUTTY_PHONETIC_LETTERS,
  DONUTTY_SLOW_SPELL,
  DONUTTY_SPELL_LEAD_PAUSE_MS,
  DONUTTY_SPELL_PAUSE_MS,
  DONUTTY_SPELL_PLACEHOLDER,
  END_BOT,
  expandSpeechForTts,
  findBotPlayer,
  fixDonuttySpelling,
  getDiscordServerContext,
  GREET_DELAY_MS,
  guiItemText,
  isBedrockName,
  isChatSpamLine,
  isGarbageChatLine,
  isPlayerChatLine,
  isWhisperLine,
  JAVA_USERNAME_RE,
  LEAVE_GRACE_MS,
  loadDonuttySpellLetters,
  loadPromptFile,
  LOG_SERVER_CHAT,
  LOG_TARGET_WHISPER,
  MAX_DISCORD_MP3_BYTES,
  MC_VERSION,
  MSA_CACHE_PREFIX,
  MSA_LABEL,
  parseAcceptUsername,
  PENDING_TPA_MS,
  PITCH_DELAY_MS,
  PLAYER_LIST_FILE,
  reduceStutterCommas,
  REQUIRE_VC,
  RTP_AFTER_CONVO,
  RTP_AFTER_CONVO_MS,
  RTP_DIRECTIONS,
  RTPQUEUE_COMMAND,
  RTPQUEUE_CONFIRM_DELAY_MS,
  RTPQUEUE_CONFIRM_ENABLED,
  RTPQUEUE_CONFIRM_KEYWORDS,
  RTPQUEUE_CONFIRM_MATERIALS,
  RTPQUEUE_CONFIRM_OPEN_MS,
  RTPQUEUE_CONFIRM_SLOT,
  RTPQUEUE_DEBUG,
  RTPQUEUE_LOOP_GAP_MS,
  RTPQUEUE_MAX_MS,
  RTPQUEUE_MOVE_MIN,
  RTPQUEUE_PAIR_RADIUS,
  RTPQUEUE_PARTNER_SCAN_MS,
  RTPQUEUE_RESPAWN_DELAY_MS,
  RTPQUEUE_RETRY_MS,
  RTPQUEUE_SETTLE_MS,
  RTPQUEUE_WAIT_MS,
  SCAN_INTERVAL_MS,
  SERVER_HOST,
  SERVER_PORT,
  shouldLogServerChatLine,
  spellToken,
  splitDonuttySpell,
  spokenName,
  START_BOT,
  START_DELAY_MS,
  STATE_DB_FILE,
  stripMcColorCodes,
  TAB_COMPLETE_TIMEOUT_MS,
  TAB_PREFIXES,
  TPA_COMMAND,
  TPA_CONFIRM_DELAY_MS,
  TPA_CONFIRM_GUI_SLOTS,
  TPA_CONFIRM_OPEN_MS,
  TPA_CONFIRM_SLOT,
  TPA_FAIL_RE,
  TPA_LOOP_GAP_MS,
  TPA_WAIT_MS,
  TPA_WEBHOOK_INTERVAL_MS,
  tpaWebhookStats,
  truncateLine,
  VCBOTLOGS_WEBHOOK,
  VC_HANDSHAKE_STUCK_MS,
  VC_READY_TIMEOUT_MS,
  VC_RECONNECT_BASE_MS,
  VC_RECONNECT_MAX_MS,
  webhookLogger,
  WH_COLORS,
};
