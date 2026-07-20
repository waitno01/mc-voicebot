'use strict';

/**
 * voice_audio.js
 *
 * Pre-encodes an audio file (any format ffmpeg understands) into an array of
 * 20ms Opus frames ready to stream via Simple Voice Chat MicPackets.
 *
 * SVC uses:
 *   - 48000 Hz sample rate, mono
 *   - 20 ms frames  -> 960 samples/frame -> 1920 bytes of s16le PCM
 *   - Opus codec (VOIP application) for "voice" codec setting
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SAMPLE_RATE = 48000;
const CHANNELS = 1;
const FRAME_SAMPLES = 960; // 20 ms @ 48 kHz
const FRAME_BYTES_PCM = FRAME_SAMPLES * 2 * CHANNELS; // s16le = 2 bytes/sample

let ffmpegPath;
try {
  ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
} catch (e) {
  ffmpegPath = 'ffmpeg';
}

let OpusEncoderCtor;
let _opusLoadError = null;
try {
  OpusEncoderCtor = require('@discordjs/opus').OpusEncoder;
} catch (e) {
  OpusEncoderCtor = null;
  _opusLoadError = e;
  // Surface the REAL error — a silent catch here hides glibc/ABI/ENOENT bugs
  // and makes "clip pre-encode failed" messages useless for debugging.
  console.log(`[voice_audio] @discordjs/opus load failed: ${e.message}`);
  if (e.code) console.log(`[voice_audio] error code: ${e.code}`);
}

/**
 * Transcode `filePath` to raw 48kHz mono s16le PCM using ffmpeg, returning a
 * single Buffer with all samples.
 */
