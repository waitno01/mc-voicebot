'use strict';
// voicebot — entry point. Force color through PM2 pipes, load env, run.
if (!process.env.FORCE_COLOR) process.env.FORCE_COLOR = '1';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config();

const { main } = require('./src/index');
main().catch((e) => {
  console.error(`[voicebot] fatal: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
