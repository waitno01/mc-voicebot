'use strict';
// voicebot — persistent state: contacted-target dedupe (SQLite) + player list I/O
// + per-bot proxy resolution.
const chalk = require('chalk');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const { JAVA_USERNAME_RE, PLAYER_LIST_FILE, STATE_DB_FILE } = require('./config');

// ============================================================
// State DB (contacted-target dedupe)
// ============================================================

let stateDb = null;

async function initStateDb() {
  stateDb = await open({ filename: STATE_DB_FILE, driver: sqlite3.Database });
  await stateDb.exec(`
    CREATE TABLE IF NOT EXISTS tried_targets (
      username   TEXT PRIMARY KEY,
      status     TEXT,
      accepted   INTEGER DEFAULT 0,
      bot_number INTEGER,
      tried_at   INTEGER,
      updated_at INTEGER
    );
  `);
  console.log(chalk.cyan(`[State] tried-targets DB ready: ${STATE_DB_FILE}`));
}

/** Set of every username we've already contacted (any status). */
async function getTriedSet() {
  const rows = await stateDb.all('SELECT username FROM tried_targets');
  return new Set(rows.map((r) => String(r.username).toLowerCase()));
}

/**
 * Atomically claim a target so no other bot in the pool contacts them.
 * Returns true if this call won the claim (row newly inserted).
 */
async function claimTarget(username, botNumber) {
  const now = Date.now();
  const res = await stateDb.run(
    `INSERT OR IGNORE INTO tried_targets (username, status, accepted, bot_number, tried_at, updated_at)
     VALUES (?, 'requested', 0, ?, ?, ?)`,
    [username, botNumber, now, now]
  );
  return res.changes === 1;
}

async function updateTarget(username, status, accepted) {
  await stateDb.run(
    `UPDATE tried_targets SET status = ?, accepted = ?, updated_at = ? WHERE username = ?`,
    [status, accepted ? 1 : 0, Date.now(), username]
  );
}

/** Remove a claim so the player can be retried (transient send/confirm failures). */
async function unclaimTarget(username) {
  await stateDb.run(`DELETE FROM tried_targets WHERE username = ?`, [username]);
}

// ============================================================
// player_list.txt
// ============================================================

const poolBotUsernames = new Set(); // our own bots — never contact these

function writePlayerList(names) {
  try {
    const tmp = PLAYER_LIST_FILE + '.tmp';
    fs.writeFileSync(tmp, names.join('\n') + '\n');
    fs.renameSync(tmp, PLAYER_LIST_FILE);
  } catch (e) {
    console.error(chalk.red(`[Scanner] Failed to write player_list.txt: ${e.message}`));
  }
}

function readPlayerList() {
  try {
    if (!fs.existsSync(PLAYER_LIST_FILE)) return [];
    return fs.readFileSync(PLAYER_LIST_FILE, 'utf8')
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => JAVA_USERNAME_RE.test(s));
  } catch (_) {
    return [];
  }
}

// ============================================================
// Proxy
// ============================================================

function getBotProxy(botNumber) {
  const raw =
    process.env[`botproxy${botNumber}`] ||
    process.env[`BOTPROXY${botNumber}`] ||
    process.env[`Botproxy${botNumber}`];
  if (!raw) {
    console.error(chalk.red(`[Bot ${botNumber}] botproxy${botNumber} not found in .env`));
    return null;
  }
  try {
    const s = raw.trim();
    let hostPort, userId, password;
    if (s.includes('@')) {
      // host:port@user:pass
      const [hp, cred] = [s.split('@')[0], s.split('@').slice(1).join('@')];
      hostPort = hp;
      const ci = cred.indexOf(':');
      userId = ci === -1 ? cred || null : cred.slice(0, ci) || null;
      password = ci === -1 ? null : cred.slice(ci + 1) || null;
    } else {
      const parts = s.split(':');
      if (parts.length >= 4) {
        hostPort = `${parts[0]}:${parts[1]}`;
        userId = parts[2] || null;
        password = parts.slice(3).join(':') || null;
      } else {
        hostPort = s;
        userId = null;
        password = null;
      }
    }
    const [host, portStr] = hostPort.split(':');
    const port = parseInt((portStr || '').trim(), 10);
    if (!host || !Number.isFinite(port)) {
      throw new Error(`bad host/port in "${raw}"`);
    }
    return { host: host.trim(), port, userId, password, type: 5 };
  } catch (e) {
    console.error(chalk.red(`[Bot ${botNumber}] proxy parse error: ${e.message}`));
    return null;
  }
}

module.exports = {
  initStateDb, getTriedSet, claimTarget, updateTarget, unclaimTarget,
  writePlayerList, readPlayerList, getBotProxy,
};
