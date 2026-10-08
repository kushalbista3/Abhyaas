import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { createSmsEngine } from '../src/engine.js';
import { createGemini } from '../src/gemini.js';
import { gsmLength } from '../src/gsm7.js';
import {
  ImportError, STEM_OPTIONS_BUDGET, checkCard, extractCards, importInstruction, toCard, unsuitableReason,
} from '../src/photo-import.js';
import { seed } from '../src/seed.js';
import { formatQuestionSms } from '../src/sms.js';
import { loadImports } from '../src/snapshots.js';

const PHOTO = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]); // a few bytes of "JPEG"
const KEY = 'AIzaFAKEKEY1234567890';

// One valid card, one with wrong arithmetic, one "draw" the model thought was
// fine, and one OTHER topic.
const CARDS = [
  {
    source_ref: '1(a)', topic: 'PCT', sms_suitable: true, reason: '',
    stem: 'A bag marked Rs 1,500 is sold at 10% discount. Find the selling price.',
    answer: 'Rs 1,350',
    wrong_answers: [
      { answer: 'Rs 150', misconception: 'Gave the discount, not the selling price.' },
      { answer: 'Rs 1,650', misconception: 'Added the discount instead of taking it off.' },
      { answer: 'Rs 1,485', misconception: 'Took 1% off instead of 10%.' },
    ],
    solution: 'SP=1500*0.9=1350',
  },
  {
    source_ref: '1(b)', topic: 'INT', sms_suitable: true, reason: '',
    stem: 'Find the simple interest on Rs 2,000 for 3 years at 5% per year.',
    answer: 'Rs 350',
    wrong_answers: [
      { answer: 'Rs 100', misconception: 'Found one year only.' },
      { answer: 'Rs 2,300', misconception: 'Gave the amount, not the interest.' },
      { answer: 'Rs 30', misconception: 'Divided by 1000 instead of 100.' },
    ],
    solution: 'SI=2000*3*5/100=350',
  },
  {
    source_ref: '2(a)', topic: 'SET', sms_suitable: true, reason: '',
    stem: 'Draw a Venn diagram of 40 tea and 30 coffee drinkers.',
    answer: '', wrong_answers: [], solution: '',
  },
  { source_ref: '2(b)', topic: 'OTHER', sms_suitable: false, reason: 'Trigonometry heights need a figure.', stem: '' },
];
const REPLY = '```json\n' + JSON.stringify({ sub_parts: ['1(a)', '1(b)', '2(a)', '2(b)'], cards: CARDS }) + '\n```';

function fakeGemini(...replies) {
  const calls = [];
  return {
    calls,
    async generate(req) {
      calls.push(req);
      const r = replies[Math.min(calls.length, replies.length) - 1];
      if (r instanceof Error) throw r;
      return r;
    },
  };
}
const httpError = (status, message = `HTTP ${status}`) => Object.assign(new Error(message), { status });

test('the stem+options budget is what one SMS leaves, and the instruction states it', () => {
  const skeleton = formatQuestionSms({ topic: 'PROB', stem: '', option_a: '', option_b: '', option_c: '', option_d: '' }, 9999);
  assert.equal(STEM_OPTIONS_BUDGET, 160 - gsmLength(skeleton));
  const text = importInstruction();
  assert.ok(text.includes(`at most ${STEM_OPTIONS_BUDGET} characters`));
  for (const want of ['sub_parts', 'source_ref', 'OTHER', 'sms_suitable', 'complement', 'wrong_answers', '= <answer>']) {
    assert.ok(text.includes(want), want);
  }
});

test('extractCards: one card per sub-part, checked in code, summary line', async () => {
  const gemini = fakeGemini(REPLY);
  const r = await extractCards(gemini, { image: PHOTO, mimeType: 'image/jpeg' }, { rng: () => 0.99 });
  assert.equal(r.summary, 'Found 4 sub-parts, 4 cards returned');
  assert.deepEqual(r.missing, []);
  assert.equal(gemini.calls[0].image, PHOTO);
  assert.equal(gemini.calls[0].instruction, importInstruction());

  const [ok, badSum, draw, other] = r.cards;
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.unsuitable, null);
  assert.equal(ok.subject, 'MATH');

  assert.ok(badSum.errors.includes('solution step "2000*3*5/100=350" is wrong: 2000*3*5/100 = 300'));

  assert.match(draw.unsuitable, /"draw"/, 'caught in code although the model said suitable');
  assert.equal(other.unsuitable, 'Trigonometry heights need a figure.');
});

