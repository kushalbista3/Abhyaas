import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { seed } from '../src/seed.js';
import { createSmsEngine } from '../src/engine.js';
import { createApp } from '../src/app.js';
import { createDailyPush } from '../src/daily-push.js';
import { fitsOneSms } from '../src/gsm7.js';

const NO_OLLAMA = 'http://127.0.0.1:9';
const PHONES = ['9800000001', '9800000002', '9800000003'];

// A seeded in-memory server (3 demo students) with a fake clock.
async function setup() {
  const db = openDb(':memory:');
  seed(db);
  const clock = { t: new Date(2026, 9, 8, 12, 0, 0).getTime() };
  const engine = createSmsEngine(db, { now: () => new Date(clock.t) });
  const push = createDailyPush(db, engine, { now: () => new Date(clock.t), time: '' });
  const server = createApp(db, engine, { now: () => clock.t, ollamaHost: NO_OLLAMA, push }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, route, body) => {
    const r = await fetch(base + route, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    return { status: r.status, data: JSON.parse(text), raw: text };
  };
  const outbox = () => db.prepare('SELECT phone, body, status FROM outbox ORDER BY id').all();
  const done = () => new Promise((r) => server.close(r));
  return { db, clock, engine, api, outbox, done };
}

const studentId = (db, phone) => db.prepare('SELECT id FROM students WHERE phone = ?').get(phone).id;
const addDoubt = (db, phone, { subject = 'MATH', status = 'open', reply = null, at = '2026-10-08 05:00:00' } = {}) =>
  Number(
    db.prepare('INSERT INTO doubts (student_id, subject, text, status, reply, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(studentId(db, phone), subject, `why ${subject}?`, status, reply, at).lastInsertRowid,
  );

test('doubts inbox: open doubts and recent Gemma answers, names only', async () => {
  const s = await setup();
  try {
    const open = addDoubt(s.db, PHONES[0], { subject: 'SCI' });
    const gemma = addDoubt(s.db, PHONES[1], { status: 'answered', reply: 'HCF is the highest common factor.' });
    addDoubt(s.db, PHONES[1], { status: 'answered', reply: 'Old answer.', at: '2026-09-01 05:00:00' });
    const { data, raw } = await s.api('GET', '/api/doubts');
    assert.deepEqual(
      data.map((d) => [d.id, d.name, d.subject, d.status, d.gemmaReply]),
      [
        [open, 'Aarati Sharma', 'SCI', 'open', null],
        [gemma, 'Bikash Thapa', 'MATH', 'answered', 'HCF is the highest common factor.'],
      ],
    );
    assert.doesNotMatch(raw, /98000000/, 'no phone numbers');
  } finally {
    await s.done();
  }
});

test('doubt reply: queued in the outbox, logged, doubt answered; Gemma reply kept', async () => {
  const s = await setup();
  try {
    const id = addDoubt(s.db, PHONES[1], { status: 'answered', reply: 'Gemma said this.' });
    const r = await s.api('POST', `/api/doubts/${id}/reply`, { text: 'Good question. We’ll do it in class tomorrow.' });
    assert.equal(r.status, 200);
    const sent = "Good question. We'll do it in class tomorrow.";
    assert.deepEqual(s.outbox(), [{ phone: PHONES[1], body: sent, status: 'queued' }]);
    assert.deepEqual(s.db.prepare('SELECT phone, direction, body FROM messages').all(), [{ phone: PHONES[1], direction: 'out', body: sent }]);
    assert.deepEqual(s.db.prepare('SELECT status, reply, teacher_reply FROM doubts WHERE id = ?').get(id), {
      status: 'answered',
      reply: 'Gemma said this.',
      teacher_reply: sent,
    });
    assert.deepEqual((await s.api('GET', '/api/doubts')).data, [], 'gone from the inbox');
    // The gateway picks it up like any push.
    assert.deepEqual((await s.api('GET', '/api/gateway/outbox')).data.map((o) => o.body), [sent]);

    assert.equal((await s.api('POST', `/api/doubts/${id}/reply`, { text: 'Again' })).status, 409);
    assert.equal((await s.api('POST', '/api/doubts/999/reply', { text: 'Hi' })).status, 404);
    assert.equal(s.outbox().length, 1);
  } finally {
    await s.done();
  }
});

test('doubt reply: over 160, non GSM-7 or empty is refused and nothing is queued', async () => {
  const s = await setup();
  try {
    const id = addDoubt(s.db, PHONES[0]);
    for (const [text, why] of [
      ['x'.repeat(161), /161 chars, max 160/],
      ['{'.repeat(81), /162 chars, max 160/], // extension characters count 2
      ['नमस्ते', /characters an SMS can't send/],
      ['   ', /empty/],
    ]) {
      const r = await s.api('POST', `/api/doubts/${id}/reply`, { text });
      assert.equal(r.status, 400, text);
      assert.match(r.data.error, why);
    }
    assert.equal((await s.api('POST', `/api/doubts/${id}/reply`, { text: 'y'.repeat(160) })).status, 200, 'exactly 160 is fine');
    assert.deepEqual(s.outbox().map((o) => o.body.length), [160]);
  } finally {
    await s.done();
  }
});

test('broadcast: one queued SMS per student, all or nothing', async () => {
  const s = await setup();
  try {
    assert.equal((await s.api('POST', '/api/broadcast', { text: 'z'.repeat(161) })).status, 400);
    assert.deepEqual(s.outbox(), []);

    const text = 'No class on Friday. Keep practising: send QUIZ.';
    assert.deepEqual((await s.api('POST', '/api/broadcast', { text })).data, { queued: 3 });
    const rows = s.outbox();
    assert.deepEqual(rows.map((o) => o.phone), PHONES);
    for (const o of rows) {
      assert.equal(o.body, text);
      assert.equal(o.status, 'queued');
      assert.ok(fitsOneSms(o.body));
    }
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE direction = 'out'").get().n, 3);
  } finally {
    await s.done();
  }
});

test('message log: last 20, newest first, phones masked, with gateway status', async () => {
  const s = await setup();
  try {
    for (let i = 0; i < 12; i++) await s.engine.handleIncomingSms(PHONES[i % 3], 'HELP');
    const { data, raw } = await s.api('GET', '/api/messages');
    assert.equal(data.messages.length, 20);
    assert.deepEqual(data.messages.map((m) => m.id), [...data.messages.map((m) => m.id)].sort((a, b) => b - a));
    assert.deepEqual(Object.keys(data.messages[0]).sort(), ['body', 'created_at', 'direction', 'id', 'masked', 'name']);
    assert.equal(data.messages[0].masked, '98******03');
    assert.doesNotMatch(raw, /98000000/);
    assert.deepEqual(data.gateway, { mode: 'simulator', secondsSinceLastSeen: null });
  } finally {
    await s.done();
  }
});

test('dashboard API: per subject, no phone numbers', async () => {
  const s = await setup();
  try {
    await s.engine.handleIncomingSms(PHONES[0], 'QUIZ PCT');
    await s.engine.handleIncomingSms(PHONES[0], 'A');
    const { data, raw } = await s.api('GET', '/api/dashboard?subject=MATH');
    assert.deepEqual(Object.keys(data).sort(), ['misconceptions', 'overview', 'students', 'topics']);
    assert.equal(data.overview.answersWeek, 1);
    assert.equal(data.topics[0].topic, 'PCT');
    assert.doesNotMatch(raw, /98000000/);
    assert.equal((await s.api('GET', '/api/dashboard?subject=SCI')).data.overview.answersWeek, 0);
    assert.equal((await s.api('GET', '/api/dashboard?subject=ENG')).status, 400);
  } finally {
    await s.done();
  }
});
