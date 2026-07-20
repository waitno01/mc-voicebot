'use strict';

/**
 * voice_chat.js
 *
 * Minimal Simple Voice Chat (henkelmax) client-side protocol implementation
 * for Mineflayer. Supports connecting to the server's UDP voice socket,
 * authenticating, maintaining keepalive, and streaming pre-encoded Opus
 * frames (from voice_audio.js) as MicPackets.
 *
 * Protocol (Simple Voice Chat 2.6.x / compatibility_version 20):
 *
 *   Plugin channels (over Minecraft TCP):
 *     C -> S: voicechat:request_secret      { int compatibilityVersion }
 *     S -> C: voicechat:secret              { Secret(16), int port, UUID, byte codec,
 *                                             int mtuSize, double distance, int keepAlive,
 *                                             bool groupsEnabled, String voiceHost, bool allowRecording }
 *
 *   UDP wire format:
 *     [byte 0xFF (MAGIC_BYTE)]
 *     [UUID playerUUID (16 bytes, big-endian msb then lsb)]
 *     [VarInt-prefixed byte[]: AES-128-GCM encrypted payload]
 *
 *   Encrypted payload (after decryption):
 *     [byte packetType]
 *     [packet body]
 *
 *   Packet IDs:
 *     0x01 MicPacket                 { VarInt+bytes opusData, long seq, bool whispering }
 *     0x05 AuthenticatePacket        { UUID playerUUID, Secret(16) }
 *     0x06 AuthenticateAckPacket     empty
 *     0x08 KeepAlivePacket           empty
 *     0x09 ConnectionCheckPacket     empty
 *     0x0A ConnectionCheckAckPacket  empty
 *
 *   Encryption: AES/GCM/NoPadding
 *     - Key    : raw 16-byte secret from SecretPacket (AES-128)
 *     - IV     : 12 random bytes prepended to ciphertext
 *     - Tag    : 16-byte GCM tag appended to ciphertext
 *     - On wire: [12 iv][ciphertext][16 tag]
 *
 *   Handshake flow after plugin channel exchange:
 *     1. Client sends AuthenticatePacket  -> server replies AuthenticateAckPacket
 *     2. Client sends ConnectionCheckPacket -> server replies ConnectionCheckAckPacket
 *     3. Client starts KeepAlive interval, is now "fully connected"
 */

const dgram = require('dgram');
const crypto = require('crypto');
const net = require('net');
const { EventEmitter } = require('events');

// ------------------------------------------------------------
// Optional SOCKS5 support (UDP ASSOCIATE)
// ------------------------------------------------------------
let SocksClient = null;
try {
  SocksClient = require('socks').SocksClient;
} catch (_) {
  // socks is optional; direct UDP still works without it
}

/**
 * Generate a fresh random alphanumeric SSID. Mirrors the niceproxy.io
 * `-ssid-XXXX` token shape used by `generateRandomProxySsid()` in
 * pool1.js / pool2.js — kept duplicated here to avoid pulling those
 * massive files into voice_chat.js.
 */
