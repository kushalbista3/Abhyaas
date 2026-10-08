import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createLlm, parseJson } from '../src/llm/client.js';

// A fake Ollama: handler(requestBody, res) decides each /api/chat reply.
async function fakeOllama(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const json = JSON.parse(body || '{}');
      requests.push(json);
      handler(json, res);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const host = `http://127.0.0.1:${server.address().port}`;
  const close = () => {
    server.closeAllConnections();
    return new Promise((r) => server.close(r));
  };
  return { host, requests, close };
}

const reply = (res, content) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ message: { role: 'assistant', content }, done: true }));
};

const SECRET = 'student text 9811111111';

test('chat returns the text and logs task + latency, never the prompt', async () => {
  const ollama = await fakeOllama((body, res) => reply(res, ' {"answer":"B"} '));
  const logs = [];
  try {
    const llm = createLlm({ host: ollama.host, model: 'gemma4:test', log: (m) => logs.push(m) });
    const text = await llm.chat([{ role: 'user', content: SECRET }], { task: 'parse-reply', format: 'json' });
    assert.equal(text, '{"answer":"B"}');
    const sent = ollama.requests[0];
    assert.equal(sent.model, 'gemma4:test');
    assert.equal(sent.think, false, 'thinking off: too slow for SMS');
    assert.equal(sent.options.temperature, 0);
    assert.equal(sent.format, 'json');
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^LLM parse-reply \d+ms ok$/);
    assert.ok(!logs.join().includes('student'), 'no prompt text in logs');
  } finally {
    await ollama.close();
  }
});

test('a slow model times out and returns null', async () => {
  const ollama = await fakeOllama((body, res) => setTimeout(() => reply(res, 'late'), 2000));
  const logs = [];
  try {
    const llm = createLlm({ host: ollama.host, model: 'm', log: (m) => logs.push(m) });
    const started = Date.now();
    assert.equal(await llm.chat([{ role: 'user', content: SECRET }], { timeoutMs: 100, task: 'ask' }), null);
    assert.ok(Date.now() - started < 1500, 'did not wait for the model');
    assert.match(logs[0], /^LLM ask \d+ms timeout$/);
  } finally {
    await ollama.close();
  }
});

test('an HTTP error, an empty reply or no server returns null', async () => {
  const logs = [];
  const log = (m) => logs.push(m);
  const err = await fakeOllama((body, res) => {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'model not found' }));
  });
  const empty = await fakeOllama((body, res) => reply(res, '   '));
  try {
    assert.equal(await createLlm({ host: err.host, model: 'm', log }).chat([{ role: 'user', content: 'x' }]), null);
    assert.equal(await createLlm({ host: empty.host, model: 'm', log }).chat([{ role: 'user', content: 'x' }]), null);
  } finally {
    await err.close();
    await empty.close();
  }
  const closed = await fakeOllama(() => {});
  await closed.close();
  assert.equal(await createLlm({ host: closed.host, model: 'm', log }).chat([{ role: 'user', content: 'x' }]), null);
  assert.deepEqual(logs.map((m) => m.split(' ').at(-1)), ['error', 'empty', 'error']);
});

test('prewarm sends one tiny real request', async () => {
  const ollama = await fakeOllama((body, res) => reply(res, 'OK'));
  try {
    const llm = createLlm({ host: ollama.host, model: 'm', log: () => {} });
    const r = await llm.prewarm();
    assert.equal(r.ok, true);
    assert.equal(ollama.requests.length, 1);
    assert.equal(ollama.requests[0].options.num_predict, 1);
  } finally {
    await ollama.close();
  }
});

test('parseJson accepts plain or fenced JSON objects only', () => {
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.equal(parseJson('nope'), null);
  assert.equal(parseJson('"str"'), null);
  assert.equal(parseJson(null), null);
});
