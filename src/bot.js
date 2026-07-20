'use strict';
// voicebot — VoiceAdBot: join, scan players, /tpahere, confirm GUI, then run an
// AI proximity-voice conversation (Simple Voice Chat + ElevenLabs/OpenRouter).
const mineflayer = require('mineflayer');
const chalk = require('chalk');
const axios = require('axios');
const Socks = require('socks').SocksClient;
const path = require('path');
const fs = require('fs');
const { once } = require('events');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Optional voice modules (graceful no-op if native deps missing) ----
let VoiceChatClient = null;
let VoiceAI = null;
let VOICEAD_JSON_OUTPUT_INSTRUCTION = null;
let preencodeClip = null;
try { VoiceChatClient = require('./voice_chat').VoiceChatClient; } catch (_) { VoiceChatClient = null; }
try { preencodeClip = require('./voice_audio').preencodeClip; } catch (_) { preencodeClip = null; }
try {
  const va = require('./voice_ai');
  VoiceAI = va.VoiceAI;
  VOICEAD_JSON_OUTPUT_INSTRUCTION = va.VOICEAD_JSON_OUTPUT_INSTRUCTION;
} catch (_) { VoiceAI = null; }

const {
  acceptMessageMatchesTarget, ACCEPT_RADIUS, ACCEPT_RE, BASE_CONVO_PROMPT,
  BASE_PITCH_PROMPT, buildTargetPrompt, clipField, CONVO_COOLDOWN_MS,
  CONVO_IDLE_MS, CONVO_MAX_MS, CONVO_MIN_MS, CONVO_RADIUS, DEBUG_MODE,
  DEBUG_TPAHERE_TARGET, DONUTTY_PHONETIC_LETTERS, DONUTTY_SPELL_LEAD_PAUSE_MS,
  DONUTTY_SPELL_PAUSE_MS, expandSpeechForTts, findBotPlayer, guiItemText,
  isBedrockName, isWhisperLine, JAVA_USERNAME_RE, LEAVE_GRACE_MS,
  LOG_TARGET_WHISPER, MAX_DISCORD_MP3_BYTES, MC_VERSION, MSA_CACHE_PREFIX,
  MSA_LABEL, parseAcceptUsername, PENDING_TPA_MS, PITCH_DELAY_MS, REQUIRE_VC,
  RTP_AFTER_CONVO, RTP_AFTER_CONVO_MS, RTP_DIRECTIONS, RTPQUEUE_COMMAND,
  RTPQUEUE_CONFIRM_DELAY_MS, RTPQUEUE_CONFIRM_ENABLED, RTPQUEUE_CONFIRM_KEYWORDS,
  RTPQUEUE_CONFIRM_MATERIALS, RTPQUEUE_CONFIRM_OPEN_MS, RTPQUEUE_CONFIRM_SLOT,
  RTPQUEUE_DEBUG, RTPQUEUE_LOOP_GAP_MS, RTPQUEUE_MAX_MS, RTPQUEUE_MOVE_MIN,
  RTPQUEUE_PAIR_RADIUS, RTPQUEUE_PARTNER_SCAN_MS, RTPQUEUE_RESPAWN_DELAY_MS,
  RTPQUEUE_RETRY_MS, RTPQUEUE_SETTLE_MS, RTPQUEUE_WAIT_MS, SCAN_INTERVAL_MS,
  SERVER_HOST, SERVER_PORT, shouldLogServerChatLine, splitDonuttySpell,
  spokenName, stripMcColorCodes, TAB_COMPLETE_TIMEOUT_MS, TAB_PREFIXES,
  TPA_COMMAND, TPA_CONFIRM_DELAY_MS, TPA_CONFIRM_GUI_SLOTS, TPA_CONFIRM_OPEN_MS,
  TPA_CONFIRM_SLOT, TPA_FAIL_RE, TPA_LOOP_GAP_MS, TPA_WAIT_MS, tpaWebhookStats,
  truncateLine, VCBOTLOGS_WEBHOOK, VC_HANDSHAKE_STUCK_MS, VC_READY_TIMEOUT_MS,
  VC_RECONNECT_BASE_MS, VC_RECONNECT_MAX_MS, webhookLogger, WH_COLORS,
} = require('./config');
const {
  claimTarget, getBotProxy, getTriedSet, readPlayerList,
  unclaimTarget, updateTarget, writePlayerList,
} = require('./state');

// ---- Scanner election (one bot scans for the whole pool) ----
let scannerBotNumber = null;

class VoiceAdBot {
  constructor(botNumber) {
    this.botNumber = botNumber;
    this.bot = null;
    this.proxyConfig = getBotProxy(botNumber);
    this.voiceChat = null;
    this.voiceAI = null;

    this.spawned = false;
    this.stopping = false;

    // Conversation state
    this.currentTarget = null;
    this.currentTargetUuid = null;
    this.convoActive = false;
    this.lastInteractionAt = 0;

    // Discord handle for this bot's selfbot instance
    this._msgHandler = null;
    this._tpaBusy = false;
    this._debugTpaDone = false;
    this._lastTargetWasDebug = false;

    // Voice chat lifecycle
    this._vcReady = false;
    this._vcSetupAt = 0;
    this._vcReconnectTimer = null;
    this._vcReconnectInFlight = false;
    this._vcReconnectAttempts = 0;
    this._voiceAIInitialized = false;
    this._vcReplacing = false;
    this._tpaLoopSeq = 0;
    this._respawnRetryTimer = null;
    /** True while /rtpqueue was sent and we have not paired or reset yet. */
    this._rtpQueueJoined = false;
    this._rtpQueueJoinedAt = 0;
    this._requeueOnRespawn = false;
    this._rtpRejoinInFlight = false;
    /** Recent /tpahere sends — catches delayed accepts after wait timeout. */
    this._pendingTpahere = new Map();
    this._deferredAccepter = null;
    /** username(low) -> timestamp — blocks deferred/proximity re-accept after convo ends */
    this._convoFinishedAt = new Map();
    this._whLastErrAt = 0;
    this._whVcLiveAt = 0;
    this._whLastWhisperAt = 0;
  }

  /** Post a fancy Discord embed (important events only). */
  wh(title, opts = {}) {
    webhookLogger.embed(title, { botNumber: this.botNumber, ...opts });
  }

  /** Throttled error/warning embed — avoids VC reconnect spam. */
  whAlert(title, description, color = WH_COLORS.err) {
    const now = Date.now();
    if (now - this._whLastErrAt < 20_000) return;
    this._whLastErrAt = now;
    this.wh(title, { emoji: '⚠️', color, description: clipField(description, 500) });
  }

  /** Upload MP3 + caption to vcbotlogs (pool1-style attachments). */
  async uploadWebhookMp3({ content, mp3Buf, mp3Path, filename }) {
    if (!webhookLogger.enabled()) return;

    let FormData;
    try { FormData = require('form-data'); }
    catch (e) {
      this.log(`[Webhook] form-data missing — text only: ${e.message}`, 'yellow');
      webhookLogger.embed('Voice Clip', {
        botNumber: this.botNumber,
        emoji: '🎙️',
        color: WH_COLORS.talk,
        description: clipField(content, 900),
      });
      return;
    }

    const form = new FormData();
    form.append(
      'payload_json',
      JSON.stringify({
        content: clipField(content, 1800),
        username: `voicead Bot ${this.botNumber}`,
      })
    );

    if (Buffer.isBuffer(mp3Buf) && mp3Buf.length > 0) {
      if (mp3Buf.length > MAX_DISCORD_MP3_BYTES) {
        webhookLogger.embed('Clip Too Large', {
          botNumber: this.botNumber,
          emoji: '📦',
          color: WH_COLORS.warn,
          description: clipField(content, 900),
        });
        return;
      }
      form.append('files[0]', mp3Buf, {
        filename: filename || `clip_${Date.now()}.mp3`,
        contentType: 'audio/mpeg',
      });
    } else if (mp3Path && fs.existsSync(mp3Path)) {
      const size = fs.statSync(mp3Path).size;
      if (size > MAX_DISCORD_MP3_BYTES) {
        webhookLogger.embed('Clip Too Large', {
          botNumber: this.botNumber,
          emoji: '📦',
          color: WH_COLORS.warn,
          description: `${clipField(content, 800)}\nSaved: \`${path.basename(mp3Path)}\``,
        });
        return;
      }
      form.append('files[0]', fs.createReadStream(mp3Path), {
        filename: filename || path.basename(mp3Path),
        contentType: 'audio/mpeg',
      });
    } else {
      webhookLogger.embed('Voice Event', {
        botNumber: this.botNumber,
        emoji: '🎙️',
        color: WH_COLORS.talk,
        description: clipField(content, 900),
      });
      return;
    }

    try {
      await axios.post(VCBOTLOGS_WEBHOOK, form, {
        headers: form.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 30_000,
      });
    } catch (e) {
      const st = e.response?.status;
      this.log(`[Webhook] mp3 upload failed (${st || '?'})`, 'yellow');
    }
  }