function _randomSsid(length = 10) {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function _extractSsid(userId) {
  if (typeof userId !== 'string') return null;
  const m = userId.match(/-ssid-([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

/**
 * Returns a new proxy config object with the `-ssid-XXXX` segment of
 * userId replaced by a fresh random one. If the userId doesn't contain
 * a `-ssid-` token, returns the original proxy unchanged.
 */
function _withRandomizedSsid(proxy) {
  if (!proxy || typeof proxy.userId !== 'string') return proxy;
  const m = proxy.userId.match(/^(.*?-ssid-)([A-Za-z0-9]+)(.*)$/);
  if (!m) return proxy;
  const newSsid = _randomSsid(m[2].length);
  return {
    ...proxy,
    userId: `${m[1]}${newSsid}${m[3]}`,
  };
}

/**
 * SOCKS5 UDP ASSOCIATE via the 'socks' library. We can't use
 * `SocksClient.createConnection({ command: 'associate', ... })` because that
 * static factory hardcodes `['connect']` as the only accepted command. The
 * correct pattern is to instantiate SocksClient directly, listen for the
 * 'established' event (which fires for ASSOCIATE as well as CONNECT), and
 * resolve with the relay {host, port} plus the control socket.
 */
function socksUdpAssociate({ proxy, timeoutMs = 10_000 }) {
  return new Promise((resolve, reject) => {
    if (!SocksClient) {
      reject(new Error("'socks' module not installed"));
      return;
    }
    let client;
    try {
      // The SocksClient has its OWN internal `timeout` that fires
      // `closeSocket(err)` and emits an 'error' on the client. We pin
      // the lib's timeout to be slightly SHORTER than our outer timer
      // so the lib's emit lands while our 'error' listener is still
      // attached (settled=false → handled cleanly by the once handler).
      // If our outer timer ever races and fires first, the post-settle
      // permanent noop listener attached below absorbs any late
      // lib-emitted error so it can't escape to uncaughtException.
      const libTimeoutMs = Math.max(2000, Math.floor(timeoutMs * 0.8));
      client = new SocksClient({
        proxy: {
          host: proxy.host,
          port: proxy.port,
          type: 5,
          userId: proxy.userId,
          password: proxy.password,
        },
        command: 'associate',
        destination: { host: '0.0.0.0', port: 0 },
        timeout: libTimeoutMs,
      });
    } catch (e) {
      reject(e);
      return;
    }

    let settled = false;

    // CRITICAL — the SocksClient is an EventEmitter that may emit an
    // 'error' event AFTER we've already settled the promise. Sources:
    //   • the lib's internal `onEstablishedTimeout` (the `timeout`
    //     option above) calling `closeSocket(err)` after `connect()`
    //     stalls
    //   • the lib's underlying TCP control socket emitting late errors
    //     (RST, ECONNRESET) once the proxy gives up
    //   • us calling `client.socket.destroy()` in the outer timeout
    //     branch below
    // Without an always-on 'error' listener, ANY of these post-settle
    // emits becomes an unhandled 'error' event and crashes the whole
    // pool process via uncaughtException. The "[Bot 4] auth-locked /
    // shutting down — aborting createBot" mass-shutdown loop on
    // 2026-05-07 was traced to exactly this — a single voice-chat
    // bot's late SOCKS5 ASSOCIATE timeout took down 14 bots.
    //
    // We attach the listener via `.on(...)` (NOT `.once(...)`) and
    // never remove it. Pre-settle it routes errors into the promise;
    // post-settle it silently absorbs them.
    const _absorb = (err) => {
      if (settled) {
        // Late lib-emitted error — already handled the rejection, the
        // VC client has already started its direct-UDP fallback. Just
        // make sure the event has a handler so Node doesn't crash.
        return;
      }
      settled = true;
      clearTimeout(to);
      reject(err);
    };
    client.on('error', _absorb);

    client.once('established', (info) => {
      if (settled) return;
      settled = true;
      clearTimeout(to);
      resolve({
        socket: info.socket,
        host: info.remoteHost && info.remoteHost.host,
        port: info.remoteHost && info.remoteHost.port,
      });
    });

    const to = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Do NOT call removeAllListeners — we need _absorb to keep
      // catching the inevitable post-timeout error event from the lib.
      // Tear down the underlying TCP control socket so the lib stops
      // chasing the dead proxy. The 'error' that comes out of this
      // .destroy() lands on _absorb (settled=true → silent).
      try { if (client.socket) client.socket.destroy(); } catch (_) {}
      reject(new Error('SOCKS5 UDP associate timed out'));
    }, timeoutMs);

    client.connect();
  });
}

// ------------------------------------------------------------
// Protocol constants
// ------------------------------------------------------------
const MAGIC_BYTE = 0xff;
const SECRET_SIZE = 16;
const IV_SIZE = 12;
const GCM_TAG_SIZE = 16;

const PACKET_ID = {
  MIC: 0x01,
  PLAYER_SOUND: 0x02,
  GROUP_SOUND: 0x03,
  LOCATION_SOUND: 0x04,
  AUTHENTICATE: 0x05,
  AUTHENTICATE_ACK: 0x06,
  PING: 0x07,
  KEEPALIVE: 0x08,
  CONNECTION_CHECK: 0x09,
  CONNECTION_CHECK_ACK: 0x0a,
};

const CHANNEL_REQUEST_SECRET = 'voicechat:request_secret';
const CHANNEL_SECRET = 'voicechat:secret';

const DEFAULT_COMPAT_VERSION = 20; // SVC 2.6.x on MC 1.21.1

// ------------------------------------------------------------
// Minecraft FriendlyByteBuf-equivalent helpers
// ------------------------------------------------------------

/** Simple growable writer mimicking Netty/FriendlyByteBuf ops used by SVC. */
class MCBufWriter {
  constructor() {
    this._chunks = [];
  }
  _push(buf) {
    this._chunks.push(buf);
    return this;
  }
  writeByte(b) {
    const buf = Buffer.alloc(1);
    buf.writeUInt8(b & 0xff, 0);
    return this._push(buf);
  }
  writeBoolean(v) {
    return this.writeByte(v ? 1 : 0);
  }
  writeInt(v) {
    const buf = Buffer.alloc(4);
    buf.writeInt32BE(v, 0);
    return this._push(buf);
  }
  writeLong(v) {
    const buf = Buffer.alloc(8);
    buf.writeBigInt64BE(typeof v === 'bigint' ? v : BigInt(v), 0);
    return this._push(buf);
  }
  writeDouble(v) {
    const buf = Buffer.alloc(8);
    buf.writeDoubleBE(v, 0);
    return this._push(buf);
  }
  writeBytes(buf) {
    return this._push(Buffer.from(buf));
  }
  writeVarInt(value) {
    const out = [];
    let v = value >>> 0;
    while (true) {
      if ((v & ~0x7f) === 0) {
        out.push(v);
        break;
      }
      out.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    return this._push(Buffer.from(out));
  }
  writeByteArray(buf) {
    const b = Buffer.from(buf);
    this.writeVarInt(b.length);
    return this._push(b);
  }
  writeString(str) {
    const b = Buffer.from(String(str), 'utf8');
    this.writeVarInt(b.length);
    return this._push(b);
  }
  /** Minecraft UUID: most-significant 8 bytes then least-significant 8 bytes, big-endian. */
  writeUUID(uuidStr) {
    return this._push(uuidStringToBytes(uuidStr));
  }
  toBuffer() {
    return Buffer.concat(this._chunks);
  }
}

/** Simple reader matching MCBufWriter. */
class MCBufReader {
  constructor(buf) {
    this.buf = Buffer.from(buf);
    this.off = 0;
  }
  _need(n) {
    if (this.off + n > this.buf.length) {
      throw new Error(`MCBufReader underflow: need ${n}, have ${this.buf.length - this.off}`);
    }
  }
  readByte() {
    this._need(1);
    const v = this.buf.readUInt8(this.off);
    this.off += 1;
    return v;
  }
  readBoolean() {
    return this.readByte() !== 0;
  }
  readInt() {
    this._need(4);
    const v = this.buf.readInt32BE(this.off);
    this.off += 4;
    return v;
  }
  readLong() {
    this._need(8);
    const v = this.buf.readBigInt64BE(this.off);
    this.off += 8;
    return v;
  }
  readDouble() {
    this._need(8);
    const v = this.buf.readDoubleBE(this.off);
    this.off += 8;
    return v;
  }
  readBytes(n) {
    this._need(n);
    const s = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return s;
  }
  readVarInt() {
    let result = 0;
    let shift = 0;
    while (true) {
      const b = this.readByte();
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift >= 35) throw new Error('VarInt too large');
    }
    return result;
  }
  readByteArray() {
    const len = this.readVarInt();
    return this.readBytes(len);
  }
  readString(max = 32767) {
    const len = this.readVarInt();
    if (len > max * 4) throw new Error(`String too long: ${len}`);
    const raw = this.readBytes(len);
    return raw.toString('utf8');
  }
  readUUID() {
    const raw = this.readBytes(16);
    return uuidBytesToString(raw);
  }
  remaining() {
    return this.buf.length - this.off;
  }
}

function uuidStringToBytes(uuid) {
  const hex = String(uuid).replace(/-/g, '').toLowerCase();
  if (hex.length !== 32) throw new Error(`Invalid UUID: ${uuid}`);
  return Buffer.from(hex, 'hex');
}

function uuidBytesToString(buf) {
  const hex = Buffer.from(buf).toString('hex');
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20, 32)
  );
}

// ------------------------------------------------------------
// AES-128-GCM (matches Java "AES/GCM/NoPadding", 128-bit tag)
// ------------------------------------------------------------
function aesGcmEncrypt(key16, plaintext) {
  const iv = crypto.randomBytes(IV_SIZE);
  const cipher = crypto.createCipheriv('aes-128-gcm', key16, iv);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, enc, tag]);
}

function aesGcmDecrypt(key16, payload) {
  if (payload.length < IV_SIZE + GCM_TAG_SIZE) {
    throw new Error('AES-GCM payload too short');
  }
  const iv = payload.subarray(0, IV_SIZE);
  const tag = payload.subarray(payload.length - GCM_TAG_SIZE);
  const ct = payload.subarray(IV_SIZE, payload.length - GCM_TAG_SIZE);
  const decipher = crypto.createDecipheriv('aes-128-gcm', key16, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// ------------------------------------------------------------
// Packet encoders (body only; outer magic+uuid+encrypted wrapper added by send())
// ------------------------------------------------------------
function encodeAuthenticateBody(playerUuid, secret16) {
  const w = new MCBufWriter();
  w.writeByte(PACKET_ID.AUTHENTICATE);
  w.writeUUID(playerUuid);
  w.writeBytes(secret16); // SVC's Secret.toBytes is just 16 raw bytes, no length prefix
  return w.toBuffer();
}

function encodeConnectionCheckBody() {
  const w = new MCBufWriter();
  w.writeByte(PACKET_ID.CONNECTION_CHECK);
  return w.toBuffer();
}

function encodeKeepAliveBody() {
  const w = new MCBufWriter();
  w.writeByte(PACKET_ID.KEEPALIVE);
  return w.toBuffer();
}

function encodeMicBody(opusFrame, sequenceNumber, whispering) {
  const w = new MCBufWriter();
  w.writeByte(PACKET_ID.MIC);
  w.writeByteArray(opusFrame);
  w.writeLong(BigInt(sequenceNumber));
  w.writeBoolean(whispering);
  return w.toBuffer();
}

// ------------------------------------------------------------
// SOCKS5 UDP header (RFC 1928 §7)
//   +----+------+------+----------+----------+----------+
//   |RSV | FRAG | ATYP | DST.ADDR | DST.PORT |   DATA   |
//   +----+------+------+----------+----------+----------+
//   | 2  |  1   |  1   | Variable |    2     | Variable |
//   +----+------+------+----------+----------+----------+
// ATYP: 0x01 IPv4 (4), 0x03 domain (u8 len + bytes), 0x04 IPv6 (16)
// ------------------------------------------------------------
function socks5WrapUdp(data, destHost, destPort) {
  let atypBuf;
  if (net.isIPv4(destHost)) {
    atypBuf = Buffer.concat([Buffer.from([0x01]), Buffer.from(destHost.split('.').map(Number))]);
  } else if (net.isIPv6(destHost)) {
    const parts = destHost.split(':');
    // Very rough IPv6 packer — rarely used for voice servers; best-effort only.
    const full = Buffer.alloc(16);
    // Fall back to name-type for anything non-trivial
    atypBuf = Buffer.concat([
      Buffer.from([0x03, Buffer.byteLength(destHost, 'ascii')]),
      Buffer.from(destHost, 'ascii'),
    ]);
    void full; void parts;
  } else {
    const nameBuf = Buffer.from(destHost, 'ascii');
    atypBuf = Buffer.concat([Buffer.from([0x03, nameBuf.length]), nameBuf]);
  }
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(destPort & 0xffff, 0);
  const header = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00]), // RSV(2) + FRAG(1)
    atypBuf,
    portBuf,
  ]);
  return Buffer.concat([header, data]);
}

