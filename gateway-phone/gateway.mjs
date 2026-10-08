#!/usr/bin/env node
// Abhyaas SMS gateway for an Android phone running Termux. No dependencies.
//
//   LAPTOP_URL=http://192.168.43.12:3001 node gateway.mjs      (SIM_SLOT=1 optional)
//
// Every 3s: read the SMS inbox, POST each new SMS to the laptop, text back the
// reply. Every 5s: send what the laptop queued in its outbox. Every 30s: a
// heartbeat, so the laptop shows "Phone gateway: connected".
//
// Two promises, kept with the state files next to this script (gitignored):
// - A graded reply that fails to send is resent from .pending.json; the
//   laptop is never asked again, so an answer is never graded twice.
// - An outbox message is marked 'sending' on disk before it is sent and is
//   never sent again after that, even across a crash.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const VERSION = 1;
const CMD_TIMEOUT_MS = 20_000;
const INCOMING_TIMEOUT_MS = 60_000;
const API_TIMEOUT_MS = 10_000;
const MAX_REPLY_TRIES = 5;
const BACKOFF = [1, 3, 6, 12]; // x RETRY_MS (default 5s): 5s, 15s, 30s, 60s

const cleanNumber = (s) => String(s ?? '').replace(/[\s()-]/g, '');

// A real sender, not NTC / BANK / a short code.
export const isPhoneNumber = (sender) => /^\+?\d{7,15}$/.test(cleanNumber(sender));

// Same as the server's normalizePhone() + maskPhone(): +977 9800000001 -> 98******01.
export function maskPhone(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  const s = digits.length === 13 && digits.startsWith('977') ? digits.slice(3) : digits;
  if (s.length <= 4) return '*'.repeat(s.length);
  return s.slice(0, 2) + '*'.repeat(s.length - 4) + s.slice(-2);
}

// Sender names like "NTC" are fine to log; anything else is masked.
const who = (sender) => (/[A-Za-z]/.test(String(sender)) ? String(sender).slice(0, 20) : maskPhone(sender));

const pad = (n) => String(n).padStart(2, '0');
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const log = (msg) => console.log(`[${stamp()}] ${msg}`);

// A problem is logged once when it starts, not every tick (quiet when idle).
const problems = new Map();
function problem(key, msg) {
  if (problems.get(key) === msg) return;
  problems.set(key, msg);
  log(msg);
}
function resolved(key, msg) {
  if (!problems.delete(key)) return;
  if (msg) log(msg);
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: CMD_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }),
    );
  });
}

// Why a command failed, without err.message: it holds the full command line,
// i.e. the student's number and the SMS text.
function failure(cmd, { err, stderr }) {
  if (err.code === 'ENOENT') return `${cmd} not found. Run: pkg install termux-api, and install the Termux:API app from F-Droid.`;
  const why = err.killed ? 'timed out' : `exit ${err.code}`;
  const detail = stderr.trim().split('\n')[0].slice(0, 120);
  return `${cmd} failed (${why})${detail ? `: ${detail}` : ''}`;
}

