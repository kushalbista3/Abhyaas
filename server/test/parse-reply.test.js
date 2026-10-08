import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { seed } from '../src/seed.js';
import { createSmsEngine, REPLIES } from '../src/engine.js';
import { matchLetter, matchValue, modelLetter, parseReply } from '../src/llm/parse-reply.js';
import { SEED_QUESTIONS } from '../src/seed-data.js';

// A fake model: each call takes the next reply (a string, null, or a function
// of the messages); calls are recorded.
function fakeLlm(...replies) {
  const calls = [];
  return {
    calls,
    async chat(messages, opts) {
      calls.push({ messages, opts });
      const r = replies.length > 1 ? replies.shift() : replies[0];
      return typeof r === 'function' ? r(messages, opts) : r;
    },
  };
}

const seedQ = (ref) => SEED_QUESTIONS.find((q) => q.source_ref === ref);
const VAT = seedQ('seed:PCT-1'); // B) Rs 2034, C) Rs 1800
const HCF = seedQ('seed:HCF-1'); // A) x-2, B) x+2
const LIGHT = seedQ('seed:PHY-2'); // B) Slows down

test('regex: a letter alone, with filler, or after a keyword', () => {
  const cases = {
    b: 'B', 'B)': 'B', '(c)': 'C', 'd.': 'D', 'c?': 'C', 'b ho': 'B', 'B ho sir': 'B', 'a hola': 'A',
    'mero answer c': 'C', 'answer is D': 'D', 'ans: a': 'A', 'Uttar b': 'B', 'option C.': 'C', 'mero answer c ho': 'C',
  };
  for (const [text, want] of Object.entries(cases)) assert.equal(matchLetter(text), want, text);
});

test('regex: ordinary words and sentences are not letters', () => {
  for (const text of ['a lot of work', 'is it b or c', 'abc', 'bad', 'answer a lot', 'e', 'hello', 'answers b', 'I think so']) {
    assert.equal(matchLetter(text), null, text);
  }
});

test('value match: a typed value equal to exactly one option', () => {
  assert.equal(matchValue('2034', VAT), 'B');
  assert.equal(matchValue('Rs 2,034', VAT), 'B');
  assert.equal(matchValue('mero answer 2034 ho', VAT), 'B');
  assert.equal(matchValue('1800.', VAT), 'C');
  assert.equal(matchValue('12', VAT), null);
  assert.equal(matchValue('x - 2', HCF), 'A');
  assert.equal(matchValue('(x+2)(x-2)(x+3)', HCF), 'C', 'same value, different order');
  assert.equal(matchValue('slows  down!', LIGHT), 'B');
  assert.equal(matchValue('slow', LIGHT), null);
});

test('model path: a letter, UNKNOWN, junk, failure; never called when code matches', async () => {
  assert.equal(await modelLetter(fakeLlm('{"answer":"C"}'), VAT, 'the one without VAT'), 'C');
  assert.equal(await modelLetter(fakeLlm('{"answer":"UNKNOWN"}'), VAT, 'hmm'), null);
  assert.equal(await modelLetter(fakeLlm('{"answer":"E"}'), VAT, 'hmm'), null);
  assert.equal(await modelLetter(fakeLlm('not json'), VAT, 'hmm'), null);
  assert.equal(await modelLetter(fakeLlm(null), VAT, 'hmm'), null, 'timeout or error');
  assert.equal(await modelLetter(null, VAT, 'hmm'), null, 'no model');

  const llm = fakeLlm('{"answer":"D"}');
  assert.equal(await parseReply('b ho', VAT, llm), 'B');
  assert.equal(await parseReply('2034', VAT, llm), 'B');
  assert.equal(llm.calls.length, 0);
  assert.equal(await parseReply('the last one', VAT, llm), 'D');
  assert.equal(llm.calls.length, 1);
  const prompt = llm.calls[0].messages.map((m) => m.content).join('\n');
  assert.match(prompt, /Student reply: the last one/);
  assert.match(prompt, /D\) Rs 2260/);
  assert.ok(llm.calls[0].opts.format, 'JSON schema output');
});

function setup(llm) {
  const db = openDb(':memory:');
  seed(db);
  const engine = createSmsEngine(db, { now: () => new Date(2026, 9, 8, 12), llm });
  const send = (body) => engine.handleIncomingSms('9811111111', body);
  const pose = (ref) => {
    const sid = db.prepare("SELECT id FROM students WHERE phone = '9811111111'").get().id;
    const qid = db.prepare('SELECT id FROM questions WHERE source_ref = ?').get(ref).id;
    db.prepare("UPDATE sessions SET state = 'ended' WHERE student_id = ?").run(sid);
    db.prepare('INSERT INTO sessions (student_id, current_question_id) VALUES (?, ?)').run(sid, qid);
    return qid;
  };
  const attempts = () => db.prepare('SELECT chosen_option, is_correct FROM attempts ORDER BY id').all();
  return { db, send, pose, attempts };
}

test('engine: free-text replies are graded by code after mapping', async () => {
  const llm = fakeLlm('{"answer":"B"}');
  const { send, pose, attempts } = setup(llm);
  await send('JOIN Sita');
  pose('seed:PCT-1');
  assert.match(await send('mero answer 2034 ho'), /^Correct!/);
  pose('seed:PCT-1');
  assert.match(await send('c ho'), /^Not quite\./);
  assert.equal(llm.calls.length, 0);
  assert.match(await send('i think the 2nd one'), /^Correct on your 2nd try!/, 'model mapped it to B');
  assert.equal(llm.calls.length, 1);
  assert.deepEqual(attempts(), [
    { chosen_option: 'B', is_correct: 1 },
    { chosen_option: 'C', is_correct: 0 },
    { chosen_option: 'B', is_correct: 1 },
  ]);
});

test('engine: UNKNOWN or a failed model asks for A/B/C/D and records nothing', async () => {
  for (const reply of ['{"answer":"UNKNOWN"}', null, 'garbage']) {
    const { send, pose, attempts } = setup(fakeLlm(reply));
    await send('JOIN Sita');
    const qid = pose('seed:PCT-1');
    assert.equal(await send('what is this'), REPLIES.whichOption(qid));
    assert.deepEqual(attempts(), []);
  }
  const { send } = setup(fakeLlm('{"answer":"A"}'));
  await send('JOIN Sita');
  assert.equal(await send('what is this'), REPLIES.unknown, 'no question waiting: no model call, no grading');
});

test('engine: if the question changed while the model ran, nothing is graded', async () => {
  let ctx;
  const llm = fakeLlm(() => {
    ctx.newQid = ctx.pose('seed:SET-1'); // another SMS served a new question meanwhile
    return '{"answer":"B"}';
  });
  ctx = setup(llm);
  await ctx.send('JOIN Sita');
  ctx.pose('seed:PCT-1');
  assert.equal(await ctx.send('the second one'), REPLIES.whichOption(ctx.newQid));
  assert.deepEqual(ctx.attempts(), []);
});
