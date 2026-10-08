// Runs gateway-phone/gateway.mjs as a real process against a real server,
// with fake termux-sms-list / termux-sms-send commands first on PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { seed } from '../src/seed.js';
import { createSmsEngine } from '../src/engine.js';
import { createApp } from '../src/app.js';
import { isPhoneNumber, maskPhone } from '../../gateway-phone/gateway.mjs';

const GATEWAY = fileURLToPath(new URL('../../gateway-phone/gateway.mjs', import.meta.url));
const FROM = '+9779811111111';
const PHONE = '9811111111';

// termux-sms-list prints $FAKE_INBOX as is (so a test can make it garbage).
// termux-sms-send fails while $FAKE_FAIL holds a count > 0, else logs its args to $FAKE_SENT.
const FAKE_LIST = `#!${process.execPath}
const fs = require('node:fs');
process.stdout.write(fs.readFileSync(process.env.FAKE_INBOX, 'utf8'));
`;
const FAKE_SEND = `#!${process.execPath}
const fs = require('node:fs');
let fails = 0;
try { fails = Number(fs.readFileSync(process.env.FAKE_FAIL, 'utf8')) || 0; } catch {}
if (fails > 0) {
  fs.writeFileSync(process.env.FAKE_FAIL, String(fails - 1));
  console.error('Generic failure');
  process.exit(1);
}
fs.appendFileSync(process.env.FAKE_SENT, JSON.stringify(process.argv.slice(2)) + '\\n');
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function listen(app, port = 0) {
  const server = app.listen(port, '127.0.0.1');
  return new Promise((r) => server.once('listening', () => r(server)));
}

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abhyaas-gw-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'termux-sms-list'), FAKE_LIST, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'termux-sms-send'), FAKE_SEND, { mode: 0o755 });
  const files = {
    inbox: path.join(dir, 'inbox.json'),
    sent: path.join(dir, 'sent.log'),
    fail: path.join(dir, 'fail'),
    state: path.join(dir, 'state'),
  };
  fs.mkdirSync(files.state);
  fs.writeFileSync(files.sent, '');

  const db = openDb(':memory:');
  seed(db);
  const engine = createSmsEngine(db);
  const app = createApp(db, engine, { ollamaHost: 'http://127.0.0.1:9' });
  let server = await listen(app);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  let inbox = [];
  const setInbox = (list) => fs.writeFileSync(files.inbox, typeof list === 'string' ? list : JSON.stringify(list));
  const sms = (_id, number, body) => {
    inbox = [...inbox, { threadid: 1, type: 'inbox', read: false, number, received: '2026-10-08 12:00:00', body, _id }];
    setInbox([...inbox].reverse()); // termux lists newest first
  };
  setInbox([]);

  const sent = () =>
    fs.readFileSync(files.sent, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const lastId = () => {
    try {
      return Number(fs.readFileSync(path.join(files.state, '.last-id'), 'utf8'));
    } catch {
      return null;
    }
  };
  const count = (sql, ...args) => db.prepare(sql).get(...args).n;

  let child = null;
  let out = '';
  function startGateway(env = {}) {
    out = '';
    child = spawn(process.execPath, [GATEWAY], {
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        LAPTOP_URL: base,
        STATE_DIR: files.state,
        POLL_MS: '40',
        OUTBOX_MS: '40',
        HEARTBEAT_MS: '100',
        RETRY_MS: '20',
        FAKE_INBOX: files.inbox,
        FAKE_SENT: files.sent,
        FAKE_FAIL: files.fail,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
  }
  async function stopGateway() {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM');
    await exited;
  }

  return {
    db,
    engine,
    files,
    base,
    sms,
    setInbox,
    sent,
    lastId,
    count,
    startGateway,
    stopGateway,
    log: () => out,
    alive: () => child.exitCode === null,
    stopLaptop: () => new Promise((r) => server.close(r)),
    startLaptop: async () => (server = await listen(app, port)),
    async cleanup() {
      await stopGateway();
      if (server.listening) await new Promise((r) => server.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const replies = (s) => s.sent().map((args) => args.at(-1));

test('helpers: phone senders vs NTC/BANK, masking', () => {
  for (const n of ['+9779811111111', '9811111111', '+977 981-1111111']) assert.equal(isPhoneNumber(n), true, n);
  for (const n of ['NTC', 'BANK', 'Ncell', '1415', '', undefined]) assert.equal(isPhoneNumber(n), false, String(n));
  assert.equal(maskPhone('9800000001'), '98******01');
  assert.equal(maskPhone('+977 980-0000001'), '98******01');
});

test('first start marks old SMS as seen; new SMS is graded and the reply sent; NTC skipped; heartbeat', async () => {
  const s = await setup();
  try {
    s.sms(5, FROM, 'JOIN Old');
    s.sms(7, 'NTC', 'Old offer');
    s.startGateway({ SIM_SLOT: '1' });
    await waitFor(() => /First start: marked 2 existing messages as seen/.test(s.log()), 'first start');
    assert.equal(s.lastId(), 7);
    await sleep(150);
    assert.equal(s.count('SELECT COUNT(*) AS n FROM messages'), 0, 'old messages are not posted');

    s.sms(8, FROM, 'JOIN Sita');
    s.sms(9, 'BANK', 'Your balance is ...');
    await waitFor(() => s.sent().length === 1, 'reply sent');
    const [args] = s.sent();
    assert.deepEqual(args.slice(0, 4), ['-n', FROM, '-s', '1']);
    assert.match(args[4], /^Welcome Sita!/);
    await waitFor(() => s.lastId() === 9, 'last id past BANK');
    assert.match(s.log(), /Skipped SMS from BANK/);
    assert.equal(s.count("SELECT COUNT(*) AS n FROM messages WHERE direction = 'in'"), 1);
    assert.equal(s.count("SELECT COUNT(*) AS n FROM outbox WHERE status = 'sent'"), 1);
    assert.doesNotMatch(s.log(), new RegExp(PHONE), 'phone numbers are masked in logs');
    assert.match(s.log(), /In  98\*{6}11 -> reply ready/);

    const health = await (await fetch(`${s.base}/api/health`)).json();
    assert.equal(health.gateway.mode, 'termux');
    assert.ok(health.gateway.secondsSinceLastSeen <= 1);
    assert.ok(s.alive());
  } finally {
    await s.cleanup();
  }
});

test('a failed reply send is resent from the gateway, never re-graded', async () => {
  const s = await setup();
  try {
    s.startGateway();
    await waitFor(() => /First start/.test(s.log()), 'first start');
    s.sms(1, FROM, 'JOIN Sita');
    s.sms(2, FROM, 'QUIZ');
    await waitFor(() => s.sent().length === 2, 'join + quiz replies');
    const qid = Number(replies(s)[1].match(/^Q(\d+) /)[1]);
    const right = s.db.prepare('SELECT correct_option FROM questions WHERE id = ?').get(qid).correct_option;

    fs.writeFileSync(s.files.fail, '2');
    s.sms(3, FROM, right);
    await waitFor(() => s.sent().length === 3, 'answer reply after retries');
    assert.match(replies(s)[2], /^Correct!/);
    assert.equal(fs.readFileSync(s.files.fail, 'utf8'), '0', 'two failed sends happened first');
    await waitFor(() => /reply sent \(try 3\)/.test(s.log()), 'retry logged');
    assert.match(s.log(), /reply failed \(try 1\)/);
    assert.match(s.log(), /termux-sms-send failed \(exit 1\): Generic failure/);
    assert.doesNotMatch(s.log(), /Correct!|9811111111/, 'no SMS text or number in logs');

    await sleep(200);
    assert.equal(s.sent().length, 3, 'sent exactly once');
    assert.equal(s.count('SELECT COUNT(*) AS n FROM attempts'), 1, 'graded once');
    assert.equal(s.count("SELECT COUNT(*) AS n FROM messages WHERE direction = 'in'"), 3);
  } finally {
    await s.cleanup();
  }
});

test('queued outbox messages are sent once and marked sent', async () => {
  const s = await setup();
  try {
    const student = s.db.prepare('SELECT id, phone FROM students ORDER BY id LIMIT 1').get();
    const body = s.engine.pushQuestion(student.id);
    const { id } = s.db.prepare("SELECT id FROM outbox WHERE status = 'queued'").get();
    s.startGateway();
    await waitFor(() => s.db.prepare('SELECT status FROM outbox WHERE id = ?').get(id).status === 'sent', 'marked sent');
    await sleep(250); // several more outbox ticks
    assert.deepEqual(s.sent(), [['-n', student.phone, body]]);
  } finally {
    await s.cleanup();
  }
});

test('an outbox message interrupted mid-send is reported failed, never resent', async () => {
  const s = await setup();
  try {
    const student = s.db.prepare('SELECT id FROM students ORDER BY id LIMIT 1').get();
    s.engine.pushQuestion(student.id);
    const { id } = s.db.prepare("SELECT id FROM outbox WHERE status = 'queued'").get();
    fs.writeFileSync(path.join(s.files.state, '.last-id'), '0\n');
    fs.writeFileSync(path.join(s.files.state, '.pending.json'), JSON.stringify({ replies: [], outbox: { [id]: 'sending' } }));
    s.startGateway();
    await waitFor(() => s.db.prepare('SELECT status FROM outbox WHERE id = ?').get(id).status === 'failed', 'marked failed');
    await sleep(250);
    assert.deepEqual(s.sent(), []);
    assert.match(s.log(), new RegExp(`Outbox #${id} was being sent`));
  } finally {
    await s.cleanup();
  }
});