function socks5UnwrapUdp(pkt) {
  if (pkt.length < 10) return null;
  // RSV(2) + FRAG(1)
  const frag = pkt[2];
  if (frag !== 0x00) return null; // fragmented — SVC doesn't care
  const atyp = pkt[3];
  let off = 4;
  if (atyp === 0x01) {
    off += 4; // IPv4
  } else if (atyp === 0x03) {
    const nameLen = pkt[off];
    off += 1 + nameLen;
  } else if (atyp === 0x04) {
    off += 16; // IPv6
  } else {
    return null;
  }
  off += 2; // port
  if (off > pkt.length) return null;
  return pkt.subarray(off);
}

// ------------------------------------------------------------
// VoiceChatClient
// ------------------------------------------------------------

/**
 * @typedef {Object} SocksProxyOptions
 * @property {string} host
 * @property {number} port
 * @property {string} [userId]
 * @property {string} [password]
 */

/**
 * @typedef {Object} VoiceChatOptions
 * @property {number}  [compatVersion]   SVC compatibility_version to advertise (default 20)
 * @property {Buffer[]}[clipFrames]      Pre-encoded Opus frames to play via playClip()
 * @property {Array<{name:string, frames:Buffer[]}>} [clipLibrary]  Multiple pre-encoded clips
 * @property {string}  [botTag]          Label for log prefixes (e.g. "[Bot 16]")
 * @property {boolean} [debug]           Verbose wire logging
 * @property {string}  [fallbackHost]    Host to use when SecretPacket.voiceHost is empty
 * @property {SocksProxyOptions} [proxy] SOCKS5 proxy to route UDP through (UDP ASSOCIATE)
 */

class VoiceChatClient extends EventEmitter {
  /**
   * @param {import('mineflayer').Bot} bot
   * @param {VoiceChatOptions} [opts]
   */
  constructor(bot, opts = {}) {
    super();
    this.bot = bot;
    this.compatVersion = opts.compatVersion || DEFAULT_COMPAT_VERSION;
    this.clipFrames = opts.clipFrames || null;
    this.clipLibrary = Array.isArray(opts.clipLibrary) ? opts.clipLibrary : null;
    // clipStages: [{ name, clips: [{name, frames}, ...] }, ...]
    // When set, playClip() plays one random clip from EACH stage in order,
    // with a small pause between stages. This is how the voice1/voice2 layout
    // is represented internally.
    this.clipStages = Array.isArray(opts.clipStages) ? opts.clipStages : null;
    this.botTag = opts.botTag || '[VC]';
    this.debug = !!opts.debug;
    this.onLog = typeof opts.onLog === 'function' ? opts.onLog : null;
    this.fallbackHost = opts.fallbackHost || null;
    this.proxy = opts.proxy || null;
    // Optional secondary proxy used only when the primary SOCKS5 proxy
    // doesn't support UDP ASSOCIATE (some residential providers reject
    // it with "CommandNotSupported"). When set, the SSID portion of the
    // userId (`-ssid-XXXX`) is randomized per VC session so each bot
    // hits a different exit IP and the proxy provider doesn't see one
    // hot session for our voice traffic.
    this.fallbackProxy = opts.fallbackProxy || null;

    // ---- Recording subsystem (incoming PlayerSound capture) ----
    // recording: {
    //   enabled: bool,                                   master switch
    //   shouldRecord: (uuid: string) => string | null,   if returns username,
    //                                                     we record from that UUID
    //   outputDir: string,                                where MP3s go
    //   silenceMs: number,                                how long without packets
    //                                                     before we finalize a clip
    //   maxClipMs: number,                                hard cap so we never
    //                                                     keep buffering forever
    //   minClipMs: number,                                clips shorter than this
    //                                                     are discarded as noise
    // }
    this.recording = opts.recording && opts.recording.enabled ? {
      enabled: true,
      shouldRecord: typeof opts.recording.shouldRecord === 'function'
        ? opts.recording.shouldRecord
        : (() => null),
      /** Fast UUID check for interrupt — may differ from shouldRecord (e.g. cached target uuid). */
      shouldInterrupt: typeof opts.recording.shouldInterrupt === 'function'
        ? opts.recording.shouldInterrupt
        : null,
      outputDir: opts.recording.outputDir,
      silenceMs: opts.recording.silenceMs || 1500,
      maxClipMs: opts.recording.maxClipMs || 60_000,
      minClipMs: opts.recording.minClipMs || 700,
    } : null;
    // sessionsByUuid: uuid -> { username, opusFrames, lastPacketAt, startedAt,
    //                            silenceTimer, decoder }
    this._recSessions = new Map();
    this._opusDecoderCtor = null;
    this._opusLoadAttempted = false;

    /** Current lifecycle state. */
    this.state = 'idle'; // idle | awaiting_secret | authenticating | connecting | connected | closed

    this.secret = null; // Buffer(16)
    this.playerUuid = null; // string
    this.voiceHost = null; // string
    this.voicePort = 0;
    this.keepAliveMs = 1000;
    this.mtuSize = 1024;
    this.udp = null;
    this._udpRefreshing = false;

    // SOCKS5 UDP ASSOCIATE state
    this._socksCtrlSocket = null; // keeps UDP association alive
    this._socksRelayHost = null;
    this._socksRelayPort = 0;

    this._keepAliveInterval = null;
    this._secretTimeout = null;
    this._connectionCheckTimer = null;
    this._authTimer = null;
    this._requestSent = false;
    this._requestSentAt = 0;

    this._sequenceNumber = 0;
    this._playingClip = false;
    this._playbackAbort = false;
    /** Ms between outbound Opus frames (20 = realtime; higher = slower speech). */
    this.playbackFrameMs = Math.max(15, opts.playbackFrameMs || 20);

    this._boundOnCustomPayload = null;
    this._boundOnEnd = null;
  }

  isReady() {
    return this.state === 'connected';
  }