function main() {
  const url = (process.env.LAPTOP_URL || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/\S+$/.test(url)) {
    console.error('Usage: LAPTOP_URL=http://<laptop-ip>:3001 node gateway.mjs');
    console.error('The laptop prints the exact command when the Abhyaas server starts.');
    process.exit(1);
  }
  const simSlot = (process.env.SIM_SLOT || '').trim();
  if (simSlot && !/^\d$/.test(simSlot)) {
    console.error('SIM_SLOT must be a single digit, e.g. SIM_SLOT=1');
    process.exit(1);
  }
  const every = (name, fallback) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : fallback);
  const POLL_MS = every('POLL_MS', 3000);
  const OUTBOX_MS = every('OUTBOX_MS', 5000);
  const HEARTBEAT_MS = every('HEARTBEAT_MS', 30_000);
  const RETRY_MS = every('RETRY_MS', 5000);

  const stateDir = process.env.STATE_DIR || path.dirname(fileURLToPath(import.meta.url));
  const LAST_ID_FILE = path.join(stateDir, '.last-id');
  const PENDING_FILE = path.join(stateDir, '.pending.json');

  // ---- state ---------------------------------------------------------------

  function writeAtomic(file, text) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  }

  function save(file, text) {
    try {
      writeAtomic(file, text);
      resolved(`save:${file}`, `Saving ${path.basename(file)} works again.`);
      return true;
    } catch (err) {
      problem(`save:${file}`, `Cannot save ${path.basename(file)}: ${err.message}`);
      return false;
    }
  }

  // null = first start: everything already in the inbox counts as seen.
  let lastId = null;
  try {
    const n = Number(fs.readFileSync(LAST_ID_FILE, 'utf8').trim());
    if (Number.isInteger(n) && n >= 0) lastId = n;
  } catch {}

  // replies: graded replies still to send, [{ smsId, phone, body, outboxId, tries, nextAt }]
  // outbox:  outbox id -> 'sending' (send in progress) | 'sent' | 'failed' (to report)
  let pending = { replies: [], outbox: {} };
  try {
    const p = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
    pending = { replies: Array.isArray(p.replies) ? p.replies : [], outbox: p.outbox && typeof p.outbox === 'object' ? p.outbox : {} };
  } catch {}

  const saveLastId = () => save(LAST_ID_FILE, `${lastId}\n`);
  const savePending = () => save(PENDING_FILE, `${JSON.stringify(pending, null, 1)}\n`);

  // A crash while sending: we can't know whether it went out, so it is
  // reported failed and never sent again.
  for (const [id, status] of Object.entries(pending.outbox)) {
    if (status !== 'sending') continue;
    pending.outbox[id] = 'failed';
    log(`Outbox #${id} was being sent when the gateway stopped. Not resending; reporting it failed.`);
  }
  savePending();

  // ---- laptop ---------------------------------------------------------------

  let connected = false;
  function laptopUp() {
    if (!connected) log(`Connected to laptop at ${url}`);
    connected = true;
    resolved('laptop');
  }
  function laptopDown(err) {
    connected = false;
    const reason = err?.name === 'TimeoutError' ? 'timed out' : err?.cause?.code || err?.message || 'error';
    problem('laptop', `Laptop not reachable at ${url} (${reason}). Same Wi-Fi/hotspot? Laptop firewall? Retrying.`);
  }

  async function api(method, route, body, timeout = API_TIMEOUT_MS) {
    const res = await fetch(url + route, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {}
    laptopUp();
    return { status: res.status, ok: res.ok, data };
  }

  // ---- SMS ------------------------------------------------------------------

  async function smsSend(phone, body) {
    const args = ['-n', cleanNumber(phone)];
    if (simSlot) args.push('-s', simSlot);
    args.push(body);
    const result = await run('termux-sms-send', args);
    if (!result.err) {
      resolved('send');
      return true;
    }
    problem('send', failure('termux-sms-send', result));
    return false;
  }

  // Delivery reports go through pending.outbox so they survive a lost connection.
  async function report(id) {
    const status = pending.outbox[id];
    if (status !== 'sent' && status !== 'failed') return;
    try {
      const r = await api('POST', `/api/gateway/outbox/${id}/${status}`);
      if (r.ok || r.status === 404) {
        delete pending.outbox[id];
        savePending();
      }
    } catch (err) {
      laptopDown(err);
    }
  }

  async function sendDueReplies() {
    for (const r of [...pending.replies]) {
      if (r.nextAt > Date.now()) continue;
      const sent = await smsSend(r.phone, r.body);
      r.tries += 1;
      const done = sent || r.tries >= MAX_REPLY_TRIES;
      if (done) pending.replies = pending.replies.filter((x) => x !== r);
      else r.nextAt = Date.now() + BACKOFF[Math.min(r.tries, BACKOFF.length) - 1] * RETRY_MS;
      if (done && r.outboxId) pending.outbox[r.outboxId] = sent ? 'sent' : 'failed';
      savePending();
      if (sent) log(`Out ${maskPhone(r.phone)} reply sent${r.tries > 1 ? ` (try ${r.tries})` : ''}`);
      else if (done) log(`Out ${maskPhone(r.phone)} reply FAILED ${r.tries} times. Giving up.`);
      else log(`Out ${maskPhone(r.phone)} reply failed (try ${r.tries}). Resending in ${Math.round((r.nextAt - Date.now()) / 1000)}s.`);
      if (done && r.outboxId) await report(r.outboxId);
    }
  }

  function advance(id) {
    lastId = id;
    saveLastId();
  }

  async function inboxTick() {
    const listed = await run('termux-sms-list', ['-l', '20', '-t', 'inbox']);
    if (listed.err) {
      problem('list', failure('termux-sms-list', listed));
      return sendDueReplies();
    }
    let list;
    try {
      list = JSON.parse(listed.stdout);
      if (!Array.isArray(list)) throw new Error('not a list');
    } catch {
      problem('list', 'termux-sms-list gave unreadable output. Is the SMS permission granted to Termux:API?');
      return sendDueReplies();
    }
    resolved('list', 'Reading the SMS inbox again.');

    const messages = list
      .map((m) => ({ id: Number(m._id), from: m.number ?? m.address ?? '', body: String(m.body ?? '') }))
      .filter((m) => Number.isInteger(m.id))
      .sort((a, b) => a.id - b.id);
    if (list.length && !messages.length) problem('noid', 'termux-sms-list gives no _id. Update Termux and Termux:API from F-Droid.');

    if (lastId === null) {
      lastId = messages.length ? messages.at(-1).id : 0;
      saveLastId();
      log(`First start: marked ${messages.length} existing messages as seen.`);
      return;
    }

    for (const m of messages) {
      if (m.id <= lastId) continue;
      if (!isPhoneNumber(m.from)) {
        log(`Skipped SMS from ${who(m.from)} (not a phone number).`);
        advance(m.id);
        continue;
      }
      // Already graded but not yet saved as handled (e.g. a failed save).
      if (pending.replies.some((r) => r.smsId === m.id)) {
        advance(m.id);
        continue;
      }
      let res;
      try {
        res = await api('POST', '/api/sms/incoming', { phone: cleanNumber(m.from), body: m.body, smsId: String(m.id) }, INCOMING_TIMEOUT_MS);
      } catch (err) {
        laptopDown(err);
        break; // not advanced: retried next tick, and smsId stops a double grade
      }
      if (res.status >= 500) {
        problem('incoming', `Laptop error (HTTP ${res.status}) for an SMS. Retrying.`);
        break;
      }
      resolved('incoming');
      if (!res.ok || typeof res.data?.reply !== 'string') {
        log(`In  ${maskPhone(m.from)} rejected by laptop (HTTP ${res.status}). Skipped.`);
        advance(m.id);
        continue;
      }
      log(`In  ${maskPhone(m.from)} -> reply ready`);
      pending.replies.push({ smsId: m.id, phone: cleanNumber(m.from), body: res.data.reply, outboxId: res.data.outboxId ?? null, tries: 0, nextAt: 0 });
      savePending(); // the reply first, so a crash in between resends, never loses it
      advance(m.id);
    }
    await sendDueReplies();
  }

  async function outboxTick() {
    for (const id of Object.keys(pending.outbox)) await report(id);
    let res;
    try {
      res = await api('GET', '/api/gateway/outbox');
    } catch (err) {
      return laptopDown(err);
    }
    if (!res.ok || !Array.isArray(res.data)) return problem('outbox', `Outbox check failed (HTTP ${res.status}).`);
    resolved('outbox');
    for (const m of res.data) {
      if (pending.outbox[m.id]) continue; // sent or being sent: never twice
      pending.outbox[m.id] = 'sending';
      if (!savePending()) {
        delete pending.outbox[m.id]; // no record on disk = no send
        return;
      }
      const sent = await smsSend(m.phone, m.body);
      pending.outbox[m.id] = sent ? 'sent' : 'failed';
      savePending();
      log(`Out ${maskPhone(m.phone)} outbox #${m.id} ${sent ? 'sent' : 'FAILED (not retried)'}`);
      await report(m.id);
    }
  }

  async function heartbeatTick() {
    try {
      const r = await api('POST', '/api/gateway/heartbeat', { version: VERSION, simSlot: simSlot || null });
      if (r.ok) resolved('heartbeat');
      else problem('heartbeat', `Heartbeat rejected (HTTP ${r.status}). Is ${url} the Abhyaas server?`);
    } catch (err) {
      laptopDown(err);
    }
  }

  // Each loop waits for its tick to finish before scheduling the next, so
  // ticks never overlap, and an error never stops the loop.
  function loop(name, ms, fn) {
    const tick = async () => {
      try {
        await fn();
        resolved(`error:${name}`);
      } catch (err) {
        problem(`error:${name}`, `${name} error: ${err?.message ?? err}`);
      }
      setTimeout(tick, ms);
    };
    tick();
  }

  process.on('uncaughtException', (err) => log(`Unexpected error (still running): ${err?.message ?? err}`));
  process.on('unhandledRejection', (err) => log(`Unexpected error (still running): ${err?.message ?? err}`));
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      log('Gateway stopped.');
      process.exit(0);
    });
  }

  log(`Abhyaas gateway v${VERSION} started. Laptop: ${url}. SIM slot: ${simSlot || 'default'}.`);
  if (pending.replies.length) log(`${pending.replies.length} reply(s) from last run still to send.`);
  loop('heartbeat', HEARTBEAT_MS, heartbeatTick);
  loop('inbox', POLL_MS, inboxTick);
  loop('outbox', OUTBOX_MS, outboxTick);
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) main();