function transcodeToPcm(filePath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      reject(new Error(`Voice clip not found: ${path.resolve(filePath)}`));
      return;
    }

    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', filePath,
      '-f', 's16le',
      '-ac', String(CHANNELS),
      '-ar', String(SAMPLE_RATE),
      '-acodec', 'pcm_s16le',
      'pipe:1',
    ];

    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    const errChunks = [];

    proc.stdout.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', (c) => errChunks.push(c));
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code !== 0) {
        const msg = Buffer.concat(errChunks).toString('utf8').trim();
        reject(new Error(`ffmpeg exited ${code}: ${msg || 'unknown error'}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

/**
 * Slice raw s16le PCM into exact 20ms frames, zero-padding the last partial
 * frame so playback ends cleanly.
 */
function sliceIntoPcmFrames(pcmBuf) {
  const frames = [];
  let offset = 0;
  while (offset + FRAME_BYTES_PCM <= pcmBuf.length) {
    frames.push(pcmBuf.subarray(offset, offset + FRAME_BYTES_PCM));
    offset += FRAME_BYTES_PCM;
  }
  if (offset < pcmBuf.length) {
    // Pad remainder with silence to a full frame
    const tail = Buffer.alloc(FRAME_BYTES_PCM);
    pcmBuf.copy(tail, 0, offset);
    frames.push(tail);
  }
  return frames;
}

/**
 * Pre-encode a clip on disk into an array of Opus frames.
 *
 * @param {string} filePath   Path to input audio (mp3/wav/ogg/etc).
 * @returns {Promise<Buffer[]>}  Array of Opus-encoded frames.
 */
async function preencodeClip(filePath) {
  if (!OpusEncoderCtor) {
    const detail = _opusLoadError ? `: ${_opusLoadError.message}` : '';
    throw new Error(
      '@discordjs/opus is not installed or failed to load' + detail +
      '. Run: npm install @discordjs/opus'
    );
  }

  const pcm = await transcodeToPcm(filePath);
  if (pcm.length === 0) {
    throw new Error(`ffmpeg produced 0 bytes of PCM for ${filePath}`);
  }

  const pcmFrames = sliceIntoPcmFrames(pcm);
  const encoder = new OpusEncoderCtor(SAMPLE_RATE, CHANNELS);

  const opusFrames = [];
  for (const pcmFrame of pcmFrames) {
    const opus = encoder.encode(pcmFrame);
    // Copy out of the encoder's internal buffer because subsequent encodes reuse it
    opusFrames.push(Buffer.from(opus));
  }

  return opusFrames;
}

/**
 * Generate silent Opus frames for pauses between TTS segments (e.g. letter spelling).
 * @param {number} durationMs  Pause length in milliseconds.
 * @returns {Buffer[]}
 */
function silentOpusFrames(durationMs) {
  if (!OpusEncoderCtor || !Number.isFinite(durationMs) || durationMs <= 0) return [];
  const frameCount = Math.max(1, Math.ceil(durationMs / 20));
  const encoder = new OpusEncoderCtor(SAMPLE_RATE, CHANNELS);
  const silentPcm = Buffer.alloc(FRAME_BYTES_PCM);
  const frames = [];
  for (let i = 0; i < frameCount; i++) {
    frames.push(Buffer.from(encoder.encode(silentPcm)));
  }
  return frames;
}

/**
 * Pre-encode every audio file in a directory (or a single file) into an array
 * of { name, frames } records. Useful when you want the bot to pick a random
 * clip at trigger time rather than replaying the same one every call.
 *
 * Supported extensions: .mp3 .wav .ogg .opus .m4a .aac .flac
 *
 * @param {string} clipPath  Path to a single audio file or a directory containing them.
 * @returns {Promise<Array<{ name: string, path: string, frames: Buffer[] }>>}
 */
async function preencodeClipsFromPath(clipPath) {
  if (!fs.existsSync(clipPath)) {
    throw new Error(`Voice clip path not found: ${path.resolve(clipPath)}`);
  }

  const stat = fs.statSync(clipPath);
  let files = [];

  if (stat.isDirectory()) {
    const allowed = new Set(['.mp3', '.wav', '.ogg', '.opus', '.m4a', '.aac', '.flac']);
    const entries = fs.readdirSync(clipPath)
      .filter((f) => allowed.has(path.extname(f).toLowerCase()))
      .sort();
    files = entries.map((f) => path.join(clipPath, f));
    if (files.length === 0) {
      throw new Error(`No supported audio files found in ${path.resolve(clipPath)}`);
    }
  } else {
    files = [clipPath];
  }

  const out = [];
  for (const f of files) {
    const frames = await preencodeClip(f);
    out.push({
      name: path.basename(f, path.extname(f)),
      path: f,
      frames,
    });
  }
  return out;
}

/**
 * Auto-detect the clip layout inside a directory and pre-encode accordingly.
 *
 * Supported layouts:
 *
 *   A) Staged sequence — `mp3_voice/voice1/*.mp3`, `mp3_voice/voice2/*.mp3`, ...
 *      Each `voiceN` folder is one stage. At trigger time, one clip is picked
 *      at random from each stage and played in order with a small pause
 *      between them. Any naturally-sortable prefix works (voice1 before voice2
 *      before voice3 etc.). Non-`voiceN` subfolders are ignored.
 *
 *   B) Flat library — `mp3_voice/*.mp3`
 *      A single pool; one random clip is picked per trigger (single stage).
 *
 *   C) Single file — `voice.mp3`
 *      Always plays that exact file.
 *
 * Returns one of:
 *   { mode: 'sequenced', stages: [{ name, clips: [{name, path, frames}] }, ...] }
 *   { mode: 'library',   clips:  [{name, path, frames}, ...] }
 *   { mode: 'single',    clips:  [{name, path, frames}] }
 */
async function preencodeClipTree(basePath) {
  if (!fs.existsSync(basePath)) {
    throw new Error(`Voice clip path not found: ${path.resolve(basePath)}`);
  }
  const stat = fs.statSync(basePath);

  // Single file
  if (!stat.isDirectory()) {
    const frames = await preencodeClip(basePath);
    return {
      mode: 'single',
      clips: [{
        name: path.basename(basePath, path.extname(basePath)),
        path: basePath,
        frames,
      }],
    };
  }

  const entries = fs.readdirSync(basePath);

  // Look for voice1/, voice2/, ... subfolders (case-insensitive, any digits)
  const stageDirs = entries
    .map((name) => ({ name, abs: path.join(basePath, name) }))
    .filter((e) => {
      try { return fs.statSync(e.abs).isDirectory() && /^voice\d+$/i.test(e.name); }
      catch { return false; }
    })
    .sort((a, b) => {
      const na = parseInt(a.name.match(/\d+/)[0], 10);
      const nb = parseInt(b.name.match(/\d+/)[0], 10);
      return na - nb;
    });

  if (stageDirs.length > 0) {
    const stages = [];
    for (const s of stageDirs) {
      const clips = await preencodeClipsFromPath(s.abs);
      stages.push({ name: s.name, clips });
    }
    return { mode: 'sequenced', stages };
  }

  // Flat library
  const clips = await preencodeClipsFromPath(basePath);
  return { mode: 'library', clips };
}

module.exports = {
  preencodeClip,
  preencodeClipsFromPath,
  preencodeClipTree,
  silentOpusFrames,
  SAMPLE_RATE,
  CHANNELS,
  FRAME_SAMPLES,
  FRAME_BYTES_PCM,
};