  // ------------------------------------------------------------
  // Plugin channel (TCP) init
  // ------------------------------------------------------------
  init() {
    if (this.state !== 'idle') return;
    if (!this.bot || !this.bot._client) {
      this._log('init skipped: bot._client not available');
      return;
    }

    this._boundOnCustomPayload = (packet) => {
      try {
        this._handleCustomPayload(packet);
      } catch (e) {
        this._err(`custom_payload handler error: ${e.message}`);
      }
    };
    this._boundOnEnd = () => this.destroy('client_end');

    this.bot._client.on('custom_payload', this._boundOnCustomPayload);
    this.bot._client.once('end', this._boundOnEnd);
    this.bot._client.once('close', this._boundOnEnd);

    // Request the secret once we've hit play phase. spawn() is our cleanest signal.
    const sendRequest = () => this._sendRequestSecret();
    if (this.bot.entity) {
      sendRequest();
    } else {
      this.bot.once('spawn', sendRequest);
    }
  }

  _sendRequestSecret() {
    if (this._requestSent) return;
    if (!this.bot || !this.bot._client) return;
    this._requestSent = true;
    this._requestSentAt = Date.now();
    this.state = 'awaiting_secret';

    const w = new MCBufWriter();
    w.writeInt(this.compatVersion);
    const data = w.toBuffer();

    try {
      this.bot._client.write('custom_payload', {
        channel: CHANNEL_REQUEST_SECRET,
        data,
      });
      this._log(`sent RequestSecretPacket (compatVersion=${this.compatVersion})`);
    } catch (e) {
      this._err(`failed to send RequestSecretPacket: ${e.message}`);
      return;
    }

    // Diagnostic timeout — never receiving SecretPacket usually means the
    // server doesn't have SVC installed or our compat_version doesn't match.
    this._secretTimeout = setTimeout(() => {
      if (this.state === 'awaiting_secret') {
        this._err(
          `never received SecretPacket after 10s. Server likely has no SVC ` +
            `plugin, or SVC_COMPAT_VERSION=${this.compatVersion} mismatches ` +
            `server (check server logs for "compat version" warnings).`
        );
        this.emit('error', new Error('SVC handshake timeout'));
      }
    }, 10_000);
  }

  _handleCustomPayload(packet) {
    const channel = packet && packet.channel;
    if (!channel || !channel.startsWith('voicechat:')) return;

    if (this.debug) {
      this._log(`plugin_message "${channel}" len=${packet.data ? packet.data.length : 0}`);
    }

    if (channel === CHANNEL_SECRET) {
      if (this._secretTimeout) {
        clearTimeout(this._secretTimeout);
        this._secretTimeout = null;
      }
      try {
        const parsed = this._parseSecretPacket(packet.data);
        this._onSecret(parsed);
      } catch (e) {
        this._err(`failed to parse SecretPacket: ${e.message}`);
        this.emit('error', e);
      }
    }
  }

  _parseSecretPacket(data) {
    const r = new MCBufReader(data);
    const secret = r.readBytes(SECRET_SIZE);
    const serverPort = r.readInt();
    const playerUUID = r.readUUID();
    const codec = r.readByte();
    const mtuSize = r.readInt();
    const voiceChatDistance = r.readDouble();
    const keepAlive = r.readInt();
    const groupsEnabled = r.readBoolean();
    const voiceHost = r.readString(32767);
    const allowRecording = r.readBoolean();
    return {
      secret: Buffer.from(secret),
      serverPort,
      playerUUID,
      codec,
      mtuSize,
      voiceChatDistance,
      keepAlive,
      groupsEnabled,
      voiceHost,
      allowRecording,
    };
  }

  // ------------------------------------------------------------
  // UDP handshake
  // ------------------------------------------------------------
  _onSecret(s) {
    if (this._secretTimeout) {
      clearTimeout(this._secretTimeout);
      this._secretTimeout = null;
    }

    // SVC re-sends SecretPacket on respawn / dimension change. Tear down the
    // old UDP session first so we don't run two SOCKS associations in parallel.
    if (this.state === 'connected' || this.state === 'authenticating' || this.state === 'connecting') {
      this._log('SecretPacket re-received — refreshing UDP session');
      this._teardownUdpSession('secret_refresh');
    }

    this.secret = s.secret;
    this.playerUuid = s.playerUUID;
    this.keepAliveMs = Math.max(500, s.keepAlive || 1000);
    this.mtuSize = s.mtuSize || 1024;

    // Resolve host: SVC's voiceHost can be empty, meaning "same as Minecraft host".
    const rawHost = (s.voiceHost || '').trim();
    let host = rawHost;
    let port = s.serverPort;

    if (!host && this.fallbackHost) host = this.fallbackHost;
    if (!host && this.bot && this.bot._client && this.bot._client.socket) {
      host = this.bot._client.socket.remoteAddress;
    }
    if (!host) {
      this._err('no voice host in SecretPacket and no fallback available');
      return;
    }

    // A voiceHost can be "host:port" in some configs
    const colon = host.lastIndexOf(':');
    if (colon > 0 && host.indexOf(']') === -1 && /^\d+$/.test(host.slice(colon + 1))) {
      port = parseInt(host.slice(colon + 1), 10);
      host = host.slice(0, colon);
    }

    this.voiceHost = host;
    this.voicePort = port;

    this._log(
      `SecretPacket received — connecting UDP to ${this.voiceHost}:${this.voicePort} ` +
        `(playerUUID=${this.playerUuid}, keepAlive=${this.keepAliveMs}ms, mtu=${this.mtuSize})`
    );

    this._openUdp().catch((e) => {
      this._err(`_openUdp failed: ${e.message}`);
      this.emit('error', e);
    });
  }

