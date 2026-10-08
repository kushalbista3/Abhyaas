import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { seed } from '../src/seed.js';
import { createSmsEngine } from '../src/engine.js';
import { createApp } from '../src/app.js';
import { createDailyPush, parsePushTime } from '../src/daily-push.js';
import { fitsOneSms } from '../src/gsm7.js';
import { quizCountToday, sqlTime } from '../src/practice.js';

const PHONES = ['9800000001', '9800000002', '9800000003'];
const DAY = 24 * 60 * 60 * 1000;

function setup({ time = '16:30' } = {}) {
  const db = openDb(':memory:');
  seed(db); // 14 approved maths questions, 3 demo students
  const clock = { t: new Date(2026, 9, 8, 12, 0, 0) };
  const now = () => new Date(clock.t);
  const engine = createSmsEngine(db, { now });
  const push = createDailyPush(db, engine, { now, time });
  const outbox = () => db.prepare('SELECT phone, body, status FROM outbox ORDER BY id').all();
  const sid = (phone) => db.prepare('SELECT id FROM students WHERE phone = ?').get(phone).id;
  return { db, clock, engine, push, outbox, sid };
}

// A past first try at a topic's question: right or wrong, two days ago.
function practise(db, studentId, topic, correct) {
  const q = db.prepare("SELECT id, correct_option FROM questions WHERE topic = ? AND status = 'approved' ORDER BY id").get(topic);
  const at = sqlTime(new Date(2026, 9, 6, 12));
  const session = db
    .prepare("INSERT INTO sessions (student_id, current_question_id, state, started_at) VALUES (?, ?, 'ended', ?)")
    .run(studentId, q.id, at).lastInsertRowid;
  const chosen = correct ? q.correct_option : q.correct_option === 'A' ? 'B' : 'A';
  db.prepare('INSERT INTO attempts (student_id, question_id, session_id, chosen_option, is_correct, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(studentId, q.id, session, chosen, correct ? 1 : 0, at);
}

const topicOf = (body) => body.match(/^Q\d+ (\w+)/)[1];

test('parsePushTime accepts HH:MM (24h) only', () => {
  assert.deepEqual(parsePushTime('7:05'), { hours: 7, minutes: 5, text: '07:05' });
  assert.deepEqual(parsePushTime(' 16:30 '), { hours: 16, minutes: 30, text: '16:30' });
  for (const bad of ['', '24:00', '7', '7:5', '4pm', null, undefined]) assert.equal(parsePushTime(bad), null, String(bad));
});

test('send now: one question per student from their weakest topic, queued, not counted as QUIZ', () => {
  const { db, push, outbox, sid } = setup();
  const a = sid(PHONES[0]);
  practise(db, a, 'PCT', false);
  practise(db, a, 'PCT', false);
  practise(db, a, 'HCF', true);
  const b = sid(PHONES[1]);
  practise(db, b, 'SET', false);
  practise(db, b, 'SET', true);

  assert.deepEqual(push.sendNow(), { queued: 3, skipped: 0 });
  const rows = outbox();
  assert.deepEqual(rows.map((o) => o.phone), PHONES);
  assert.deepEqual(rows.map((o) => topicOf(o.body)), ['PCT', 'SET', 'HCF'], 'no history: the usual first question');
  for (const o of rows) {
    assert.equal(o.status, 'queued');
    assert.ok(fitsOneSms(o.body), o.body);
  }
  assert.deepEqual(
    db.prepare("SELECT origin, state FROM sessions WHERE state = 'active' ORDER BY student_id").all(),
    Array(3).fill({ origin: 'push', state: 'active' }),
  );
  assert.equal(quizCountToday(db, a, new Date(2026, 9, 8, 12)), 0);
  // The pushed question is the one a reply answers.
  const pushed = db.prepare("SELECT current_question_id AS id FROM sessions WHERE student_id = ? AND state = 'active'").get(a).id;
  assert.equal(db.prepare('SELECT topic FROM questions WHERE id = ?').get(pushed).topic, 'PCT');
});

test('topic override: every student gets that topic, even another subject', () => {
  const { db, push, outbox } = setup();
  db.prepare("UPDATE questions SET status = 'approved' WHERE subject = 'SCI'").run();
  assert.throws(() => push.setTopic('XYZ'), /unknown topic/);
  assert.equal(push.setTopic('BIO').topic, 'BIO');
  assert.deepEqual(push.sendNow(), { queued: 3, skipped: 0 });
  assert.deepEqual(outbox().map((o) => topicOf(o.body)), ['BIO', 'BIO', 'BIO']);
  assert.equal(push.setTopic(null).topic, null, 'back to the weakest topic');
});

test('a topic with no approved questions is skipped, never crashes', () => {
  const { push, outbox } = setup();
  push.setTopic('PHY'); // science still needs review
  assert.deepEqual(push.sendNow(), { queued: 0, skipped: 3 });
  assert.deepEqual(outbox(), []);
});

test('runIfDue: once per local day at or after DAILY_PUSH_TIME', () => {
  const { clock, push, outbox } = setup({ time: '16:30' });
  clock.t = new Date(2026, 9, 8, 16, 29);
  assert.equal(push.runIfDue(), null, 'too early');
  clock.t = new Date(2026, 9, 8, 16, 30);
  assert.deepEqual(push.runIfDue(), { queued: 3, skipped: 0 });
  assert.equal(push.status().lastPushDate, '2026-10-08');
  clock.t = new Date(2026, 9, 8, 21, 0);
  assert.equal(push.runIfDue(), null, 'already pushed today');
  assert.equal(outbox().length, 3);

  push.sendNow(); // a manual push doesn't touch the schedule
  clock.t = new Date(clock.t.getTime() + DAY);
  assert.deepEqual(push.runIfDue(), { queued: 3, skipped: 0 }, 'the next day (late start still pushes)');
  assert.equal(outbox().length, 9);
});

test('no DAILY_PUSH_TIME: never scheduled, send now still works', () => {
  const { clock, push } = setup({ time: '' });
  clock.t = new Date(2026, 9, 8, 23, 0);
  assert.equal(push.runIfDue(), null);
  assert.equal(push.start(), null);
  assert.deepEqual(push.status(), { time: null, topic: null, lastPushDate: null });
  assert.deepEqual(push.sendNow(), { queued: 3, skipped: 0 });
});

test('push API: status, topic override and send now', async () => {
  const { db, engine, push, outbox } = setup();
  const server = createApp(db, engine, { ollamaHost: 'http://127.0.0.1:9', push }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, route, body) => {
    const r = await fetch(base + route, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
  try {
    assert.deepEqual((await api('GET', '/api/push')).data, { time: '16:30', topic: null, lastPushDate: null });
    assert.equal((await api('PUT', '/api/push', { topic: 'NOPE' })).status, 400);
    assert.equal((await api('PUT', '/api/push', { topic: 'GEO' })).data.topic, 'GEO');
    assert.deepEqual((await api('POST', '/api/push/now')).data, { queued: 3, skipped: 0 });
    assert.deepEqual(outbox().map((o) => topicOf(o.body)), ['GEO', 'GEO', 'GEO']);
    assert.equal((await api('PUT', '/api/push', { topic: null })).data.topic, null);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