test('a missing card is listed by its sub-part', async () => {
  const reply = JSON.stringify({ sub_parts: ['1(a)', '1(b)', '1(c)'], cards: CARDS.slice(0, 2) });
  const r = await extractCards(fakeGemini(reply), { image: PHOTO, mimeType: 'image/png' });
  assert.equal(r.summary, 'Found 3 sub-parts, 2 cards returned');
  assert.deepEqual(r.missing, ['1(c)']);
});

test('options are shuffled in code and the notes follow their letters', () => {
  const noSwap = toCard(CARDS[0], () => 0.99);
  assert.equal(noSwap.correct_option, 'A');
  assert.equal(noSwap.option_a, 'Rs 1,350');

  const card = toCard(CARDS[0], () => 0);
  assert.equal(card.correct_option, 'D');
  assert.equal(card.option_d, 'Rs 1,350');
  assert.deepEqual(card.misconceptions, {
    A: 'Gave the discount, not the selling price.',
    B: 'Added the discount instead of taking it off.',
    C: 'Took 1% off instead of 10%.',
  });
  assert.deepEqual(checkCard(card).errors, []);

  const letters = new Set(Array.from({ length: 200 }, () => toCard(CARDS[0]).correct_option));
  assert.deepEqual([...letters].sort(), ['A', 'B', 'C', 'D'], 'Math.random spreads the answer');
});

test('not SMS-suitable: model flag, OTHER topic, or compare/explain/justify/draw/prove', () => {
  const base = { topic: 'ALG', stem: 'Solve 2x+3=7.' };
  assert.equal(unsuitableReason(base), null);
  assert.match(unsuitableReason({ ...base, topic: 'OTHER' }), /Topic OTHER/);
  assert.match(unsuitableReason({ ...base, topic: 'PHY' }), /Topic PHY/);
  assert.equal(unsuitableReason({ ...base, sms_suitable: false, reason: 'Needs a graph.' }), 'Needs a graph.');
  for (const word of ['Compare', 'explain', 'Justify', 'draw', 'Prove', 'construct', 'Show that']) {
    assert.match(unsuitableReason({ ...base, stem: `${word} the two answers.` }), new RegExp(`"${word.toLowerCase()}"`));
  }
  assert.match(checkCard({ ...toCard(CARDS[0], () => 0.99), stem: 'Explain why SP is less.' }).unsuitable, /"explain"/);
});

test('one retry on a 5xx, none on a 4xx', async () => {
  const again = fakeGemini(httpError(503), REPLY);
  assert.equal((await extractCards(again, { image: PHOTO, mimeType: 'image/jpeg' })).cards.length, 4);
  assert.equal(again.calls.length, 2);

  const down = fakeGemini(httpError(500), httpError(502));
  await assert.rejects(extractCards(down, { image: PHOTO, mimeType: 'image/jpeg' }), (err) => err instanceof ImportError && /502/.test(err.message));
  assert.equal(down.calls.length, 2);

  const bad = fakeGemini(httpError(400));
  await assert.rejects(extractCards(bad, { image: PHOTO, mimeType: 'image/jpeg' }), ImportError);
  assert.equal(bad.calls.length, 1);
});

test('an unreadable reply is an ImportError', async () => {
  await assert.rejects(extractCards(fakeGemini('Sorry, I cannot read this.'), { image: PHOTO, mimeType: 'image/jpeg' }), /Could not read/);
  await assert.rejects(extractCards(fakeGemini('{"cards": "none"}'), { image: PHOTO, mimeType: 'image/jpeg' }), /Could not read/);
});