  async _openUdp() {
    this.state = 'authenticating';

    // If a SOCKS5 proxy is configured, first negotiate UDP ASSOCIATE so our UDP
    // traffic goes through the same proxy as the Minecraft TCP session. This
    // matters because the voice server often correlates UDP source IP with the
    // TCP login IP — sending voice from the bot's real IP would instantly leak
    // our location and also fail servers that restrict UDP to known client IPs.
    if (this.proxy) {
      if (!SocksClient) {
        this._err(
          "proxy configured but 'socks' module not installed — " +
            'falling back to direct UDP (bot real IP will leak)'
        );
      } else {
        let primaryErr = null;
        this._log(
          `attempting SOCKS5 UDP ASSOCIATE via primary proxy ${this.proxy.host}:${this.proxy.port} ` +
            `(ssid=${_extractSsid(this.proxy.userId) || 'n/a'})`
        );
        try {
          await this._setupSocksUdpAssociate(this.proxy);
          this._activeProxyLabel = 'primary';
          this._activeProxyHost = this.proxy.host;
          this._activeProxyPort = this.proxy.port;
          this._activeProxySsid = _extractSsid(this.proxy.userId) || null;
          this._log(
            `✅ SOCKS5 UDP ASSOCIATE READY (primary) — proxy=${this.proxy.host}:${this.proxy.port} ` +
              `relay=${this._socksRelayHost}:${this._socksRelayPort} → voice=${this.voiceHost}:${this.voicePort} ` +
              `(ssid=${this._activeProxySsid || 'n/a'})`
          );
        } catch (e) {
          primaryErr = e;
          this._socksCtrlSocket = null;
          this._socksRelayHost = null;
          this._socksRelayPort = 0;
        }

        // If primary failed AND a fallback proxy is configured, try it next.
        // This is specifically aimed at "CommandNotSupported" rejections
        // (proxy is TCP-only); we re-attempt through a UDP-capable provider
        // with a freshly randomized -ssid-XXXX session.
        if (primaryErr && this.fallbackProxy) {
          this._err(
            `❌ SOCKS5 UDP ASSOCIATE failed on primary proxy ${this.proxy.host}:${this.proxy.port}: ` +
              `${primaryErr.message} — trying fallback proxy ${this.fallbackProxy.host}:${this.fallbackProxy.port} ` +
              `with randomized SSID`
          );
          const fb = _withRandomizedSsid(this.fallbackProxy);
          this._log(
            `attempting SOCKS5 UDP ASSOCIATE via fallback proxy ${fb.host}:${fb.port} ` +
              `(ssid=${_extractSsid(fb.userId) || 'n/a'}, original ssid=${_extractSsid(this.fallbackProxy.userId) || 'n/a'})`
          );
          try {
            await this._setupSocksUdpAssociate(fb);
            this._activeProxyLabel = 'fallback';
            this._activeProxyHost = fb.host;
            this._activeProxyPort = fb.port;
            this._activeProxySsid = _extractSsid(fb.userId) || null;
            this._log(
              `✅ SOCKS5 UDP ASSOCIATE READY (fallback) — proxy=${fb.host}:${fb.port} ` +
                `relay=${this._socksRelayHost}:${this._socksRelayPort} → voice=${this.voiceHost}:${this.voicePort} ` +
                `(ssid=${this._activeProxySsid || 'n/a'})`
            );
            primaryErr = null;
          } catch (e2) {
            this._err(
              `❌ SOCKS5 UDP ASSOCIATE failed on fallback proxy ${fb.host}:${fb.port}: ${e2.message} — ` +
                `falling back to direct UDP (bot's VPS IP will be visible to the voice server)`
            );
            this._socksCtrlSocket = null;
            this._socksRelayHost = null;
            this._socksRelayPort = 0;
          }
        } else if (primaryErr) {
          this._err(
            `❌ SOCKS5 UDP ASSOCIATE failed: ${primaryErr.message} — falling back to direct UDP ` +
              `(no VC_FALLBACK_PROXY configured; bot's VPS IP will be visible to the voice server)`
          );
        }
      }
    } else {
      this._log('no proxy configured — using direct UDP (bot VPS IP visible to voice server)');
    }

    try {
      this.udp = dgram.createSocket('udp4');
    } catch (e) {
      this._err(`dgram.createSocket failed: ${e.message}`);
      return;
    }

    this.udp.on('message', (msg /* rinfo */) => {
      try {
        let payload = msg;
        if (this._socksRelayHost) {
          // Incoming packets from the proxy are wrapped in a SOCKS5 UDP header
          const unwrapped = socks5UnwrapUdp(msg);
          if (!unwrapped) {
            if (this.debug) this._log(`drop malformed SOCKS5 UDP (len=${msg.length})`);
            return;
          }
          payload = unwrapped;
        }
        this._handleUdpPacket(payload);
      } catch (e) {
        this._err(`UDP packet handler error: ${e.message}`);
      }
    });
    this.udp.on('error', (err) => {
      this._err(`UDP socket error: ${err.message}`);
      this.emit('error', err);
      this.destroy('udp_error');
    });
    this.udp.on('close', () => {
      if (this._udpRefreshing) return;
      if (this.state !== 'closed') {
        this._log('UDP socket closed unexpectedly');
        this.state = 'closed';
      }
    });

    this.udp.bind(0, () => {
      this._sendAuthenticate();
      // Retry authenticate if no ack in 2s (up to 3 attempts)
      let attempts = 1;
      this._authTimer = setInterval(() => {
        if (this.state !== 'authenticating') {
          clearInterval(this._authTimer);
          this._authTimer = null;
          return;
        }
        if (attempts >= 4) {
          clearInterval(this._authTimer);
          this._authTimer = null;
          this._err('no AuthenticateAckPacket after 4 attempts — giving up');
          this.emit('error', new Error('SVC UDP auth timeout'));
          return;
        }
        attempts++;
        this._log(`retry AuthenticatePacket (attempt ${attempts}/4)`);
        this._sendAuthenticate();
      }, 2000);
    });
  }

  async _setupSocksUdpAssociate(proxy) {
    const info = await socksUdpAssociate({ proxy: proxy || this.proxy, timeoutMs: 10_000 });

    // info.socket is the TCP control channel — keeping it open keeps the
    // UDP association alive on the proxy.
    this._socksCtrlSocket = info.socket;
    // Some proxies return 0.0.0.0 as the relay host, meaning "same as proxy host"
    let relayHost = info.host;
    if (!relayHost || relayHost === '0.0.0.0' || relayHost === '::') {
      relayHost = this.proxy.host;
    }
    this._socksRelayHost = relayHost;
    this._socksRelayPort = info.port;

    this._socksCtrlSocket.on('close', () => {
      if (this.state !== 'closed') {
        this._err('SOCKS5 control socket closed — voice association lost');
        this.destroy('socks_closed');
      }
    });
    this._socksCtrlSocket.on('error', (err) => {
      this._err(`SOCKS5 control socket error: ${err.message}`);
    });
  }

  _sendAuthenticate() {
    const body = encodeAuthenticateBody(this.playerUuid, this.secret);
    this._sendEncrypted(body);
  }

  _sendConnectionCheck() {
    const body = encodeConnectionCheckBody();
    this._sendEncrypted(body);
  }

  _sendKeepAlive() {
    const body = encodeKeepAliveBody();
    this._sendEncrypted(body);
  }

  /** Wrap payload in magic+uuid+encrypted envelope and send via UDP. */
  _sendEncrypted(plaintextPayload) {
    if (!this.udp || !this.secret || !this.playerUuid) return;
    let encrypted;
    try {
      encrypted = aesGcmEncrypt(this.secret, plaintextPayload);
    } catch (e) {
      this._err(`encrypt failed: ${e.message}`);
      return;
    }
    const w = new MCBufWriter();
    w.writeByte(MAGIC_BYTE);
    w.writeUUID(this.playerUuid);
    w.writeByteArray(encrypted);
    const packet = w.toBuffer();

    let sendBuf = packet;
    let sendHost = this.voiceHost;
    let sendPort = this.voicePort;
    if (this._socksRelayHost) {
      sendBuf = socks5WrapUdp(packet, this.voiceHost, this.voicePort);
      sendHost = this._socksRelayHost;
      sendPort = this._socksRelayPort;
    }

    if (this.debug) {
      this._log(
        `UDP send len=${sendBuf.length} pid=0x${plaintextPayload[0].toString(16)} ` +
          `-> ${sendHost}:${sendPort}${this._socksRelayHost ? ' (via SOCKS5)' : ''}`
      );
    }

    this.udp.send(sendBuf, 0, sendBuf.length, sendPort, sendHost, (err) => {
      if (err) this._err(`UDP send failed: ${err.message}`);
    });
  }

