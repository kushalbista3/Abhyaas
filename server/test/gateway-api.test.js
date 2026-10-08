import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb } from '../src/db.js';
import { seed } from '../src/seed.js';
import { createSmsEngine } from '../src/engine.js';
import { createApp } from '../src/app.js';
import { sqlTime } from '../src/practice.js';

const PHONE = '9811111111';
const NO_OLLAMA = 'http://127.0.0.1:9'; // nothing listens on the discard port

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));
const close = (server) => new Promise((r) => server.close(r));

// A seeded in-memory server with a fake clock; t is in ms.
async function setup({ ollamaHost = NO_OLLAMA, ollamaModel = 'gemma4:e4b' } = {}) {
  const db = openDb(':memory:');
  seed(db);
  const clock = { t: new Date(2026, 9, 8, 12, 0, 0).getTime() };
  const engine = createSmsEngine(db, { now: () => new Date(clock.t) });
  const server = createApp(db, engine, { now: () => clock.t, ollamaHost, ollamaModel }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, route, body) => {
    const r = await fetch(base + route, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: await r.json() };
  };
  return { db, clock, engine, api, done: () => close(server) };
}

test('health reports the gateway as termux only within 90s of a heartbeat', async () => {
  const s = await setup();
  try {
    let h = (await s.api('GET', '/api/health')).data;
    assert.equal(h.ok, true);
    assert.equal(h.db, 'ok');
    assert.ok(h.questions > 0);
    assert.deepEqual(h.gateway, { mode: 'simulator', secondsSinceLastSeen: null });

    assert.deepEqual((await s.api('POST', '/api/gateway/heartbeat', { version: 1 })).data, { ok: true });
    s.clock.t += 12_000;
    h = (await s.api('GET', '/api/health')).data;
    assert.deepEqual(h.gateway, { mode: 'termux', secondsSinceLastSeen: 12 });

    s.clock.t += 79_000; // 91s since the heartbeat
    h = (await s.api('GET', '/api/health')).data;
    assert.deepEqual(h.gateway, { mode: 'simulator', secondsSinceLastSeen: 91 });
  } finally {
    await s.done();
  }
});

test('health checks that Ollama is reachable and the model is installed', async () => {
  const tags = { models: [{ name: 'gemma4:e4b', model: 'gemma4:e4b' }, { name: 'llama3:latest', model: 'llama3:latest' }] };
  const fake = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/tags' ? tags : {}));
  });
  const host = await listen(fake);
  const cases = [
    [{ ollamaHost: host, ollamaModel: 'gemma4:e4b' }, { reachable: true, model: 'gemma4:e4b', modelInstalled: true }],
    [{ ollamaHost: host, ollamaModel: 'llama3' }, { reachable: true, model: 'llama3', modelInstalled: true }],
    [{ ollamaHost: host, ollamaModel: 'gemma4:e2b' }, { reachable: true, model: 'gemma4:e2b', modelInstalled: false }],
    [{ ollamaHost: NO_OLLAMA, ollamaModel: 'gemma4:e4b' }, { reachable: false, model: 'gemma4:e4b', modelInstalled: false }],
  ];
  try {
    for (const [opts, expected] of cases) {
      const s = await setup(opts);
      try {
        const started = Date.now();
        assert.deepEqual((await s.api('GET', '/api/health')).data.ollama, expected);
        assert.ok(Date.now() - started < 3000, 'health must answer quickly');
      } finally {
        await s.done();
      }
    }
  } finally {
    await close(fake);
  }
});

test('gateway outbox lists only queued messages; sent/failed update them', async () => {
  const s = await setup();
  try {
    const student = s.db.prepare('SELECT id, phone FROM students ORDER BY id LIMIT 1').get();
    const pushed = s.engine.pushQuestion(student.id);
    assert.ok(pushed);
    await s.api('POST', '/api/sms/incoming', { phone: PHONE, body: 'JOIN Sita' }); // a 'sent' reply row

    const { data: queued } = await s.api('GET', '/api/gateway/outbox');
    assert.equal(queued.length, 1);
    assert.deepEqual(Object.keys(queued[0]).sort(), ['body', 'id', 'phone']);
    assert.equal(queued[0].phone, student.phone);
    assert.equal(queued[0].body, pushed);

    const id = queued[0].id;
    assert.equal((await s.api('POST', `/api/gateway/outbox/${id}/sent`)).status, 200);
    const row = s.db.prepare('SELECT status, sent_at FROM outbox WHERE id = ?').get(id);
    assert.equal(row.status, 'sent');
    assert.equal(row.sent_at, sqlTime(new Date(s.clock.t)));
    assert.deepEqual((await s.api('GET', '/api/gateway/outbox')).data, []);

    assert.equal((await s.api('POST', `/api/gateway/outbox/${id}/failed`)).status, 200);
    assert.equal(s.db.prepare('SELECT status FROM outbox WHERE id = ?').get(id).status, 'failed');

    assert.equal((await s.api('POST', '/api/gateway/outbox/99999/sent')).status, 404);
    assert.equal((await s.api('POST', '/api/gateway/outbox/abc/failed')).status, 404);
  } finally {
    await s.done();
  }
});

test('incoming returns the outbox id; a repeated smsId is not graded twice', async () => {
  const s = await setup();
  const count = (sql) => s.db.prepare(sql).get().n;
  try {
    await s.api('POST', '/api/sms/incoming', { phone: PHONE, body: 'JOIN Sita' });
    const quiz = (await s.api('POST', '/api/sms/incoming', { phone: PHONE, body: 'QUIZ' })).data;
    assert.match(quiz.reply, /^Q\d+ /);
    assert.equal(s.db.prepare('SELECT body FROM outbox WHERE id = ?').get(quiz.outboxId).body, quiz.reply);

    const first = await s.api('POST', '/api/sms/incoming', { phone: '+977 9811111111', body: 'A', smsId: '42' });
    const again = await s.api('POST', '/api/sms/incoming', { phone: '9811111111', body: 'A', smsId: '42' });
    assert.deepEqual(again.data, first.data);
    assert.equal(count('SELECT COUNT(*) AS n FROM attempts'), 1);
    assert.equal(count("SELECT COUNT(*) AS n FROM messages WHERE direction = 'in'"), 3);

    // A different smsId is a new SMS.
    await s.api('POST', '/api/sms/incoming', { phone: PHONE, body: 'A', smsId: '43' });
    assert.equal(count("SELECT COUNT(*) AS n FROM messages WHERE direction = 'in'"), 4);
  } finally {
    await s.done();
  }
});