test('gemini client: photo inline, key never in errors or logs', async () => {
  assert.equal(createGemini({ apiKey: '', model: 'gemma-4' }), null);
  assert.equal(createGemini({ apiKey: KEY, model: '' }), null);

  const requests = [];
  const logs = [];
  let fail = null;
  const client = {
    models: {
      async generateContent(req) {
        requests.push(req);
        if (fail) throw fail;
        return { text: REPLY };
      },
    },
  };
  const gemini = createGemini({ apiKey: KEY, model: 'gemma-4-test', client, log: (m) => logs.push(m) });
  assert.equal(await gemini.generate({ image: PHOTO, mimeType: 'image/jpeg', instruction: 'read it' }), REPLY);
  const parts = requests[0].contents[0].parts;
  assert.equal(requests[0].model, 'gemma-4-test');
  assert.deepEqual(parts[0], { inlineData: { mimeType: 'image/jpeg', data: PHOTO.toString('base64') } });
  assert.equal(parts[1].text, 'read it');

  fail = httpError(400, `API key not valid: ${KEY}`);
  await assert.rejects(gemini.generate({ image: PHOTO, mimeType: 'image/jpeg', instruction: 'x' }), (err) => {
    assert.equal(err.status, 400);
    assert.ok(!err.message.includes(KEY));
    assert.match(err.message, /API key not valid: \*\*\*/);
    return true;
  });
  fail = httpError(503, `overloaded ${KEY}`);
  await assert.rejects(extractCards(gemini, { image: PHOTO, mimeType: 'image/jpeg' }), (err) => !err.message.includes(KEY));
  assert.equal(requests.length, 4, 'one retry on 503');
  assert.ok(logs.every((l) => !l.includes(KEY) && !l.includes(PHOTO.toString('base64'))));
  assert.match(logs[0], /^Photo import gemma-4-test \d+ms ok$/);
  assert.match(logs.at(-1), /^Photo import gemma-4-test \d+ms error 503$/);
});

// ---- API ----

const said = (text) => JSON.stringify({ explanation: text });