  _handleUdpPacket(msg) {
    // Server -> client format (see NetworkMessage.writeServer):
    //   [byte MAGIC_BYTE=0xFF][VarInt payloadLen][payloadLen encrypted bytes]
    // Note: server-to-client packets do NOT include the player UUID. Only
    // client-to-server packets carry the UUID (since the server needs to
    // figure out which client's secret to decrypt with). Earlier versions of
    // this code read a UUID here and caused all incoming packets to fail to
    // parse (huge VarInt "payload length" = garbage encrypted bytes).
    if (msg.length < 2) return;
    const reader = new MCBufReader(msg);
    const magic = reader.readByte();
    if (magic !== MAGIC_BYTE) {
      if (this.debug) this._log(`ignoring UDP packet with bad magic 0x${magic.toString(16)}`);
      return;
    }
    let encrypted;
    try {
      encrypted = reader.readByteArray();
    } catch (e) {
      if (this.debug) this._log(`malformed server UDP packet: ${e.message}`);
      return;
    }

    let decrypted;
    try {
      decrypted = aesGcmDecrypt(this.secret, encrypted);
    } catch (e) {
      if (this.debug) this._err(`decrypt failed: ${e.message}`);
      return;
    }

    const inner = new MCBufReader(decrypted);
    const packetType = inner.readByte();

    switch (packetType) {
      case PACKET_ID.AUTHENTICATE_ACK:
        this._onAuthenticateAck();
        break;
      case PACKET_ID.CONNECTION_CHECK_ACK:
        this._onConnectionCheckAck();
        break;
      case PACKET_ID.CONNECTION_CHECK:
        // Server sometimes asks the client to prove it's still around — echo it back.
        this._sendConnectionCheck();
        break;
      case PACKET_ID.KEEPALIVE:
        // Server-initiated keepalive — respond with one of our own.
        this._sendKeepAlive();
        break;
      case PACKET_ID.PLAYER_SOUND:
      case PACKET_ID.GROUP_SOUND:
      case PACKET_ID.LOCATION_SOUND:
        // Recording subsystem (gated). We only parse if recording is enabled
        // AND the sender UUID matches an admin per shouldRecord(). All
        // other sound packets are dropped silently for performance.
        if (this.recording && this.recording.enabled) {
          try { this._handleIncomingSoundPacket(packetType, inner); } catch (e) {
            if (this.debug) this._err(`incoming sound parse error: ${e.message}`);
          }
        } else if (this.debug) {
          this._log(`received sound packet 0x${packetType.toString(16)} (ignored, recording=off)`);
        }
        break;
      case PACKET_ID.PING:
        // Ping packets carry {UUID id, long timestamp} — not needed for send-only bot.
        if (this.debug) this._log('received Ping (ignored)');
        break;
      default:
        if (this.debug) this._log(`unhandled packet type 0x${packetType.toString(16)}`);
    }
  }

  _onAuthenticateAck() {
    if (this._authTimer) {
      clearInterval(this._authTimer);
      this._authTimer = null;
    }
    if (this.state !== 'authenticating') return;
    this.state = 'connecting';
    this._log('AuthenticateAckPacket received — sending ConnectionCheckPacket');
    this._sendConnectionCheck();

    // Retry connection check if no ack
    let attempts = 1;
    this._connectionCheckTimer = setInterval(() => {
      if (this.state !== 'connecting') {
        clearInterval(this._connectionCheckTimer);
        this._connectionCheckTimer = null;
        return;
      }
      if (attempts >= 4) {
        clearInterval(this._connectionCheckTimer);
        this._connectionCheckTimer = null;
        this._err('no ConnectionCheckAckPacket after 4 attempts — giving up');
        this.emit('error', new Error('SVC UDP connection check timeout'));
        return;
      }
      attempts++;
      this._log(`retry ConnectionCheckPacket (attempt ${attempts}/4)`);
      this._sendConnectionCheck();
    }, 2000);
  }

  _onConnectionCheckAck() {
    if (this._connectionCheckTimer) {
      clearInterval(this._connectionCheckTimer);
      this._connectionCheckTimer = null;
    }
    if (this.state === 'connected') return;
    this.state = 'connected';
    this._log('ConnectionCheckAckPacket received — voice chat connection established');
    this.emit('connected');

    // Start keepalive loop
    if (this._keepAliveInterval) clearInterval(this._keepAliveInterval);
    this._keepAliveInterval = setInterval(() => {
      if (this.state !== 'connected') return;
      this._sendKeepAlive();
    }, this.keepAliveMs);
  }

  // ------------------------------------------------------------
  // Clip playback
  // ------------------------------------------------------------
  /**
   * Pick a random clip from the clip library. Returns {name, frames} or null
   * if no library is configured.
   */
  _pickRandomClip() {
    if (!this.clipLibrary || this.clipLibrary.length === 0) return null;
    const idx = Math.floor(Math.random() * this.clipLibrary.length);
    return this.clipLibrary[idx];
  }

  /** Stop bot mic stream immediately so the target can talk over us. */
  abortPlayback(reason = 'interrupt') {
    if (!this._playingClip) return false;
    this._playbackAbort = true;
    this._log(`playback abort requested (${reason})`);
    return true;
  }

  /**
   * Stream a single array of Opus frames to the voice server.
   * Returns true if fully played, false if aborted early.
   */
  async _streamFrames(frames, label = 'clip') {
    if (!Array.isArray(frames) || frames.length === 0) return true;
    const frameMs = this.playbackFrameMs;
    const start = Date.now();
    this._log(`stream[${label}]: streaming ${frames.length} Opus frames (~${Math.round(frames.length * frameMs)}ms)`);
    for (let i = 0; i < frames.length; i++) {
      if (this._playbackAbort || this.state !== 'connected') return false;
      const seq = this._sequenceNumber++;
      const body = encodeMicBody(frames[i], seq, false);
      this._sendEncrypted(body);

      const targetElapsed = (i + 1) * frameMs;
      const actualElapsed = Date.now() - start;
      const sleep = Math.max(0, targetElapsed - actualElapsed);
      if (sleep > 0) await delay(sleep);
    }
    return true;
  }

  /** Send the empty end-of-talk MicPacket sentinel (matches real client behavior). */
  _sendEndOfTalk() {
    if (this.state !== 'connected') return;
    const endSeq = this._sequenceNumber++;
    const endBody = encodeMicBody(Buffer.alloc(0), endSeq, false);
    this._sendEncrypted(endBody);
  }

  /**
   * Play a MULTI-STAGE sequence where one random clip is picked from each
   * stage and played in order, with a short natural pause between clips.
   * This is used for the voice1/voice2 layout: voice1 plays first, THEN
   * voice2 plays, simulating someone saying two things in a row.
   *
   * `stages` format: [{ name, clips: [{name, frames}, ...] }, ...]
   *
   * @param {Array} stages        Stages to play (defaults to this.clipStages)
   * @param {Object} [opts]
   * @param {number} [opts.gapMs=500]  Pause between stages in ms
   */
  async playClipSequence(stages = null, opts = {}) {
    const use = stages || this.clipStages;
    if (!use || use.length === 0) {
      throw new Error('playClipSequence: no clip stages configured');
    }
    if (this.state !== 'connected') {
      throw new Error(`playClipSequence: not connected (state=${this.state})`);
    }
    if (this._playingClip) {
      throw new Error('playClipSequence: already playing');
    }

    const minGap = typeof opts.gapMs === 'number' ? opts.gapMs : 500;
    const jitter = typeof opts.gapJitterMs === 'number' ? opts.gapJitterMs : 300;
    // Special dramatic pause before stage 3 (voice3): 3-4 seconds.
    const voice3PauseMinMs =
      typeof opts.voice3PauseMinMs === 'number' ? opts.voice3PauseMinMs : 3000;
    const voice3PauseMaxMs =
      typeof opts.voice3PauseMaxMs === 'number' ? opts.voice3PauseMaxMs : 4000;

    this._playingClip = true;
    this._playbackAbort = false;
    const overallStart = Date.now();
    const picked = [];

    try {
      for (let s = 0; s < use.length; s++) {
        const stage = use[s];
        if (!stage || !Array.isArray(stage.clips) || stage.clips.length === 0) {
          this._log(`playClipSequence: stage "${stage && stage.name}" is empty, skipping`);
          continue;
        }
        if (this.state !== 'connected' || this._playbackAbort) break;

        const idx = Math.floor(Math.random() * stage.clips.length);
        const clip = stage.clips[idx];
        picked.push(`${stage.name || `stage${s}`}:${clip.name}`);

        const ok = await this._streamFrames(clip.frames, `${stage.name || `stage${s}`}:${clip.name}`);
        if (!ok) break;

        // Natural pause between clips — long enough to sound like two separate
        // phrases, short enough that the server keeps the voice activity
        // indicator on through the whole utterance.
        const isLast = s === use.length - 1;
        if (!isLast && this.state === 'connected') {
          const nextStage = use[s + 1];
          const nextName = (nextStage && nextStage.name ? String(nextStage.name) : '').toLowerCase();
          const isBeforeThirdStage = s + 1 === 2; // zero-based: next stage is #3
          const isBeforeVoice3ByName = nextName === 'voice3';
          const useVoice3Pause = isBeforeThirdStage || isBeforeVoice3ByName;

          const gap = useVoice3Pause
            ? voice3PauseMinMs +
              Math.floor(Math.random() * Math.max(1, voice3PauseMaxMs - voice3PauseMinMs + 1))
            : minGap + Math.floor(Math.random() * jitter);
          await delay(gap);
        }
      }

      if (!this._playbackAbort) this._sendEndOfTalk();
      else this._log(`playClipSequence: aborted (${picked.join(' → ')})`);
      this._log(`playClipSequence: finished ${picked.join(' → ')} in ${Date.now() - overallStart}ms`);
      return !this._playbackAbort;
    } finally {
      this._playingClip = false;
      this._playbackAbort = false;
    }
  }