test('laptop down or bad termux output: the gateway keeps running and catches up', async () => {
  const s = await setup();
  try {
    fs.writeFileSync(path.join(s.files.state, '.last-id'), '0\n');
    s.setInbox('not json at all');
    s.startGateway();
    await waitFor(() => /unreadable output/.test(s.log()), 'garbage logged');
    await sleep(200);
    assert.equal(s.log().match(/unreadable output/g).length, 1, 'logged once, not every tick');

    await s.stopLaptop();
    s.sms(1, FROM, 'JOIN Sita');
    await waitFor(() => /Laptop not reachable/.test(s.log()), 'laptop down logged');
    await sleep(300);
    assert.ok(s.alive(), 'still running');
    assert.equal(s.log().match(/Laptop not reachable/g).length, 1, 'logged once');
    assert.equal(s.lastId(), 0, 'not marked handled while the laptop is down');

    await s.startLaptop();
    await waitFor(() => s.sent().length === 1, 'reply after laptop is back');
    assert.match(replies(s)[0], /^Welcome Sita!/);
    assert.equal(s.lastId(), 1);
    assert.equal(s.count("SELECT COUNT(*) AS n FROM messages WHERE direction = 'in'"), 1);
    assert.ok(s.alive());
  } finally {
    await s.cleanup();
  }
});

test('the gateway refuses to start without LAPTOP_URL', async () => {
  const child = spawn(process.execPath, [GATEWAY], { env: { ...process.env, LAPTOP_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 1);
  assert.match(err, /Usage: LAPTOP_URL=/);
});