async function setup({ gemini = fakeGemini(REPLY), llmReply = said('You mixed up the price before and after the discount.') } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abhyaas-import-'));
  const importsFile = path.join(dir, 'imported-questions.local.json');
  const db = openDb(':memory:');
  seed(db);
  const llm = { chat: async () => llmReply };
  const engine = createSmsEngine(db, { llm });
  const server = createApp(db, engine, { gemini, llm, importsFile, rng: () => 0, ollamaHost: 'http://127.0.0.1:9' }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, route, body, type = 'application/json') => {
    const r = await fetch(base + route, {
      method,
      headers: body === undefined ? undefined : { 'content-type': type },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  };
  const done = async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { db, api, importsFile, dir, done };
}

test('POST /api/import/photo returns checked cards; 503 without Gemini; 415 without a photo', async () => {
  const s = await setup();
  try {
    const r = await s.api('POST', '/api/import/photo', PHOTO, 'image/jpeg');
    assert.equal(r.status, 200);
    assert.equal(r.data.summary, 'Found 4 sub-parts, 4 cards returned');
    assert.deepEqual(r.data.cards[0].errors, []);
    assert.match(r.data.cards[1].errors.join(), /2000\*3\*5\/100 = 300/);
    assert.equal((await s.api('POST', '/api/import/photo', { image: 'x' })).status, 415);
    assert.equal((await s.api('POST', '/api/import/photo', PHOTO, 'application/pdf')).status, 415);
    assert.deepEqual(fs.readdirSync(s.dir), [], 'the photo is never written to disk');
  } finally {
    await s.done();
  }
  const off = await setup({ gemini: null });
  try {
    const r = await off.api('POST', '/api/import/photo', PHOTO, 'image/jpeg');
    assert.equal(r.status, 503);
    assert.match(r.data.error, /GEMINI_API_KEY/);
  } finally {
    await off.done();
  }
});

test('a model failure is a 502 with the reason', async () => {
  const s = await setup({ gemini: fakeGemini(httpError(500), httpError(500, 'still down')) });
  try {
    const r = await s.api('POST', '/api/import/photo', PHOTO, 'image/jpeg');
    assert.equal(r.status, 502);
    assert.match(r.data.error, /still down/);
  } finally {
    await s.done();
  }
});

test('approve re-checks the card, saves it approved/photo-import and writes the local file', async () => {
  const s = await setup();
  try {
    const { cards } = (await s.api('POST', '/api/import/photo', PHOTO, 'image/jpeg')).data;
    const [ok, badSum, draw] = cards;

    const saved = await s.api('POST', '/api/import/questions', ok);
    assert.equal(saved.status, 201);
    const row = s.db.prepare('SELECT * FROM questions WHERE id = ?').get(saved.data.id);
    assert.equal(row.status, 'approved');
    assert.equal(row.source, 'photo-import');
    assert.equal(row.subject, 'MATH');
    assert.equal(row.source_ref, '1(a)');
    assert.equal(row.correct_option, 'D', 'shuffled by rng 0');

    const file = loadImports(s.importsFile);
    assert.equal(file.length, 1);
    assert.equal(file[0].stem, ok.stem);
    assert.deepEqual(file[0].misconceptions, ok.misconceptions);

    assert.equal((await s.api('POST', '/api/import/questions', ok)).status, 409, 'same stem twice');

    const count = () => s.db.prepare("SELECT COUNT(*) AS n FROM questions WHERE source = 'photo-import'").get().n;
    const bad = await s.api('POST', '/api/import/questions', badSum);
    assert.equal(bad.status, 400);
    assert.match(bad.data.errors.join(), /= 300/);
    assert.equal(badSum.correct_option, 'D');
    const fixed = await s.api('POST', '/api/import/questions', { ...badSum, option_d: 'Rs 300', solution: 'SI=2000*3*5/100=300' });
    assert.equal(fixed.status, 201, JSON.stringify(fixed.data));

    assert.equal((await s.api('POST', '/api/import/questions', draw)).status, 400);
    const sneaky = await s.api('POST', '/api/import/questions', { ...ok, stem: 'Prove that SP is Rs 1,350.' });
    assert.equal(sneaky.status, 400, 'unsuitable even if the page sent no flag');
    assert.match(sneaky.data.error, /"prove"/);
    assert.equal(count(), 2);
    assert.equal(loadImports(s.importsFile).length, 2);
  } finally {
    await s.done();
  }
});

test('approved imports come back after a reseed, without duplicates', async () => {
  const s = await setup();
  try {
    const { cards } = (await s.api('POST', '/api/import/photo', PHOTO, 'image/jpeg')).data;
    assert.equal((await s.api('POST', '/api/import/questions', cards[0])).status, 201);
    const imports = loadImports(s.importsFile);
    const fresh = openDb(':memory:');
    const broken = { ...imports[0], stem: 'Broken', solution: 'SP=2*3=7' };
    const errors = [];
    const origError = console.error;
    console.error = (m) => errors.push(m);
    try {
      assert.equal(seed(fresh, { imports: [...imports, broken] }).imported, 1);
      assert.equal(seed(fresh, { imports }).imported, 0);
    } finally {
      console.error = origError;
    }
    assert.match(errors.join(), /is wrong: 2\*3 = 6/);
    const row = fresh.prepare("SELECT * FROM questions WHERE source = 'photo-import'").get();
    assert.equal(row.status, 'approved');
    assert.equal(row.stem, cards[0].stem);
  } finally {
    await s.done();
  }
});

test('explanation drafts run in the background for approved imports only', async () => {
  const s = await setup();
  try {
    const { cards } = (await s.api('POST', '/api/import/photo', PHOTO, 'image/jpeg')).data;
    const { id } = (await s.api('POST', '/api/import/questions', cards[0])).data;
    const started = await s.api('POST', '/api/import/explanations');
    assert.equal(started.status, 202);
    assert.equal(started.data.running, true);
    let job;
    for (let i = 0; i < 100; i++) {
      job = (await s.api('GET', '/api/import/explanations')).data;
      if (job.done) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.deepEqual({ ...job }, { running: false, checked: 3, drafted: 3, failed: 0, error: null, done: true });
    const rows = s.db.prepare('SELECT question_id, option, status, model FROM explanations ORDER BY option').all();
    assert.deepEqual(rows, ['A', 'B', 'C'].map((option) => ({ question_id: id, option, status: 'draft', model: 'gemma' })));
  } finally {
    await s.done();
  }
});