  /**
   * Streams pre-encoded Opus frames at 50 Hz (20 ms per frame).
   *
   * Call forms:
   *   playClip()                — if clipStages is configured, plays the full
   *                               sequence; otherwise pick a random clip from
   *                               clipLibrary, or fall back to clipFrames.
   *   playClip(Buffer[])        — play explicit frame array (no sequence)
   *   playClip('myclip')        — play clip named "myclip" from the library
   *
   * Returns true if playback finished, false if aborted.
   */
  async playClip(framesOrName = null) {
    // If staged clips are configured and no specific override was passed,
    // always play the full sequence — this is the voice1/voice2/... flow.
    if (framesOrName === null && this.clipStages && this.clipStages.length > 0) {
      return this.playClipSequence();
    }

    let use = null;
    let clipName = 'clip';

    if (Array.isArray(framesOrName)) {
      use = framesOrName;
    } else if (typeof framesOrName === 'string' && this.clipLibrary) {
      const hit = this.clipLibrary.find((c) => c.name === framesOrName);
      if (hit) { use = hit.frames; clipName = hit.name; }
    }

    if (!use) {
      const picked = this._pickRandomClip();
      if (picked) { use = picked.frames; clipName = picked.name; }
    }
    if (!use) use = this.clipFrames;

    if (!use || use.length === 0) {
      throw new Error('playClip: no clip frames loaded');
    }
    if (this.state !== 'connected') {
      throw new Error(`playClip: not connected (state=${this.state})`);
    }
    if (this._playingClip) {
      throw new Error('playClip: already playing');
    }

    this._playingClip = true;
    this._playbackAbort = false;
    const start = Date.now();

    try {
      const completed = await this._streamFrames(use, clipName);
      if (completed) {
        this._sendEndOfTalk();
        this._log(`playClip[${clipName}]: finished in ${Date.now() - start}ms`);
      } else {
        this._sendEndOfTalk();
        this._log(`playClip[${clipName}]: aborted after ${Date.now() - start}ms`);
      }
      return completed;
    } finally {
      this._playingClip = false;
      this._playbackAbort = false;
    }
  }

  // ------------------------------------------------------------
  // Cleanup
  // ------------------------------------------------------------
  /** Close UDP/SOCKS timers without removing the TCP plugin listener. */
  _teardownUdpSession(reason = 'refresh') {
    this._udpRefreshing = true;
    if (this._authTimer) {
      clearInterval(this._authTimer);
      this._authTimer = null;
    }
    if (this._connectionCheckTimer) {
      clearInterval(this._connectionCheckTimer);
      this._connectionCheckTimer = null;
    }
    if (this._keepAliveInterval) {
      clearInterval(this._keepAliveInterval);
      this._keepAliveInterval = null;
    }
    if (this.udp) {
      try {
        this.udp.removeAllListeners();
        this.udp.close();
      } catch (_) {}
      this.udp = null;
    }
    if (this._socksCtrlSocket) {
      try {
        this._socksCtrlSocket.destroy();
      } catch (_) {}
      this._socksCtrlSocket = null;
    }
    this._socksRelayHost = null;
    this._socksRelayPort = 0;
    for (const [uuid] of this._recSessions) {
      try { this._abortRecordingSession(uuid, reason); } catch (_) {}
    }
    this._udpRefreshing = false;
  }

  destroy(reason = 'destroy') {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this._log(`closing voice chat client (reason=${reason})`);

    if (this._secretTimeout) {
      clearTimeout(this._secretTimeout);
      this._secretTimeout = null;
    }
    this._teardownUdpSession('vc_closed');
    if (this.bot && this.bot._client) {
      try {
        if (this._boundOnCustomPayload) {
          this.bot._client.removeListener('custom_payload', this._boundOnCustomPayload);
        }
      } catch (_) {}
    }
    this.emit('closed', reason);
  }

  // ============================================================
  // Recording subsystem
  // ============================================================

  /**
   * Lazy-load @discordjs/opus's decoder. Same module already used by
   * voice_audio.js for outbound encoding, so no extra deps.
   */
  _ensureOpusDecoder() {
    if (this._opusDecoderCtor) return this._opusDecoderCtor;
    if (this._opusLoadAttempted) return null;
    this._opusLoadAttempted = true;
    try {
      this._opusDecoderCtor = require('@discordjs/opus').OpusEncoder;
      return this._opusDecoderCtor;
    } catch (e) {
      this._err(`recording disabled: failed to load @discordjs/opus: ${e.message}`);
      return null;
    }
  }