  /** Bot TTS reply MP3 — same idea as pool1 uploadAiReplyToWebhook. */
  async uploadAiReplyToWebhook(info) {
    if (!info || !info.username || !Buffer.isBuffer(info.mp3Buf)) return;

    const isScripted = info.scenario === 'scripted';
    const seconds = ((info.durationMs || 0) / 1000).toFixed(1);
    const transcripts = Array.isArray(info.transcripts) ? info.transcripts : [info.transcript];
    const merged = info.mergedCount > 1 ? ` (merged ${info.mergedCount} clips)` : '';

    let heardBlock = '';
    if (!isScripted && transcripts.filter(Boolean).length) {
      const heard = transcripts.length > 1
        ? transcripts.map((t, i) => `> ${i + 1}. ${truncateLine(t, 200)}`).join('\n')
        : `> ${truncateLine(transcripts[0], 400)}`;
      heardBlock = `**Heard:**\n${heard}\n`;
    }

    const content =
      `${isScripted ? '🎯 **Main pitch**' : '🤖 **AI reply**'} to **${info.username}** ` +
      `(${seconds}s)${merged}\n${heardBlock}**Said:** ${truncateLine(info.reply, 400)}`;

    const safeName = String(info.username).replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 32) || 'player';
    await this.uploadWebhookMp3({
      content,
      mp3Buf: info.mp3Buf,
      filename: `ai_reply_${Date.now()}_${safeName}.mp3`,
    });
  }

  /** Player VC clip MP3 from voice_chat recording. */
  async uploadPlayerClipToWebhook(info) {
    if (!info || !info.username || !info.mp3Path) return;
    if (!fs.existsSync(info.mp3Path)) return;

    const seconds = ((info.durationMs || 0) / 1000).toFixed(1);
    const content =
      `🎙️ **${info.username}** spoke in proximity VC (${seconds}s)\n` +
      `Bot: \`${this.bot?.username || '?'}\``;

    await this.uploadWebhookMp3({
      content,
      mp3Path: info.mp3Path,
      filename: path.basename(info.mp3Path),
    });
  }

  log(msg, color = 'white') {
    const line = `[Bot ${this.botNumber}] ${msg}`;
    const fn = chalk[color] || chalk.white;
    console.log(fn(line));
  }

  async start() {
    if (!this.proxyConfig) {
      this.log('no proxy — not starting', 'red');
      return;
    }
    this.connect();
  }

  connect() {
    this.spawned = false;
    this._tpaLoopSeq++;
    this._rtpQueueJoined = false;
    this._rtpQueueJoinedAt = 0;
    const cacheFolder = `./.msa-cache-${MSA_CACHE_PREFIX}-${this.botNumber}`;
    this.log(`connecting via proxy ${this.proxyConfig.host}:${this.proxyConfig.port} (cache ${cacheFolder})`, 'cyan');

    try {
      this.bot = mineflayer.createBot({
        host: SERVER_HOST,
        port: SERVER_PORT,
        version: MC_VERSION,
        auth: 'microsoft',
        flow: 'sisu',
        username: MSA_LABEL,
        profilesFolder: cacheFolder,
        viewDistance: 'tiny',
        respawn: true,
        connect: (client) => {
          Socks.createConnection({
            proxy: {
              host: this.proxyConfig.host,
              port: this.proxyConfig.port,
              type: 5,
              userId: this.proxyConfig.userId,
              password: this.proxyConfig.password,
            },
            command: 'connect',
            destination: { host: SERVER_HOST, port: SERVER_PORT },
            timeout: 15_000,
          }, (err, info) => {
            if (err) {
              this.log(`proxy connect failed: ${err.message}`, 'red');
              this.whAlert('Proxy Failed', err.message, WH_COLORS.err);
              this.scheduleReconnect();
              return;
            }
            client.setSocket(info.socket);
            client.emit('connect');
          });
        },
        onMsaCode: (code) => {
          if (code && code.user_code) {
            this.log(`MSA device code needed (cache invalid): ${code.verification_uri} ${code.user_code}`, 'yellow');
            this.wh('Auth Required', {
              emoji: '🔑',
              color: WH_COLORS.warn,
              description: 'Microsoft login cache expired — link a fresh session.',
              fields: [
                { name: 'URL', value: code.verification_uri || '?', inline: false },
                { name: 'Code', value: `\`${code.user_code}\``, inline: true },
              ],
            });
          }
        },
      });
    } catch (e) {
      this.log(`createBot threw: ${e.message}`, 'red');
      this.whAlert('Bot Create Failed', e.message);
      this.scheduleReconnect();
      return;
    }

    this.wireBotEvents();
  }

  wireBotEvents() {
    const bot = this.bot;

    bot.once('spawn', () => {
      this.spawned = true;
      poolBotUsernames.add((bot.username || '').toLowerCase());
      this.log(`spawned as ${bot.username}`, 'green');
      this.wh('Bot Online', {
        emoji: '✅',
        color: WH_COLORS.ok,
        description: `**\`${bot.username}\`** is in-game and recruiting.`,
        fields: [
          { name: '🌐 Proxy', value: `\`${this.proxyConfig.host}:${this.proxyConfig.port}\``, inline: false },
        ],
      });

      this.initVoice();
      this.maybeBecomeScanner();
      this.rtpqueueLoop().catch((e) => {
        this.log(`rtpqueueLoop crashed: ${e.message}`, 'red');
        this.whAlert('RTPQueue Loop Crashed', e.message);
      });
      this.scanLoop().catch((e) => {
        this.log(`scanLoop crashed: ${e.message}`, 'red');
        this.whAlert('Scan Loop Crashed', e.message);
      });
    });

    // Server/system chat logging + whisper capture for the active target.
    this._msgHandler = (message) => {
      try {
        const line = String(message);
        this.logIncomingChat(line);
        this.onChat(line);
      } catch (_) {}
    };
    bot.on('messagestr', this._msgHandler);

    bot.on('kicked', (reason) => {
      const r = typeof reason === 'string' ? reason : JSON.stringify(reason);
      this.log(`kicked: ${r}`, 'red');
      this.wh('Kicked', { emoji: '👢', color: WH_COLORS.err, description: clipField(r, 800) });
    });
    bot.on('error', (err) => {
      this.log(`error: ${err.message}`, 'red');
    });
    bot.on('death', () => {
      this.log('died — sending respawn immediately', 'red');
      this.wh('Bot Died', {
        emoji: '💀',
        color: WH_COLORS.err,
        description: this.convoActive && this.currentTarget
          ? `Died mid-conversation with **\`${this.currentTarget}\`** — auto-respawning`
          : 'Auto-respawning now',
      });
      if (this.convoActive) {
        this.convoActive = false;
        this.currentTarget = null;
        this.currentTargetUuid = null;
      }
      this._tpaBusy = false;
      this._leaveRtpQueue();
      this._requeueOnRespawn = true;
      this.forceRespawn();
    });
    bot.on('respawn', () => {
      this.log('respawned', 'green');
      this.clearRespawnRetry();
      this.wh('Respawned', { emoji: '♻️', color: WH_COLORS.ok, description: 'Back in-game' });
      void this.rejoinRtpQueueAfterRespawn();
    });
    bot.on('end', (reason) => {
      this.log(`disconnected: ${reason}`, 'yellow');
      this.wh('Disconnected', {
        emoji: '🔌',
        color: WH_COLORS.warn,
        description: clipField(String(reason || 'unknown'), 800),
      });
      this.cleanupOnEnd();
      this.scheduleReconnect();
    });
  }

  cleanupOnEnd() {
    this.spawned = false;
    this.convoActive = false;
    this.currentTarget = null;
    this.currentTargetUuid = null;
    this._tpaBusy = false;
    this._debugTpaDone = false;
    this._lastTargetWasDebug = false;
    this._vcReady = false;
    this._vcSetupAt = 0;
    this._vcReconnectAttempts = 0;
    if (this._vcReconnectTimer) {
      clearTimeout(this._vcReconnectTimer);
      this._vcReconnectTimer = null;
    }
    this.clearRespawnRetry();
    if (scannerBotNumber === this.botNumber) scannerBotNumber = null;
    try { if (this.voiceChat) this.voiceChat.destroy('bot_end'); } catch (_) {}
    this.voiceChat = null;
    this.voiceAI = null;
    this._voiceAIInitialized = false;
  }

  clearRespawnRetry() {
    if (this._respawnRetryTimer) {
      clearInterval(this._respawnRetryTimer);
      this._respawnRetryTimer = null;
    }
  }

  /** Send client_command respawn immediately; retry until alive or cap. */
  forceRespawn() {
    const bot = this.bot;
    if (!bot || bot.isAlive) return;

    const send = () => {
      try { bot.respawn(); } catch (_) {}
    };
    send();

    this.clearRespawnRetry();
    let attempts = 0;
    this._respawnRetryTimer = setInterval(() => {
      if (!this.bot || this.bot.isAlive || attempts >= 10) {
        this.clearRespawnRetry();
        return;
      }
      attempts++;
      send();
    }, 200);
  }

  scheduleReconnect() {
    if (this.stopping) return;
    const delay = 30_000 + Math.floor(Math.random() * 30_000); // 30-60s
    this.log(`reconnecting in ${Math.round(delay / 1000)}s`, 'yellow');
    setTimeout(() => {
      try { if (this.bot) this.bot.removeAllListeners(); } catch (_) {}
      this.connect();
    }, delay);
  }

  // ---------- Voice ----------
  /** Build proxy/recording options shared by setup + reconnect. */
  _voiceChatOptions() {
    const compatVersion = parseInt(process.env.SVC_COMPAT_VERSION || '20', 10) || 20;
    const debug = (process.env.VC_DEBUG || '').toLowerCase() === 'true';
    const useProxyUdp = (process.env.USE_PROXY_UDP || 'true').toLowerCase() !== 'false';
    const proxyOpt = (useProxyUdp && this.proxyConfig)
      ? {
          host: this.proxyConfig.host,
          port: this.proxyConfig.port,
          userId: this.proxyConfig.userId,
          password: this.proxyConfig.password,
        }
      : null;

    const uuidMatchesTarget = (uuid) => {
      if (!uuid || !this.currentTargetUuid) return false;
      const a = String(uuid).replace(/-/g, '').toLowerCase();
      const b = String(this.currentTargetUuid).replace(/-/g, '').toLowerCase();
      return a === b;
    };

    const normalizeUuid = (uuid) => String(uuid || '').replace(/-/g, '').toLowerCase();

    const shouldInterruptFn = (uuid) => {
      if (!uuid || !this.currentTarget) return null;
      return uuidMatchesTarget(uuid) ? this.currentTarget : null;
    };

    const shouldRecordFn = (uuid) => {
      if (!uuid || !this.currentTarget) return null;
      if (uuidMatchesTarget(uuid)) return this.currentTarget;
      if (!this.bot || !this.bot.players) return null;
      try {
        const want = this.currentTarget.toLowerCase();
        const packetUuid = normalizeUuid(uuid);
        for (const name of Object.keys(this.bot.players)) {
          const p = this.bot.players[name];
          if (!p || !p.uuid) continue;
          if (normalizeUuid(p.uuid) !== packetUuid) continue;
          if (name.toLowerCase() !== want) return null;
          // Backfill uuid cache if tab list loaded after convo start.
          if (!this.currentTargetUuid) {
            this.currentTargetUuid = packetUuid;
            this.log(`[VC] backfilled target uuid from voice packet (${packetUuid.slice(0, 8)}...)`, 'gray');
          }
          return name;
        }
      } catch (_) { return null; }
      return null;
    };

    return {
      compatVersion,
      debug,
      proxyOpt,
      clientOpts: {
        compatVersion,
        botTag: `[Bot ${this.botNumber}]`,
        debug,
        fallbackHost: (this.bot._client && this.bot._client.socket && this.bot._client.socket.remoteAddress) || null,
        proxy: proxyOpt,
        playbackFrameMs: parseInt(process.env.VOICEAD_PLAYBACK_FRAME_MS || '20', 10) || 20,
        recording: {
          enabled: true,
          shouldRecord: shouldRecordFn,
          shouldInterrupt: shouldInterruptFn,
          outputDir: process.env.ADMIN_RECORD_DIR || './mp3_voice/voicead_recorded',
          silenceMs: parseInt(process.env.VOICEAD_RECORD_SILENCE_MS || process.env.ADMIN_RECORD_SILENCE_MS || '900', 10) || 900,
          maxClipMs: parseInt(process.env.ADMIN_RECORD_MAX_MS || '30000', 10) || 30_000,
          minClipMs: parseInt(process.env.VOICEAD_RECORD_MIN_MS || process.env.ADMIN_RECORD_MIN_MS || '400', 10) || 400,
        },
      },
    };
  }

  /** Wire connected/error/closed/adminVoiceClip handlers on a VoiceChatClient. */
  _bindVoiceChatEvents(vc) {
    vc.removeAllListeners('error');
    vc.removeAllListeners('connected');
    vc.removeAllListeners('closed');
    vc.removeAllListeners('adminSpeechStart');
    vc.removeAllListeners('adminVoiceClip');

    vc.on('error', (err) => {
      this._vcReady = false;
      this.log(`[VC] ${err.message}`, 'yellow');
      this.whAlert('Voice Error', err.message, WH_COLORS.vc);
      if (this._vcReplacing || this._vcReconnectInFlight) return;
      this.scheduleVcReconnect(String(err.message || 'error'));
    });
    vc.on('connected', () => {
      this._vcReady = true;
      this._vcReconnectAttempts = 0;
      this.log('[VC] connected', 'green');
      const now = Date.now();
      if (now - this._whVcLiveAt > 45_000) {
        this._whVcLiveAt = now;
        this.wh('Voice Live', {
          emoji: '🎙️',
          color: WH_COLORS.vc,
          description: 'Simple Voice Chat UDP session is **connected**.',
        });
      }
    });
    vc.on('closed', (reason) => {
      this._vcReady = false;
      if (this._vcReplacing) return;
      if (this.spawned && !this.stopping) {
        this.scheduleVcReconnect(String(reason || 'closed'));
      }
    });
    vc.on('adminSpeechStart', (info) => {
      if (this.currentTarget && info.username &&
          info.username.toLowerCase() === this.currentTarget.toLowerCase()) {
        if (this.voiceAI) this.voiceAI.handleAdminSpeechStart(info.username);
      }
    });
    vc.on('adminSpeechEnd', (info) => {
      if (this.currentTarget && info.username &&
          info.username.toLowerCase() === this.currentTarget.toLowerCase()) {
        if (this.voiceAI) this.voiceAI.handleAdminSpeechEnd(info.username);
      }
    });
    vc.on('adminVoiceClip', (info) => {
      if (this.currentTarget && info.username &&
          info.username.toLowerCase() === this.currentTarget.toLowerCase()) {
        this.lastInteractionAt = Date.now();
      }
      this.uploadPlayerClipToWebhook(info).catch((e) => {
        this.log(`[Webhook] player clip upload: ${e.message}`, 'yellow');
      });
      if (this.voiceAI && this.voiceAI.isEnabled()) {
        this.voiceAI.handleAdminClip(info).catch((e) => this.log(`[VoiceAI] ${e.message}`, 'red'));
      }
    });
  }

  /** Create (or replace) the VoiceChatClient and start the SVC handshake. */
  setupVoiceChat() {
    if (!VoiceChatClient || !this.bot || !this.bot._client) return false;

    const { clientOpts } = this._voiceChatOptions();
    try {
      if (this.voiceChat) {
        this._vcReplacing = true;
        try { this.voiceChat.destroy('replace'); } catch (_) {}
        this._vcReplacing = false;
      }

      this.voiceChat = new VoiceChatClient(this.bot, clientOpts);
      this._bindVoiceChatEvents(this.voiceChat);
      this._vcReady = false;
      this._vcSetupAt = Date.now();
      this.voiceChat.init();
      return true;
    } catch (e) {
      this._vcReplacing = false;
      this.log(`[VC] setup failed: ${e.message}`, 'red');
      this.whAlert('Voice Setup Failed', e.message, WH_COLORS.vc);
      this.voiceChat = null;
      this._vcReady = false;
      return false;
    }
  }

  scheduleVcReconnect(reason) {
    if (this._tpaBusy) return; // don't tear down VC mid-TPA confirm/wait
    if (this._vcReconnectTimer || this._vcReconnectInFlight || this.stopping || !this.spawned) {
      return;
    }
    const delay = Math.min(
      VC_RECONNECT_MAX_MS,
      VC_RECONNECT_BASE_MS + this._vcReconnectAttempts * 2_000
    );
    this._vcReconnectAttempts++;
    this.log(`[VC] reconnect scheduled in ${delay}ms (${reason})`, 'yellow');
    this._vcReconnectTimer = setTimeout(() => {
      this._vcReconnectTimer = null;
      this.reconnectVoiceChat(reason).catch((e) => {
        this.log(`[VC] reconnect failed: ${e.message}`, 'red');
        this.whAlert('Voice Reconnect Failed', e.message, WH_COLORS.vc);
        this.scheduleVcReconnect('retry');
      });
    }, delay);
  }

  /** Tear down and re-create the SVC client; re-bind VoiceAI if already running. */
  async reconnectVoiceChat(reason = 'manual') {
    if (this._vcReconnectInFlight || !this.spawned || !this.bot || !this.bot.entity) {
      return false;
    }
    this._vcReconnectInFlight = true;
    this._vcReady = false;
    try {
      this.log(`[VC] reconnecting (${reason})...`, 'cyan');
      if (!this.setupVoiceChat()) return false;
      if (this.voiceAI) this.voiceAI.setVoiceChat(this.voiceChat);

      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (!this.spawned) return false;
        if (this.voiceChat && this.voiceChat.isReady()) {
          this._vcReady = true;
          this.log('[VC] reconnect OK — voice ready', 'green');
          return true;
        }
        await sleep(400);
      }
      this.log('[VC] reconnect handshake did not finish in 20s', 'yellow');
      return false;
    } finally {
      this._vcReconnectInFlight = false;
    }
  }

  /**
   * Block until SVC is connected (or REQUIRE_VC=false). Retries handshake
   * if stuck in awaiting_secret. Used by tpaLoop before sending /tpahere.
   */
  async waitForVoiceChatReady(maxWaitMs = VC_READY_TIMEOUT_MS) {
    if (!VoiceChatClient || !REQUIRE_VC) return true;

    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      if (!this.spawned || !this.bot || !this.bot.entity) return false;

      if (this.voiceChat && this.voiceChat.isReady()) {
        this._vcReady = true;
        return true;
      }

      const state = this.voiceChat && this.voiceChat.state;
      const stuckMs = Date.now() - (this._vcSetupAt || 0);

      if (!this.voiceChat || state === 'closed') {
        await this.reconnectVoiceChat('not_ready');
      } else if (
        (state === 'awaiting_secret' || state === 'authenticating' || state === 'connecting') &&
        stuckMs >= VC_HANDSHAKE_STUCK_MS &&
        !this._vcReconnectInFlight
      ) {
        await this.reconnectVoiceChat(`stuck_${state}`);
      } else if (!this.voiceChat && !this._vcReconnectInFlight) {
        this.setupVoiceChat();
        if (this.voiceAI) this.voiceAI.setVoiceChat(this.voiceChat);
      }

      await sleep(500);
    }

    this.log(`[VC] not ready after ${Math.round(maxWaitMs / 1000)}s — still waiting before /tpahere`, 'yellow');
    return !!(this.voiceChat && this.voiceChat.isReady());
  }

  initVoice() {
    if (!VoiceChatClient) {
      this.log('voice_chat module unavailable — voice disabled', 'yellow');
      return;
    }
    this.setupVoiceChat();
    this.initVoiceAI();
  }

  initVoiceAI() {
    if (this._voiceAIInitialized) {
      if (this.voiceAI && this.voiceChat) this.voiceAI.setVoiceChat(this.voiceChat);
      return;
    }
    if (!VoiceAI || !this.voiceChat) {
      this.log('[VoiceAI] disabled (module or VC unavailable)', 'yellow');
      return;
    }
    const num = (k, def) => {
      const v = parseFloat(process.env[k]);
      return Number.isFinite(v) ? v : def;
    };
    try {
      this.voiceAI = new VoiceAI({
        botTag: `[Bot ${this.botNumber}]`,
        elevenApiKey: process.env.ELEVENLABS_API_KEY,
        voiceId: process.env.ELEVENLABS_VOICE_ID,
        ttsModel: process.env.ELEVENLABS_TTS_MODEL || 'eleven_flash_v2_5',
        ttsLanguageCode: (process.env.ELEVENLABS_LANGUAGE_CODE || 'en').trim() || 'en',
        spellStability: num('VOICEAD_SPELL_STABILITY', 0.78),
        spellStyle: num('VOICEAD_SPELL_STYLE', 0),
        sttModel: process.env.ELEVENLABS_STT_MODEL || 'scribe_v1',
        openRouterKey: process.env.OPENROUTER_API_KEY,
        llmModel: process.env.OPENROUTER_MODEL || 'openai/gpt-5.2',
        voiceChat: this.voiceChat,
        // Base reactive prompt; overridden per target in startConversation().
        systemPrompt: BASE_CONVO_PROMPT,
        // ---- SNAPPY CONVERSATION PACING ----
        debounceSec: num('VOICEAD_DEBOUNCE_S', 0.6),         // wait after they stop talking
        debounceMaxWaitSec: num('VOICEAD_DEBOUNCE_MAX_WAIT_S', 4),
        minReplyGapSec: num('VOICEAD_MIN_REPLY_GAP_S', 0.5), // min pause between bot replies
        maxBufferedClips: num('VOICEAD_MAX_BUFFERED_CLIPS', 3),
        replyWindowSec: num('VOICEAD_REPLY_WINDOW_S', 300),
        replyWindowCap: num('VOICEAD_REPLY_WINDOW_CAP', 100),
        historyTurns: num('VOICEAD_HISTORY_TURNS', 12),
        thinkDelayMinSec: num('VOICEAD_THINK_DELAY_MIN_S', 0),
        thinkDelayMaxSec: num('VOICEAD_THINK_DELAY_MAX_S', 0),
        replyDelayCapMs: num('VOICEAD_REPLY_DELAY_CAP_MS', 0),
        jsonOutputInstruction: VOICEAD_JSON_OUTPUT_INSTRUCTION,
        maxReplyChars: num('VOICEAD_MAX_REPLY_CHARS', 180),
        stability: num('ELEVENLABS_STABILITY', 0.55),
        similarityBoost: num('ELEVENLABS_SIMILARITY_BOOST', 0.85),
        style: num('ELEVENLABS_STYLE', 0.12),
        replyPreprocessor: expandSpeechForTts,
        donuttySpellSplit: splitDonuttySpell,
        donuttySpellLetters: DONUTTY_PHONETIC_LETTERS,
        donuttySpellPauseMs: DONUTTY_SPELL_PAUSE_MS,
        donuttySpellLeadPauseMs: DONUTTY_SPELL_LEAD_PAUSE_MS,
        donuttySpellSingleCall: true,
        onReplyGenerated: (info) => {
          this.uploadAiReplyToWebhook(info).catch((e) => {
            this.log(`[Webhook] ai reply upload: ${e.message}`, 'yellow');
          });
        },
      });
      if (this.voiceAI.isEnabled()) {
        this._voiceAIInitialized = true;
        this.log('[VoiceAI] enabled (conversation mode)', 'green');
      } else {
        this.voiceAI = null;
      }
    } catch (e) {
      this.log(`[VoiceAI] init failed: ${e.message}`, 'red');
      this.voiceAI = null;
    }
  }

  // ---------- Chat logging / whisper capture ----------
  /**
   * Log server/system lines to console; suppress public player chat spam.
   * During an active conversation, optionally log whispers from the current
   * target (useful for /msg replies — not the same as tab chat flood).
   */
  logIncomingChat(raw) {
    const plain = stripMcColorCodes(raw).trim();
    if (!plain) return;

    if (shouldLogServerChatLine(raw)) {
      // Highlight TPA / teleport outcomes — they're the main thing we care about.
      const low = plain.toLowerCase();
      let color = 'gray';
      if (ACCEPT_RE.test(plain) || /teleport/i.test(plain)) color = 'green';
      else if (TPA_FAIL_RE.test(plain) || /cannot|can't|cooldown|denied|failed/i.test(low)) color = 'yellow';
      else if (/warning|error|banned|kick/i.test(low)) color = 'red';
      this.log(`[Server] ${plain}`, color);
      return;
    }

    if (LOG_TARGET_WHISPER && this.convoActive && this.currentTarget && isWhisperLine(raw)) {
      const parsed = this.parseWhisper(raw);
      if (parsed && parsed.from.toLowerCase() === this.currentTarget.toLowerCase()) {
        this.log(`[Whisper] ${parsed.from}: ${parsed.text}`, 'cyan');
        const now = Date.now();
        if (now - this._whLastWhisperAt >= 10_000) {
          this._whLastWhisperAt = now;
          this.wh('Player Whispered', {
            emoji: '💬',
            color: WH_COLORS.talk,
            description: `**\`${parsed.from}\`** → bot`,
            fields: [{ name: 'Message', value: clipField(parsed.text, 900), inline: false }],
          });
        }
      }
    }
  }

  onChat(message) {
    if (!this.convoActive) {
      const pendingAccept = this._findAcceptFromPending(String(message));
      if (pendingAccept && this._shouldStartConvoWith(pendingAccept)) {
        this._deferredAccepter = pendingAccept;
      }
    }
    if (!this.currentTarget || !this.convoActive) return;
    const target = this.currentTarget;
    const parsed = this.parseWhisper(message);
    if (parsed && parsed.from.toLowerCase() === target.toLowerCase() && parsed.text) {
      this.lastInteractionAt = Date.now();
      if (this.voiceAI && this.voiceAI.isEnabled()) {
        this.voiceAI.handleTextInput({ username: target, text: parsed.text })
          .catch((e) => this.log(`[VoiceAI] text ${e.message}`, 'red'));
      }
    }
  }

  /** Best-effort whisper parser for common DonutSMP / vanilla formats. */
  parseWhisper(message) {
    const patterns = [
      /^([A-Za-z0-9_]{3,16}) whispers(?: to you)?:\s*(.+)$/i,
      /^([A-Za-z0-9_]{3,16}) whispers:\s*(.+)$/i,
      /^\[?([A-Za-z0-9_]{3,16}) ?-?>? ?(?:me|you)\]?:?\s*(.+)$/i,
      /^From ([A-Za-z0-9_]{3,16}):\s*(.+)$/i,
    ];
    for (const re of patterns) {
      const m = message.match(re);
      if (m) return { from: m[1], text: m[2].trim() };
    }
    return null;
  }

  // ---------- Scanner ----------
  maybeBecomeScanner() {
    if (scannerBotNumber === null) {
      scannerBotNumber = this.botNumber;
      this.log('elected as pool scanner', 'magenta');
    }
  }

  async scanLoop() {
    while (!this.stopping && this.bot && this.bot._client) {
      if (scannerBotNumber === null && this.spawned) this.maybeBecomeScanner();

      if (scannerBotNumber === this.botNumber && this.bot && this.bot.entity) {
        try {
          await this.runScan();
        } catch (e) {
          this.log(`[Scanner] scan error: ${e.message}`, 'yellow');
        }
        await sleep(SCAN_INTERVAL_MS);
      } else {
        await sleep(15_000);
      }
    }
  }

  async runScan() {
    const started = Date.now();
    const found = new Set();

    // Seed from currently visible tab-list players.
    for (const name of Object.keys(this.bot.players || {})) found.add(name);

    // Tab-complete /msg <prefix> across a-z 0-9 _ (same as donut1.js).
    for (const prefix of TAB_PREFIXES) {
      if (!this.bot || !this.bot.entity) break;
      try {
        const matches = await this.bot.tabComplete(`/msg ${prefix}`, true, false, TAB_COMPLETE_TIMEOUT_MS);
        for (const m of matches || []) {
          const name = typeof m === 'string' ? m : (m && (m.match || m.text));
          if (name) found.add(name);
        }
      } catch (_) {
        // A prefix timing out is fine — keep going.
      }
    }

    const java = [];
    for (const name of found) {
      if (!name || name.startsWith('.')) continue;          // skip Bedrock
      if (!JAVA_USERNAME_RE.test(name)) continue;
      if (name.toLowerCase() === (this.bot.username || '').toLowerCase()) continue;
      if (poolBotUsernames.has(name.toLowerCase())) continue; // skip our own pool
      java.push(name);
    }
    java.sort();
    writePlayerList(java);

    this.log(
      `[Scanner] scan done in ${((Date.now() - started) / 1000).toFixed(1)}s — ${java.length} Java players -> player_list.txt`,
      'green'
    );
    this.wh('Player Scan', {
      emoji: '📋',
      color: WH_COLORS.scan,
      description: `Refreshed **player_list.txt**`,
      fields: [
        { name: 'Java players', value: `**${java.length.toLocaleString()}**`, inline: true },
        { name: 'Duration', value: `${((Date.now() - started) / 1000).toFixed(1)}s`, inline: true },
      ],
    });
  }

  // ---------- TPA loop ----------
  /**
   * Wait for a chest/GUI window after /tpahere. Donut opens a 27-slot
   * confirm screen — same layout sethome1.js uses (confirm = slot 16).
   */
  async waitForWindowOpen(timeoutMs = TPA_CONFIRM_OPEN_MS) {
    const bot = this.bot;
    if (!bot) return null;
    if (bot.currentWindow) return bot.currentWindow;
    try {
      const win = await Promise.race([
        once(bot, 'windowOpen').then(([w]) => w),
        sleep(timeoutMs).then(() => null),
      ]);
      return win || bot.currentWindow || null;
    } catch (_) {
      return bot.currentWindow || null;
    }
  }

  /** Click slot 16 on Donut's outgoing /tpahere confirm GUI. */
  async confirmTpahereGui(target) {
    const bot = this.bot;
    if (!bot || !bot.entity) return false;

    const win = await this.waitForWindowOpen(TPA_CONFIRM_OPEN_MS);
    if (!win) {
      this.log(`[TPA] no confirm GUI opened for ${target}`, 'yellow');
      return false;
    }

    const slotCount = win.slots ? win.slots.length : 0;
    const title = typeof win.title === 'string'
      ? win.title
      : (win.title && win.title.text) || '';

    // Donut TPA confirm is 27 slots (3 rows). Accept near-matches in case
    // the server adds/removes a decorative row.
    if (slotCount > 0 && slotCount < 17) {
      this.log(`[TPA] unexpected GUI (${slotCount} slots, title="${title}") — not clicking`, 'yellow');
      return false;
    }
    if (slotCount > 0 && slotCount !== TPA_CONFIRM_GUI_SLOTS) {
      this.log(`[TPA] GUI has ${slotCount} slots (expected ${TPA_CONFIRM_GUI_SLOTS}) — still clicking slot ${TPA_CONFIRM_SLOT}`, 'gray');
    } else {
      this.log(`[TPA] confirm GUI opened (${slotCount || '?'} slots) — clicking slot ${TPA_CONFIRM_SLOT}`, 'cyan');
    }

    await sleep(TPA_CONFIRM_DELAY_MS);

    try {
      const item = bot.currentWindow && bot.currentWindow.slots[TPA_CONFIRM_SLOT];
      if (!item) {
        this.log(`[TPA] slot ${TPA_CONFIRM_SLOT} is empty — clicking anyway`, 'yellow');
      }
      await bot.clickWindow(TPA_CONFIRM_SLOT, 0, 0);
      this.log(`[TPA] confirm clicked for ${target}`, 'green');
      await sleep(350);

      if (bot.currentWindow) {
        try { await bot.closeWindow(bot.currentWindow); } catch (_) {}
      }
      return true;
    } catch (e) {
      this.log(`[TPA] confirm click failed: ${e.message}`, 'red');
      return false;
    }
  }

  /** Send /tpahere and click through Donut's outgoing confirm GUI. */
  async sendTpahereWithConfirm(target) {
    if (!this.bot || !this.bot.entity) return { sent: false, confirmed: false };

    this.log(`${TPA_COMMAND} ${target}`, 'cyan');
    try {
      this.bot.chat(`${TPA_COMMAND} ${target}`);
    } catch (e) {
      this.log(`failed to send tpahere: ${e.message}`, 'red');
      return { sent: false, confirmed: false };
    }

    const confirmed = await this.confirmTpahereGui(target);
    if (!confirmed) {
      this.log(`[TPA] request may not have been sent — confirm GUI was not handled`, 'yellow');
    }
    return { sent: true, confirmed };
  }

  async rtpqueueLoop() {
    const loopId = this._tpaLoopSeq;
    const alive = () => loopId === this._tpaLoopSeq && !this.stopping;

    if (VoiceChatClient && REQUIRE_VC) {
      this.log('[VC] waiting for voice chat to connect before /rtpqueue...', 'cyan');
      while (alive() && this.bot && this.bot._client) {
        if (await this.waitForVoiceChatReady(VC_READY_TIMEOUT_MS)) break;
        if (!alive() || !this.spawned) return;
        this.log('[VC] still not ready — retrying handshake...', 'yellow');
        await sleep(VC_RECONNECT_BASE_MS);
      }
      if (!alive()) return;
      this.log('[VC] voice ready — starting /rtpqueue loop', 'green');
    } else {
      await sleep(3000);
    }

    while (alive() && this.bot && this.bot._client) {
      if (!this.spawned || !this.bot.entity || this.convoActive || this._tpaBusy) {
        await sleep(2000);
        continue;
      }

      if (VoiceChatClient && REQUIRE_VC && !(this.voiceChat && this.voiceChat.isReady())) {
        this.log('[VC] dropped — waiting before next /rtpqueue', 'yellow');
        const ok = await this.waitForVoiceChatReady(VC_READY_TIMEOUT_MS);
        if (!ok) {
          await sleep(VC_RECONNECT_BASE_MS);
          continue;
        }
      }

      this._tpaBusy = true;
      let partner = null;
      try {
        partner = await this.waitForRtpQueuePartner();
      } catch (e) {
        this.log(`[RTPQueue] error: ${e.message}`, 'red');
      }

      if (!this.spawned) {
        this._tpaBusy = false;
        continue;
      }

      if (!partner) {
        if (this._rtpQueueJoined) {
          const queuedSec = Math.round((Date.now() - this._rtpQueueJoinedAt) / 1000);
          this.log(`[RTPQueue] still in queue (${queuedSec}s) — listening for teleport…`, 'gray');
        } else {
          this.log('[RTPQueue] no match — will re-join queue', 'gray');
          await sleep(RTPQUEUE_RETRY_MS);
        }
        this._tpaBusy = false;
        continue;
      }

      this._leaveRtpQueue();

      this.log(`${partner} paired — starting conversation`, 'green');
      this.wh('RTPQueue Paired', {
        emoji: '🤝',
        color: WH_COLORS.ok,
        description: `**\`${partner}\`** matched via rtpqueue — starting voice convo`,
        fields: [{ name: 'Spoken name', value: spokenName(partner), inline: true }],
      });

      await this.runConversation(partner);
      this._tpaBusy = false;
      await sleep(RTPQUEUE_LOOP_GAP_MS);
    }
  }

  /** Resolve tab-list username for a mineflayer entity id. */
  findPlayerNameByEntityId(entityId) {
    try {
      for (const name of Object.keys(this.bot.players || {})) {
        const p = this.bot.players[name];
        if (p?.entity?.id === entityId) return name;
      }
      const ent = this.bot.entities?.[entityId];
      if (ent?.username) return ent.username;
    } catch (_) {}
    return null;
  }

  entityPosFromTeleportPacket(packet) {
    if (this.bot?.supportFeature?.('doublePosition')) {
      return { x: packet.x, y: packet.y, z: packet.z };
    }
    return { x: packet.x / 32, y: packet.y / 32, z: packet.z / 32 };
  }

  /**
   * Nearest eligible Java player within radius (for rtpqueue pairing).
   * Skips self, pool bots, and Bedrock players (Geyser "." name prefix).
   */
  findNearestOtherPlayer(radius, { exclude = null } = {}) {
    try {
      if (!this.bot?.entity) return null;
      const self = (this.bot.username || '').toLowerCase();
      const skip = new Set((exclude || []).map((n) => String(n).toLowerCase()));
      let best = null;
      let bestDist = Infinity;
      for (const name of Object.keys(this.bot.players || {})) {
        const low = name.toLowerCase();
        if (low === self || poolBotUsernames.has(low) || skip.has(low)) continue;
        if (isBedrockName(name)) continue;
        const ent = this.bot.players[name]?.entity;
        if (!ent) continue;
        const d = this.bot.entity.position.distanceTo(ent.position);
        if (d <= radius && d < bestDist) {
          bestDist = d;
          best = name;
        }
      }

      // Spawned entities not yet linked in tab list.
      for (const entity of Object.values(this.bot.entities || {})) {
        if (!entity || entity === this.bot.entity) continue;
        const name = entity.username || entity.name;
        if (!name || typeof name !== 'string') continue;
        const low = name.toLowerCase();
        if (low === self || poolBotUsernames.has(low) || skip.has(low)) continue;
        if (isBedrockName(name)) continue;
        if (best && best.toLowerCase() === low) continue;
        const d = this.bot.entity.position.distanceTo(entity.position);
        if (d <= radius && d < bestDist) {
          bestDist = d;
          best = name;
        }
      }

      return best;
    } catch (_) {
      return null;
    }
  }

  /**
   * Find the confirm slot in an /rtpqueue confirmation GUI.
   * Scans item name/lore for confirm keywords, then confirm-like materials.
   * @returns {number|null}
   */
  findRtpQueueConfirmSlot(win) {
    if (!win?.slots) return null;
    const slots = win.slots;

    // GUI slots only (exclude the player's own inventory rows at the bottom).
    const invStart = typeof win.inventoryStart === 'number'
      ? win.inventoryStart
      : slots.length;

    let materialHit = null;
    for (let i = 0; i < invStart; i++) {
      const item = slots[i];
      if (!item) continue;
      const text = guiItemText(item);
      if (text && RTPQUEUE_CONFIRM_KEYWORDS.test(text)) {
        if (RTPQUEUE_DEBUG) this.log(`[RTPQueue] confirm slot ${i} by text "${text}"`, 'gray');
        return i;
      }
      const mat = String(item.name || '');
      if (materialHit == null && RTPQUEUE_CONFIRM_MATERIALS.test(mat)) {
        materialHit = i;
      }
    }

    if (materialHit != null) {
      if (RTPQUEUE_DEBUG) this.log(`[RTPQueue] confirm slot ${materialHit} by material`, 'gray');
      return materialHit;
    }

    if (RTPQUEUE_CONFIRM_SLOT != null && RTPQUEUE_CONFIRM_SLOT < invStart) {
      return RTPQUEUE_CONFIRM_SLOT;
    }
    // Center of a single-row (9) or 27-slot GUI is a common confirm position.
    if (invStart >= 5) return Math.floor((invStart - 1) / 2);
    return null;
  }

  /**
   * After sending /rtpqueue, a confirmation GUI may open. Click confirm so the
   * bot actually enters the queue (otherwise it hangs, never teleported).
   * @returns {Promise<boolean>} true if no GUI (already queued) or confirm clicked
   */
  async handleRtpQueueConfirm() {
    const bot = this.bot;
    if (!bot || !RTPQUEUE_CONFIRM_ENABLED) return true;

    const win = await this.waitForWindowOpen(RTPQUEUE_CONFIRM_OPEN_MS);
    if (!win) {
      // No GUI — server may queue directly via chat command.
      return true;
    }

    const slotCount = win.slots ? win.slots.length : 0;
    const title = typeof win.title === 'string'
      ? win.title
      : (win.title && (win.title.text || JSON.stringify(win.title))) || '';
    this.log(`[RTPQueue] confirm GUI opened (${slotCount} slots, title="${title}")`, 'cyan');

    await sleep(RTPQUEUE_CONFIRM_DELAY_MS);

    const slot = this.findRtpQueueConfirmSlot(bot.currentWindow || win);
    if (slot == null) {
      this.log('[RTPQueue] no confirm slot found — closing GUI', 'yellow');
      if (bot.currentWindow) { try { await bot.closeWindow(bot.currentWindow); } catch (_) {} }
      return false;
    }

    try {
      const item = (bot.currentWindow || win).slots[slot];
      const label = guiItemText(item) || item?.name || `slot ${slot}`;
      this.log(`[RTPQueue] clicking confirm (${label}) at slot ${slot}`, 'green');
      await bot.clickWindow(slot, 0, 0);
      await sleep(300);
      if (bot.currentWindow) { try { await bot.closeWindow(bot.currentWindow); } catch (_) {} }
      return true;
    } catch (e) {
      this.log(`[RTPQueue] confirm click failed: ${e.message}`, 'red');
      if (bot.currentWindow) { try { await bot.closeWindow(bot.currentWindow); } catch (_) {} }
      return false;
    }
  }

  async _joinRtpQueue() {
    if (this._rtpQueueJoined || !this.bot?.entity) return false;
    this._rtpQueueJoined = true;
    this._rtpQueueJoinedAt = Date.now();
    this.log(`${RTPQUEUE_COMMAND} — joining queue`, 'cyan');
    try {
      this.bot.chat(RTPQUEUE_COMMAND);
    } catch (e) {
      this._rtpQueueJoined = false;
      this._rtpQueueJoinedAt = 0;
      this.log(`[RTPQueue] chat failed: ${e.message}`, 'yellow');
      return false;
    }

    try {
      const confirmed = await this.handleRtpQueueConfirm();
      if (!confirmed) {
        this.log('[RTPQueue] confirm GUI not handled — will retry join', 'yellow');
        this._rtpQueueJoined = false;
        this._rtpQueueJoinedAt = 0;
        return false;
      }
      // Reset queue timer to when we actually confirmed entry.
      this._rtpQueueJoinedAt = Date.now();
    } catch (e) {
      this.log(`[RTPQueue] confirm handling error: ${e.message}`, 'yellow');
    }

    return true;
  }

  _leaveRtpQueue() {
    this._rtpQueueJoined = false;
    this._rtpQueueJoinedAt = 0;
  }

  /** After death/respawn, immediately re-enter /rtpqueue (don't wait for loop retry). */
  async rejoinRtpQueueAfterRespawn() {
    if (this.stopping || this._rtpRejoinInFlight) return;
    if (!this._requeueOnRespawn) return;
    this._requeueOnRespawn = false;
    if (this.convoActive) return;

    this._rtpRejoinInFlight = true;
    try {
      await sleep(RTPQUEUE_RESPAWN_DELAY_MS);

      if (this.stopping || this.convoActive || !this.bot) return;

      for (let i = 0; i < 15; i++) {
        if (this.bot?.entity && this.bot.isAlive) break;
        await sleep(100);
      }
      if (!this.bot?.entity || !this.bot.isAlive || this.convoActive) return;

      if (this.bot.currentWindow) {
        try { await this.bot.closeWindow(this.bot.currentWindow); } catch (_) {}
      }

      this._leaveRtpQueue();
      this._tpaBusy = false;
      this.log('[RTPQueue] respawn — re-joining queue immediately', 'cyan');
      await this._joinRtpQueue();
    } catch (e) {
      this.log(`[RTPQueue] respawn re-join failed: ${e.message}`, 'yellow');
    } finally {
      this._rtpRejoinInFlight = false;
    }
  }

  /** @returns {Promise<string|null>} paired Java username */
  async waitForRtpQueuePartner() {
    if (!this._rtpQueueJoined) {
      if (!(await this._joinRtpQueue())) return null;
    }

    const queuedFor = Date.now() - this._rtpQueueJoinedAt;
    const remainingMax = RTPQUEUE_MAX_MS - queuedFor;
    if (remainingMax <= 0) {
      this.log('[RTPQueue] max queue time reached — re-joining', 'yellow');
      this._leaveRtpQueue();
      return null;
    }

    const watchMs = Math.min(RTPQUEUE_WAIT_MS, remainingMax);
    return this._watchRtpQueueForPartner(watchMs);
  }

  /**
   * Listen for rtpqueue match signals (no chat — must already be in queue).
   * Pair when self-teleport + nearby Java player.
   */
  _watchRtpQueueForPartner(watchMs) {
    const bot = this.bot;
    const client = bot?._client;
    if (!bot?.entity || !client) return Promise.resolve(null);

    const originPos = bot.entity.position.clone();
    const start = Date.now();

    let selfTeleported = false;
    let partnerTeleportedNear = false;
    let lastSignalAt = 0;
    let maxMove = 0;
    let sawPositionPacket = 0;
    let sawEntityTeleport = 0;
    let pendingPartner = null;

    const noteSelfTeleport = (reason) => {
      if (selfTeleported) return;
      selfTeleported = true;
      lastSignalAt = Date.now();
      this.log(`[RTPQueue] ${reason}`, 'cyan');
    };

    const trackMove = () => {
      try {
        const d = bot.entity.position.distanceTo(originPos);
        if (d > maxMove) maxMove = d;
        if (d >= RTPQUEUE_MOVE_MIN) noteSelfTeleport(`moved ${d.toFixed(1)} blocks`);
      } catch (_) {}
    };

    const considerPartner = (name, reason) => {
      if (!name || isBedrockName(name)) return;
      const low = name.toLowerCase();
      if (low === (bot.username || '').toLowerCase()) return;
      if (poolBotUsernames.has(low)) return;
      if (!this._shouldStartConvoWith(name)) return;
      if (!this.isTargetNear(name, RTPQUEUE_PAIR_RADIUS)) return;
      pendingPartner = name;
      lastSignalAt = Date.now();
      if (RTPQUEUE_DEBUG) this.log(`[RTPQueue] candidate ${name} (${reason})`, 'gray');
      if (/entity_teleport|sync_entity_position|entitySpawn|playerJoined/.test(reason)) {
        partnerTeleportedNear = true;
      }
    };

    const scanForPartner = () => {
      if (!selfTeleported) return;
      const near = this.findNearestOtherPlayer(RTPQUEUE_PAIR_RADIUS);
      if (near) considerPartner(near, 'nearest scan');
      for (const name of Object.keys(bot.players || {})) {
        considerPartner(name, 'player scan');
      }
    };

    const readyToPair = () => selfTeleported && !!pendingPartner;

    return new Promise((resolve) => {
      let done = false;
      let deadline = start + watchMs;

      const cleanup = () => {
        clearInterval(iv);
        try { bot.removeListener('forcedMove', onForcedMove); } catch (_) {}
        try { bot.removeListener('move', onMove); } catch (_) {}
        try { bot.removeListener('entitySpawn', onEntitySpawn); } catch (_) {}
        try { bot.removeListener('playerJoined', onPlayerJoined); } catch (_) {}
        try { client.removeListener('position', onPosition); } catch (_) {}
        try { client.removeListener('entity_teleport', onEntityTeleport); } catch (_) {}
        try { client.removeListener('sync_entity_position', onSyncEntityPos); } catch (_) {}
      };

      const finish = (name) => {
        if (done) return;
        done = true;
        cleanup();
        resolve(name);
      };

      const bumpPartnerScanDeadline = () => {
        deadline = Math.max(deadline, Date.now() + RTPQUEUE_PARTNER_SCAN_MS);
      };

      const onForcedMove = () => {
        sawPositionPacket++;
        trackMove();
        noteSelfTeleport('position packet (forcedMove)');
        bumpPartnerScanDeadline();
        scanForPartner();
      };

      const onMove = () => trackMove();

      const onPosition = () => {
        sawPositionPacket++;
        trackMove();
        if (maxMove >= RTPQUEUE_MOVE_MIN) {
          bumpPartnerScanDeadline();
          scanForPartner();
        }
      };

      const onEntitySpawn = (entity) => {
        if (!selfTeleported || !entity) return;
        const name = entity.username || entity.name;
        if (name) considerPartner(name, 'entitySpawn');
      };

      const onPlayerJoined = (player) => {
        if (!selfTeleported || !player?.username) return;
        considerPartner(player.username, 'playerJoined');
      };

      const onEntityTeleport = (packet) => {
        sawEntityTeleport++;
        const selfId = bot.entity?.id;
        if (selfId != null && packet.entityId === selfId) {
          noteSelfTeleport('entity_teleport (self)');
          bumpPartnerScanDeadline();
          scanForPartner();
          return;
        }
        try {
          const pos = this.entityPosFromTeleportPacket(packet);
          const dist = bot.entity.position.distanceTo(pos);
          if (dist > RTPQUEUE_PAIR_RADIUS) return;
          const name = this.findPlayerNameByEntityId(packet.entityId);
          if (name) considerPartner(name, 'player entity_teleport');
        } catch (_) {}
      };

      const onSyncEntityPos = (packet) => {
        sawEntityTeleport++;
        const selfId = bot.entity?.id;
        if (selfId != null && packet.entityId === selfId) {
          noteSelfTeleport('sync_entity_position (self)');
          bumpPartnerScanDeadline();
          scanForPartner();
          return;
        }
        try {
          const pos = { x: packet.x, y: packet.y, z: packet.z };
          const dist = bot.entity.position.distanceTo(pos);
          if (dist > RTPQUEUE_PAIR_RADIUS) return;
          const name = this.findPlayerNameByEntityId(packet.entityId);
          if (name) considerPartner(name, 'player sync_entity_position');
        } catch (_) {}
      };

      bot.on('forcedMove', onForcedMove);
      bot.on('move', onMove);
      bot.on('entitySpawn', onEntitySpawn);
      bot.on('playerJoined', onPlayerJoined);
      client.on('position', onPosition);
      client.on('entity_teleport', onEntityTeleport);
      client.on('sync_entity_position', onSyncEntityPos);

      const iv = setInterval(() => {
        if (!this.spawned || !bot.entity) {
          this._leaveRtpQueue();
          return finish(null);
        }

        trackMove();
        if (selfTeleported) scanForPartner();

        if (readyToPair()) {
          if (Date.now() - lastSignalAt >= RTPQUEUE_SETTLE_MS) {
            this.log(`[RTPQueue] paired with Java player ${pendingPartner}`, 'green');
            return finish(pendingPartner);
          }
          return;
        }

        if (Date.now() >= deadline) {
          const nearby = this.findNearestOtherPlayer(RTPQUEUE_PAIR_RADIUS);
          this.log(
            `[RTPQueue] watch ended — selfTp=${selfTeleported} partnerTp=${partnerTeleportedNear} ` +
            `maxMove=${maxMove.toFixed(1)} posPkts=${sawPositionPacket} entTp=${sawEntityTeleport} ` +
            `nearbyJava=${nearby || 'none'} queued=${Math.round((Date.now() - this._rtpQueueJoinedAt) / 1000)}s`,
            'yellow'
          );
          if (selfTeleported && !pendingPartner) this._leaveRtpQueue();
          return finish(null);
        }
      }, 400);
    });
  }

  async tpaLoop() {
    const loopId = this._tpaLoopSeq;
    const alive = () => loopId === this._tpaLoopSeq && !this.stopping;

    // Wait for VC before the first /tpahere (and after reconnects).
    if (VoiceChatClient && REQUIRE_VC) {
      this.log('[VC] waiting for voice chat to connect before /tpahere...', 'cyan');
      while (alive() && this.bot && this.bot._client) {
        if (await this.waitForVoiceChatReady(VC_READY_TIMEOUT_MS)) break;
        if (!alive() || !this.spawned) return;
        this.log('[VC] still not ready — retrying handshake...', 'yellow');
        await sleep(VC_RECONNECT_BASE_MS);
      }
      if (!alive()) return;
      this.log('[VC] voice ready — starting /tpahere loop', 'green');
    } else {
      await sleep(3000);
    }

    while (alive() && this.bot && this.bot._client) {
      if (!this.spawned || !this.bot.entity || this.convoActive || this._tpaBusy) {
        if (!this.convoActive && !this._tpaBusy && this._pendingTpahere.size > 0) {
          const prox = this._findProximityAcceptFromPending();
          if (prox && this._shouldStartConvoWith(prox)) this._deferredAccepter = prox;
        }
        await sleep(2000);
        continue;
      }

      if (this._deferredAccepter) {
        const accepter = this._deferredAccepter;
        this._deferredAccepter = null;
        this._clearPendingTpahere(accepter);
        if (!this._shouldStartConvoWith(accepter)) {
          this.log(
            `${accepter} deferred accept skipped — conversation recently finished (still nearby?)`,
            'gray'
          );
          await sleep(TPA_LOOP_GAP_MS);
          continue;
        }
        this._tpaBusy = true;
        this.log(`${accepter} ACCEPTED (deferred) — starting conversation`, 'green');
        this.wh('TPA Accepted', {
          emoji: '🤝',
          color: WH_COLORS.ok,
          description: `**\`${accepter}\`** accepted a pending tpahere — starting voice convo`,
          fields: [{ name: 'Spoken name', value: spokenName(accepter), inline: true }],
        });
        await updateTarget(accepter, 'accepted', true);
        await this.runConversation(accepter);
        await updateTarget(accepter, 'done', true);
        this._tpaBusy = false;
        await sleep(TPA_LOOP_GAP_MS);
        continue;
      }

      // Re-check VC before each tpahere (handles mid-session drops).
      if (VoiceChatClient && REQUIRE_VC && !(this.voiceChat && this.voiceChat.isReady())) {
        this.log('[VC] dropped — waiting before next /tpahere', 'yellow');
        const ok = await this.waitForVoiceChatReady(VC_READY_TIMEOUT_MS);
        if (!ok) {
          await sleep(VC_RECONNECT_BASE_MS);
          continue;
        }
      }

      const target = await this.resolveTpaTarget();
      if (!target) {
        await sleep(10_000); // nothing new to contact yet
        continue;
      }

      // Atomic claim so no other bot double-taps this player (debug target
      // clears any prior row first so you can re-test the same name).
      if (this._lastTargetWasDebug) {
        await unclaimTarget(target);
        this._lastTargetWasDebug = false;
      }
      const claimed = await claimTarget(target, this.botNumber);
      if (!claimed) continue; // someone else grabbed them between pick and claim

      this._tpaBusy = true;
      let sendResult = { sent: false, confirmed: false };
      try {
        sendResult = await this.sendTpahereWithConfirm(target);
      } catch (e) {
        this.log(`tpahere error: ${e.message}`, 'red');
      }

      if (!sendResult.sent) {
        await unclaimTarget(target);
        this._tpaBusy = false;
        await sleep(TPA_LOOP_GAP_MS);
        continue;
      }
      if (!sendResult.confirmed) {
        await unclaimTarget(target);
        this._tpaBusy = false;
        await sleep(TPA_LOOP_GAP_MS);
        continue;
      }

      tpaWebhookStats.record(this.botNumber, target);
      this._registerPendingTpahere(target);

      const accepter = await this.waitForAccept(target, TPA_WAIT_MS);

      if (!this.spawned) {
        this._tpaBusy = false;
        continue; // disconnected mid-wait
      }

      if (!accepter) {
        this.log(`${target} did not accept within ${Math.round(TPA_WAIT_MS / 1000)}s — next`, 'gray');
        this._clearPendingTpahere(target);
        await updateTarget(target, 'no_accept', false);
        this._tpaBusy = false;
        await sleep(TPA_LOOP_GAP_MS);
        continue;
      }

      const primary = target.toLowerCase();
      const got = accepter.toLowerCase();
      if (got !== primary) {
        this.log(
          `${accepter} accepted pending tpahere (was waiting on ${target}) — starting convo`,
          'green'
        );
        await updateTarget(target, 'no_accept', false);
        await unclaimTarget(target);
      }

      this._clearPendingTpahere(accepter);

      this.log(`${accepter} ACCEPTED — starting conversation`, 'green');
      this.wh('TPA Accepted', {
        emoji: '🤝',
        color: WH_COLORS.ok,
        description: `**\`${accepter}\`** teleported in — starting voice convo`,
        fields: [
          { name: 'Spoken name', value: spokenName(accepter), inline: true },
          ...(got !== primary
            ? [{ name: 'Note', value: `Delayed accept (sent to \`${target}\` first)`, inline: false }]
            : []),
        ],
      });
      await updateTarget(accepter, 'accepted', true);
      await this.runConversation(accepter);
      await updateTarget(accepter, 'done', true);
      this._tpaBusy = false;
      await sleep(TPA_LOOP_GAP_MS);
    }
  }

  /**
   * Pick the next /tpahere target. When DEBUG=true, the first request per
   * spawn goes to `tpahere=` in .env instead of player_list.txt.
   */
  async resolveTpaTarget() {
    if (DEBUG_MODE && DEBUG_TPAHERE_TARGET && !this._debugTpaDone) {
      this._debugTpaDone = true;
      this._lastTargetWasDebug = true;
      this.log(`[DEBUG] first tpahere -> ${DEBUG_TPAHERE_TARGET}`, 'magenta');
      return DEBUG_TPAHERE_TARGET;
    }
    this._lastTargetWasDebug = false;
    return this.pickNextTarget();
  }

  async pickNextTarget() {
    const list = readPlayerList();
    if (list.length === 0) return null;
    const tried = await getTriedSet();
    const self = (this.bot.username || '').toLowerCase();
    const candidates = list.filter((n) => {
      const low = n.toLowerCase();
      return low !== self && !tried.has(low) && !poolBotUsernames.has(low);
    });
    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  /** True if the target's entity is currently within `radius` of the bot. */
  isTargetNear(target, radius) {
    try {
      const rec = findBotPlayer(this.bot, target);
      const ent = rec && rec.player && rec.player.entity;
      if (!ent || !this.bot.entity) return false;
      return this.bot.entity.position.distanceTo(ent.position) <= radius;
    } catch (_) {
      return false;
    }
  }

  /** True if the target is still on the server tab list (any casing). */
  isTargetOnline(target) {
    return !!findBotPlayer(this.bot, target);
  }

  /** Refresh cached target UUID for voice record/interrupt (entity may load late). */
  _refreshTargetUuid(target) {
    const rec = findBotPlayer(this.bot, target);
    const uuid = rec && rec.player && rec.player.uuid;
    if (!uuid) return false;
    const next = String(uuid).replace(/-/g, '').toLowerCase();
    if (next !== this.currentTargetUuid) {
      this.currentTargetUuid = next;
      this.log(`[VC] target uuid cached for ${target} (${next.slice(0, 8)}...)`, 'gray');
    }
    return true;
  }

  _prunePendingTpahere() {
    const now = Date.now();
    for (const [low, info] of this._pendingTpahere) {
      if (now - info.sentAt > PENDING_TPA_MS) this._pendingTpahere.delete(low);
    }
  }

  _registerPendingTpahere(username) {
    const low = String(username || '').toLowerCase();
    if (!low) return;
    this._prunePendingTpahere();
    this._pendingTpahere.set(low, { username, sentAt: Date.now() });
  }

  _clearPendingTpahere(username) {
    this._pendingTpahere.delete(String(username || '').toLowerCase());
  }

  _findAcceptFromPending(msg) {
    this._prunePendingTpahere();
    const parsed = parseAcceptUsername(msg);
    if (parsed) {
      const hit = this._pendingTpahere.get(parsed.toLowerCase());
      if (hit) return hit.username;
    }
    for (const info of this._pendingTpahere.values()) {
      if (acceptMessageMatchesTarget(msg, info.username)) return info.username;
    }
    return null;
  }

  _findProximityAcceptFromPending() {
    this._prunePendingTpahere();
    for (const info of this._pendingTpahere.values()) {
      if (this._isConvoCooldown(info.username)) continue;
      if (this.isTargetNear(info.username, ACCEPT_RADIUS)) return info.username;
    }
    return null;
  }

  _markConvoFinished(username) {
    const low = String(username || '').toLowerCase();
    if (low) this._convoFinishedAt.set(low, Date.now());
  }

  _isConvoCooldown(username) {
    const low = String(username || '').toLowerCase();
    const at = this._convoFinishedAt.get(low);
    if (!at) return false;
    if (Date.now() - at < CONVO_COOLDOWN_MS) return true;
    this._convoFinishedAt.delete(low);
    return false;
  }

  _shouldStartConvoWith(username) {
    return !!username && !this._isConvoCooldown(username);
  }

  async _rtpAwayAfterConvo(endReason) {
    if (!this.bot || !this.bot.entity) return;
    const dirs = RTP_DIRECTIONS.length ? RTP_DIRECTIONS : ['west', 'east'];
    const dir = dirs[Math.floor(Math.random() * dirs.length)];
    try {
      this.log(`[RTP] /rtp ${dir} — leaving area after conversation (${endReason})`, 'cyan');
      this.bot.chat(`/rtp ${dir}`);
      await sleep(RTP_AFTER_CONVO_MS);
    } catch (e) {
      this.log(`[RTP] failed: ${e.message}`, 'yellow');
    }
  }

  async _leaveAfterConversation(target, endReason) {
    this._markConvoFinished(target);
    this._clearPendingTpahere(target);
    if (
      this._deferredAccepter &&
      String(this._deferredAccepter).toLowerCase() === String(target).toLowerCase()
    ) {
      this._deferredAccepter = null;
    }
    if (RTP_AFTER_CONVO) {
      await this._rtpAwayAfterConvo(endReason);
    }
  }

  /**
   * Wait for the primary target OR any pending /tpahere to be accepted.
   * Returns the accepter's username, or null on timeout.
   */
  waitForAccept(primaryTarget, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const start = Date.now();
      const primaryLow = String(primaryTarget || '').toLowerCase();

      const finish = (accepter) => {
        if (done) return;
        done = true;
        clearInterval(iv);
        try { this.bot.removeListener('messagestr', onMsg); } catch (_) {}
        resolve(accepter || null);
      };

      const onMsg = (msg) => {
        const s = String(msg);
        const plain = stripMcColorCodes(s).toLowerCase();
        if (TPA_FAIL_RE.test(s) && plain.includes(primaryLow)) {
          finish(null);
          return;
        }
        const fromPending = this._findAcceptFromPending(s);
        if (fromPending) {
          finish(fromPending);
          return;
        }
        if (acceptMessageMatchesTarget(s, primaryTarget)) finish(primaryTarget);
      };
      this.bot.on('messagestr', onMsg);

      const iv = setInterval(() => {
        if (!this.spawned || !this.bot || !this.bot.entity) return finish(null);
        const prox = this._findProximityAcceptFromPending();
        if (prox) return finish(prox);
        if (Date.now() - start >= timeoutMs) return finish(null);
      }, 400);
    });
  }

  // ---------- Conversation ----------
  async runConversation(target) {
    this._clearPendingTpahere(target);
    if (
      this._deferredAccepter &&
      String(this._deferredAccepter).toLowerCase() === String(target).toLowerCase()
    ) {
      this._deferredAccepter = null;
    }

    this.currentTarget = target;
    this.currentTargetUuid = '';
    this._refreshTargetUuid(target);
    if (!this.currentTargetUuid) {
      this.log(`[VC] warning: ${target} uuid not in tab list yet — voice may not work until they load in`, 'yellow');
    }
    this.convoActive = true;
    this.lastInteractionAt = Date.now();

    const botName = this.bot && this.bot.username ? this.bot.username : 'TFORCE888';
    const convoPrompt = buildTargetPrompt(BASE_CONVO_PROMPT, target, botName);
    const pitchPrompt = buildTargetPrompt(BASE_PITCH_PROMPT, target, botName);

    if (this.voiceAI) {
      this.voiceAI.resetAll();
      this.voiceAI.systemPrompt = convoPrompt; // reactive replies use this
    }

    // Main pitch 3s after they teleport (env: PITCH_DELAY_MS).
    await sleep(PITCH_DELAY_MS);
    if (this.convoActive && this.currentTarget === target && this.voiceAI && this.voiceAI.isEnabled()) {
      if (VoiceChatClient && REQUIRE_VC && !(this.voiceChat && this.voiceChat.isReady())) {
        this.log('[VC] waiting before pitch...', 'yellow');
        await this.waitForVoiceChatReady(15_000);
      }
      if (!(this.voiceChat && this.voiceChat.isReady()) && REQUIRE_VC) {
        this.log('[VC] skip pitch — voice not connected', 'yellow');
      } else {
        const scene =
          `[SCENE: You sent /tpahere to ${target}, they accepted and teleported to you about ` +
          `${Math.round(PITCH_DELAY_MS / 1000)} seconds ago. You are standing next to them in voice chat. ` +
          `Deliver your MAIN PITCH now — ask if they want to join your group for free gear and money.]`;
        this.voiceAI.triggerScriptedReply({
          username: target,
          systemPrompt: pitchPrompt,
          userMessage: scene,
          priority: 'high',
        });
        this.log(`pitch ${target} (spoken as "${spokenName(target)}")`, 'magenta');
      }
    }

    // Monitor until the conversation should end.
    const convoStart = Date.now();
    let farSince = 0;
    let endReason = 'ended';
    while (this.convoActive && this.currentTarget === target && this.bot && this.bot.entity) {
      const now = Date.now();
      const convoAge = now - convoStart;
      const canEndEarly = convoAge >= CONVO_MIN_MS;

      this._refreshTargetUuid(target);

      if (convoAge > CONVO_MAX_MS) {
        this.log(`conversation with ${target} hit max duration — ending`, 'gray');
        endReason = 'max duration';
        break;
      }
      if (canEndEarly && now - this.lastInteractionAt > CONVO_IDLE_MS) {
        this.log(`conversation with ${target} idle ${Math.round(CONVO_IDLE_MS / 1000)}s — ending`, 'gray');
        endReason = 'idle timeout';
        break;
      }

      // End only when they're gone from tab list AND not nearby (case-insensitive).
      // Don't leave-end until CONVO_MIN_MS so they have time to respond after pitch.
      const near = this.isTargetNear(target, CONVO_RADIUS);
      const online = this.isTargetOnline(target);
      if (near || online) {
        farSince = 0;
      } else if (canEndEarly) {
        if (farSince === 0) farSince = now;
        else if (now - farSince > LEAVE_GRACE_MS) {
          this.log(`${target} left the area — ending conversation`, 'gray');
          endReason = 'left area';
          break;
        }
      }

      await sleep(1500);
    }

    const durationSec = Math.round((Date.now() - convoStart) / 1000);
    this.wh('Conversation Over', {
      emoji: '🏁',
      color: WH_COLORS.scan,
      description: `Finished with **\`${target}\`**`,
      fields: [
        { name: 'Reason', value: endReason, inline: true },
        { name: 'Duration', value: `${durationSec}s`, inline: true },
      ],
    });

    this.convoActive = false;
    this.currentTarget = null;
    this.currentTargetUuid = null;

    await this._leaveAfterConversation(target, endReason);
  }
}

// ============================================================
// Main
// ============================================================


module.exports = { VoiceAdBot };
