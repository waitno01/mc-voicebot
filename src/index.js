'use strict';
// voicebot — orchestration: init state DB, then launch the configured bot range.
const chalk = require('chalk');
const gradient = require('gradient-string');
const { once } = require('events');
const {
  bootLog, DEBUG_MODE, DEBUG_TPAHERE_TARGET, DISCORD_INVITE, END_BOT,
  MSA_CACHE_PREFIX, RTPQUEUE_COMMAND, RTPQUEUE_MAX_MS, RTPQUEUE_PAIR_RADIUS,
  RTPQUEUE_WAIT_MS, START_BOT, START_DELAY_MS, VCBOTLOGS_WEBHOOK, webhookLogger,
} = require('./config');
const { initStateDb } = require('./state');
const { VoiceAdBot } = require('./bot');

async function main() {
  bootLog(gradient.vice.multiline('voicead — DonutSMP proximity-voice recruiter'));
  bootLog(chalk.cyan(`Bots ${START_BOT}..${END_BOT} | proxies botproxyN | caches .msa-cache-${MSA_CACHE_PREFIX}-N`));
  bootLog(chalk.cyan(
    `RTPQueue: ${RTPQUEUE_COMMAND} | watch ${Math.round(RTPQUEUE_WAIT_MS / 1000)}s | ` +
    `max queue ${Math.round(RTPQUEUE_MAX_MS / 1000)}s | pair radius ${RTPQUEUE_PAIR_RADIUS}`
  ));
  if (VCBOTLOGS_WEBHOOK.startsWith('http')) {
    bootLog(chalk.cyan('Discord log webhook: vcbotlogs (enabled)'));
  }
  bootLog(chalk.cyan(`Discord invite: ${DISCORD_INVITE}`));
  if (DEBUG_MODE) {
    if (DEBUG_TPAHERE_TARGET) {
      bootLog(chalk.magenta(`[DEBUG] enabled — first tpahere will target: ${DEBUG_TPAHERE_TARGET}`));
    } else {
      bootLog(chalk.yellow('[DEBUG] enabled but tpahere= is empty — using normal player_list.txt picks'));
    }
  }

  await initStateDb();

  if (webhookLogger.enabled()) {
    webhookLogger.startup();
  }

  for (let i = START_BOT; i <= END_BOT; i++) {
    const bot = new VoiceAdBot(i);
    // Stagger startups so we don't auth-storm / all connect at once.
    setTimeout(() => {
      bot.start().catch((e) => console.error(chalk.red(`[Bot ${i}] start error: ${e.message}`)));
    }, (i - START_BOT) * START_DELAY_MS);
  }
}



module.exports = { main };

if (require.main === module) {
  main().catch((e) => {
    console.error(chalk.red(`[voicebot] fatal: ${e && e.stack ? e.stack : e}`));
    process.exit(1);
  });
}