  /**
   * Parse the inner body of a PlayerSound / GroupSound / LocationSound packet.
   * SVC structure (compat_version 20, post-AES decrypt):
   *
   *   PlayerSound (0x02):
   *     UUID  channelId             // unused field
   *     UUID  sender                 // <-- WHO is talking
   *     VarInt+bytes  opusData
   *     long  sequenceNumber
   *     bool  whispering
   *     [optional float distance]
   *
   *   The first UUID after packetType is the channel/group ID; the second is
   *   the sender. Some servers may send slightly different layouts depending
   *   on plugin patches, so we read defensively and abort silently if the
   *   buffer underruns.
   */
  _handleIncomingSoundPacket(packetType, reader) {
    let senderUuid = null;
    let opusData = null;
    try {
      // First UUID: channel/group ID (we don't need it).
      reader.readUUID();
      // Second UUID: actual sender.
      senderUuid = reader.readUUID();
      // Opus payload, length-prefixed.
      opusData = reader.readByteArray();
    } catch (e) {
      if (this.debug) this._log(`sound packet parse abort: ${e.message}`);
      return;
    }
    if (!senderUuid || !opusData) return;

    // Resolve target username for interrupt (fast path) and recording.
    let username = null;
    try {
      if (this.recording.shouldInterrupt) {
        username = this.recording.shouldInterrupt(senderUuid);
      }
      if (!username) username = this.recording.shouldRecord(senderUuid);
    } catch (_) {
      username = null;
    }

    // Interrupt bot playback whenever the target sends voice — not only on
    // the first packet of a new recording session.
    if (opusData.length > 0 && username) {
      if (this._playingClip) {
        this.abortPlayback('target_speaking');
      }
      this.emit('adminSpeechStart', {
        uuid: senderUuid,
        username,
        continued: !!this._recSessions.get(senderUuid),
      });
    }

    if (!username) return;

    // Empty opus payload = end-of-talk sentinel (real client sends one when
    // the user releases push-to-talk). Treat it as "force finalize now".
    if (opusData.length === 0) {
      const session = this._recSessions.get(senderUuid);
      if (session) {
        if (this.debug) this._log(`recording ${username}: end-of-talk sentinel — finalizing`);
        this._finalizeRecordingSession(senderUuid).catch((e) => {
          this._err(`recording finalize error: ${e.message}`);
        });
      }
      return;
    }

    let session = this._recSessions.get(senderUuid);
    if (!session) {
      const Decoder = this._ensureOpusDecoder();
      if (!Decoder) return;
      let decoder;
      try {
        decoder = new Decoder(48000, 1);
      } catch (e) {
        this._err(`recording: opus decoder ctor failed: ${e.message}`);
        return;
      }
      session = {
        uuid: senderUuid,
        username,
        opusFrames: [],
        startedAt: Date.now(),
        lastPacketAt: Date.now(),
        decoder,
        silenceTimer: null,
        finalizing: false,
      };
      this._recSessions.set(senderUuid, session);
      this._log(`recording started for "${username}" (uuid=${senderUuid.slice(0, 8)}...)`);
    }

    session.opusFrames.push(Buffer.from(opusData));
    session.lastPacketAt = Date.now();
    session.username = username; // refresh label in case it changes mid-clip

    // Hard cap: never let a runaway recording grow beyond maxClipMs.
    const elapsed = Date.now() - session.startedAt;
    if (elapsed >= this.recording.maxClipMs) {
      if (this.debug) this._log(`recording ${username}: maxClipMs ${this.recording.maxClipMs}ms reached — finalizing`);
      this._finalizeRecordingSession(senderUuid).catch((e) => {
        this._err(`recording finalize error: ${e.message}`);
      });
      return;
    }

    // Reset the silence timer — when no packets arrive for silenceMs, we
    // assume the talker stopped and finalize the clip.
    if (session.silenceTimer) clearTimeout(session.silenceTimer);
    session.silenceTimer = setTimeout(() => {
      this._finalizeRecordingSession(senderUuid).catch((e) => {
        this._err(`recording finalize error: ${e.message}`);
      });
    }, this.recording.silenceMs);
  }

  _abortRecordingSession(uuid, reason) {
    const session = this._recSessions.get(uuid);
    if (!session) return;
    if (session.silenceTimer) {
      clearTimeout(session.silenceTimer);
      session.silenceTimer = null;
    }
    this._recSessions.delete(uuid);
    if (this.debug) this._log(`recording aborted for "${session.username}" (${reason})`);
  }

  /**
   * Decode all buffered opus frames into PCM, pipe through ffmpeg to write
   * a real MP3 on disk, then emit `adminVoiceClip` so the host bot can
   * upload it. Idempotent — second call for the same UUID is a no-op.
   */
  async _finalizeRecordingSession(uuid) {
    const session = this._recSessions.get(uuid);
    if (!session || session.finalizing) return;
    session.finalizing = true;
    if (session.silenceTimer) {
      clearTimeout(session.silenceTimer);
      session.silenceTimer = null;
    }
    const { username: sessionUsername, startedAt } = session;
    this._recSessions.delete(uuid);

    this.emit('adminSpeechEnd', {
      uuid,
      username: sessionUsername,
      durationMs: Date.now() - startedAt,
    });

    const durationMs = Date.now() - startedAt;
    const frameCount = session.opusFrames.length;

    if (durationMs < this.recording.minClipMs || frameCount === 0) {
      this._log(
        `recording discarded for "${session.username}": too short ` +
        `(${durationMs}ms < ${this.recording.minClipMs}ms, frames=${frameCount})`
      );
      return;
    }

    // Decode every opus frame back to s16le PCM. SVC frames are 20ms @ 48kHz mono.
    const pcmChunks = [];
    let decodedFrames = 0;
    for (const opus of session.opusFrames) {
      try {
        const pcm = session.decoder.decode(opus);
        pcmChunks.push(Buffer.from(pcm));
        decodedFrames++;
      } catch (e) {
        if (this.debug) this._log(`recording: opus decode error frame ${decodedFrames}: ${e.message}`);
      }
    }
    if (decodedFrames === 0) {
      this._log(`recording: 0 frames decoded for "${session.username}", aborting`);
      return;
    }
    const pcmBuf = Buffer.concat(pcmChunks);

    // Sanitize username for filename use (alphanumerics + underscore only).
    const safeName = String(session.username || 'unknown').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 32);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const fs = require('fs');
    const path = require('path');
    if (!fs.existsSync(this.recording.outputDir)) {
      try { fs.mkdirSync(this.recording.outputDir, { recursive: true }); } catch (_) {}
    }
    const mp3Path = path.join(this.recording.outputDir, `${ts}_${safeName}.mp3`);

    // Pipe PCM -> ffmpeg -> mp3. Use the same ffmpeg path resolution as
    // voice_audio.js so installer-shipped or system ffmpeg both work.
    let ffmpegPath;
    try { ffmpegPath = require('@ffmpeg-installer/ffmpeg').path; }
    catch (_) { ffmpegPath = 'ffmpeg'; }
    const { spawn } = require('child_process');
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '1',
      '-i', 'pipe:0',
      '-codec:a', 'libmp3lame',
      '-b:a', '96k',
      '-y',
      mp3Path,
    ];
    const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    const errChunks = [];
    proc.stderr.on('data', (c) => errChunks.push(c));

    const exitPromise = new Promise((resolve, reject) => {
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(errChunks).toString('utf8').trim()}`));
      });
    });

    try {
      await new Promise((resolve, reject) => {
        proc.stdin.on('error', reject);
        proc.stdin.write(pcmBuf, (err) => err ? reject(err) : resolve());
      });
      proc.stdin.end();
      await exitPromise;
    } catch (e) {
      this._err(`recording: ffmpeg encode failed for "${session.username}": ${e.message}`);
      return;
    }

    let fileSize = 0;
    try { fileSize = fs.statSync(mp3Path).size; } catch (_) {}
    this._log(
      `recording saved: "${session.username}" -> ${path.basename(mp3Path)} ` +
      `(${(durationMs / 1000).toFixed(1)}s, ${decodedFrames} frames, ${fileSize} bytes)`
    );

    // Hand off to the host bot for Discord upload.
    this.emit('adminVoiceClip', {
      uuid,
      username: session.username,
      mp3Path,
      durationMs,
      decodedFrames,
      fileSize,
    });
  }

  // ------------------------------------------------------------
  // Logging
  // ------------------------------------------------------------
  _log(msg) {
    const line = `${this.botTag} [VC] ${msg}`;
    console.log(line);
    if (this.onLog) this.onLog(line);
  }
  _err(msg) {
    const line = `${this.botTag} [VC] ERROR: ${msg}`;
    console.log(line);
    if (this.onLog) this.onLog(line);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  VoiceChatClient,
  PACKET_ID,
  DEFAULT_COMPAT_VERSION,
  MAGIC_BYTE,
};
