# voicebot

Proximity-voice conversation bot pool for Minecraft servers. Each bot joins the
server via mineflayer through its SOCKS5 proxy, one elected bot scans online Java
players into `player_list.txt`, and each bot `/tpahere`s an un-contacted player,
clicks the confirm GUI, then holds a live AI voice conversation with them
(Simple Voice Chat audio in/out + ElevenLabs TTS/STT + OpenRouter LLM).

**The bot's personality, topic, and goal are entirely yours to define.** What it
says is driven by the prompt files — the bot can just chat and banter, role-play a
persona, answer questions, promote something, or anything else. You control all of
that through `prompts/` (or the `VOICEAD_*_FILE` env vars); nothing about the
personality is hardcoded. The shipped example prompts are neutral scaffolding
showing the recommended structure (name handling, one-line replies, TTS-safe
wording) with the personality/goal left as placeholders for you to fill in.

This is a refactored standalone clone of the original `voicead.js` (plus its
`voice_chat.js` / `voice_audio.js` / `voice_ai.js` helpers), split into modules
with all secrets and account labels moved into `.env`.

## Layout

```
voicebot.js          Entry point (FORCE_COLOR, load .env, run src/index)
src/
  config.js          config, chat parsing, prompt loading, speech shaping, webhooks
  state.js           contacted-target dedupe (SQLite) + player list + proxy resolve
  bot.js             VoiceAdBot: join, scan, tpahere, confirm GUI, AI conversation
  index.js           main(): init state DB, launch the bot range
  voice_chat.js      Simple Voice Chat client (UDP/opus)  [verbatim from original]
  voice_audio.js     ffmpeg/opus clip pre-encoding        [verbatim from original]
  voice_ai.js        ElevenLabs + OpenRouter voice AI     [verbatim from original]
prompts/             neutral prompt templates you edit (*.example.txt)
examples/            reference example files
mp3_voice/           generated/recorded audio (gitignored)
```

## Setup

```bash
npm install
cp .env.example .env      # fill in ELEVENLABS/OPENROUTER keys, proxies, webhook
# write your own bot personality/goal into the prompts, then activate them
# (otherwise a neutral built-in fallback prompt is used):
for f in prompts/*.example.txt; do cp "$f" "$(basename "${f%.example.txt}").txt"; done
npm start                 # or: pm2 start ecosystem.config.js
```

On first launch each bot prints a `microsoft.com/link` device code. Approve it
once; the session is cached under `.msa-cache-<MSA_CACHE_PREFIX>-<botNumber>/`.

## Configuration

Everything is driven by `.env` (see `.env.example`):

- **Bot pool**: `START_BOT`..`END_BOT`, `SERVER_HOST/PORT`, `MSA_*`.
- **Proxies**: `botproxy<N>` per bot (SOCKS5), `USE_PROXY_UDP` for voice.
- **AI voice**: `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `OPENROUTER_API_KEY`,
  `OPENROUTER_MODEL`. If unset, voice is disabled but the join/tpahere/confirm
  flow still runs.
- **Logging/links**: `VCBOTLOGS` webhook, plus any link/ID your prompt references
  (e.g. `VOICEAD_DISCORD_INVITE`, channel IDs) — optional and only used if your
  own prompt tells the bot to mention them.

### Prompts (the bot's personality)

The bot says whatever your prompts tell it to — chat, banter, role-play, help,
promote, etc. Four prompt files control it, each with a neutral `*.example.txt`
template you edit:

- `voicead_prompt.txt` — base ongoing-conversation prompt (main personality/goal).
- `voicead_pitch_prompt.txt` — the one-line opener said right after they teleport in.
- `voicead_greeting_prompt.txt` — the first greeting line.
- `voicead_discord_context.txt` — optional extra facts/knowledge to inject (delete
  if unused).

Copy each `prompts/*.example.txt` to the repo root without `.example`, edit it, or
point the matching `VOICEAD_*_FILE` env var at a custom path. If a file is absent,
a neutral built-in fallback is used. Recommended structure to keep in any prompt:
one short idea per reply, TTS-safe spoken wording, letters-only name handling, and
never revealing that it is automated.

## Notes

- Runtime behaviour (join/scan/tpahere/voice flow) mirrors the original
  `voicead.js`; the refactor reorganizes code, externalizes hardcoded IDs/labels
  into `.env`, and replaces the original baked-in prompt with neutral, owner-defined
  templates. The three `voice_*` helpers are copied verbatim.
- Native deps `@discordjs/opus` and `@ffmpeg-installer/ffmpeg` power voice; if
  they fail to build, the bot loads with voice gracefully disabled.
