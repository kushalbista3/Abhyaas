import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { seed } from '../src/seed.js';
import { createSmsEngine, REPLIES } from '../src/engine.js';
import { fitsOneSms } from '../src/gsm7.js';
import { ASK_LIMIT, COMPUTE_TAIL, METHOD_HINTS, askModel, computeReply, isComputeRequest, topicOf } from '../src/llm/ask.js';
import { TOPIC_CODES } from '../src/sms.js';

function fakeLlm(reply) {
  const calls = [];
  return {
    calls,
    async chat(messages, opts) {
      calls.push({ messages, opts });
      return typeof reply === 'function' ? reply(messages, opts) : reply;
    },
  };
}
const said = (text, isMaths = true) => JSON.stringify({ is_maths: isMaths, reply: text });

test('compute requests: equations, operators, "solve", Nepali words, two numbers', () => {
  for (const text of [
    'solve 2x+3=7', 'x^2-5x+6', '1800+234', '5/8 * 4/7', 'what is 13% of 1800 and 10% of 2000',
    'simplify (x^3)^2', 'Calculate the CP', 'yo kati hunchha', 'a+b ko square', 'find the value of x',
    'HCF of 12 and 18', '2x3',
  ]) {
    assert.equal(isComputeRequest(text), true, text);
  }
});

test('concept questions are not compute requests', () => {
  for (const text of [
    'what is HCF?', 'difference between simple and compound interest', 'what is a Venn diagram',
    'VAT bhaneko ke ho', 'why is probability never more than 1', 'what is depreciation', 'how to find a cone volume',
  ]) {
    assert.equal(isComputeRequest(text), false, text);
  }
});

test('topicOf picks the topic from keywords', () => {
  assert.equal(topicOf('find the LCM of 6 and 9'), 'HCF');
  assert.equal(topicOf('profit 25% on 1000'), 'PCT');
  assert.equal(topicOf('compound interest 10000 2 years'), 'INT');
  assert.equal(topicOf('solve 2x+3=7'), 'ALG');
  assert.equal(topicOf('cone r=7 h=12 volume'), 'GEO');
  assert.equal(topicOf('venn 60 50 20'), 'SET');
  assert.equal(topicOf('two dice sum 7'), 'PROB');
  assert.equal(topicOf('123 456'), null);
});

test('every method hint fits one SMS with "Sent to your teacher too."', () => {
  assert.deepEqual(Object.keys(METHOD_HINTS).sort(), [...TOPIC_CODES.MATH, 'GENERAL'].sort());
  for (const topic of Object.keys(METHOD_HINTS)) {
    const reply = computeReply(topic);
    assert.ok(reply.endsWith(COMPUTE_TAIL));
    assert.ok(fitsOneSms(reply), `${topic}: ${reply}`);
  }
  assert.equal(computeReply(null), METHOD_HINTS.GENERAL + COMPUTE_TAIL);
});

test('askModel: checks the model reply in code', async () => {
  const ok = 'HCF is the biggest factor common to all the expressions.';
  assert.equal(await askModel(fakeLlm(said(ok)), 'what is HCF'), ok);
  assert.equal(await askModel(fakeLlm(said(ok, false)), 'what is DNA'), null, 'not maths');
  assert.equal(await askModel(fakeLlm(said('महत्तम समापवर्तक')), 'HCF?'), null, 'Devanagari');
  assert.equal(await askModel(fakeLlm(said('')), 'HCF?'), null, 'empty');
  assert.equal(await askModel(fakeLlm('not json'), 'HCF?'), null);
  assert.equal(await askModel(fakeLlm(null), 'HCF?'), null, 'timeout or error');
  assert.equal(await askModel(null, 'HCF?'), null, 'no model');
  assert.equal(await askModel(fakeLlm(said('It is ‘common’ – shared.')), 'HCF?'), "It is 'common' - shared.", 'look-alikes swapped');

  const long = `${'First sentence is here. '.repeat(5)}${'x'.repeat(80)}`;
  const cut = await askModel(fakeLlm(said(long)), 'HCF?');
  assert.ok(cut.length <= ASK_LIMIT && cut.endsWith('.'), 'trimmed at a sentence end');
  assert.equal(await askModel(fakeLlm(said('y'.repeat(ASK_LIMIT + 1))), 'HCF?'), null, 'too long, no sentence end');

  const llm = fakeLlm(said(ok));
  await askModel(llm, 'what is HCF');
  const system = llm.calls[0].messages[0].content;
  for (const name of ['HCF/LCM', 'Profit/VAT', 'Interest', 'Algebra', 'Area/Volume', 'Sets', 'Probability']) {
    assert.ok(system.includes(name), `prompt lists ${name}`);
  }
  assert.match(system, /150 characters/);
  assert.match(system, /Romanized Nepali/);
});

function setup(llm) {
  const db = openDb(':memory:');
  seed(db);
  const engine = createSmsEngine(db, { now: () => new Date(2026, 9, 8, 12), llm });
  const send = (body) => engine.handleIncomingSms('9811111111', body);
  const doubts = () => db.prepare('SELECT subject, text, status, reply FROM doubts ORDER BY id').all();
  return { db, send, doubts };
}

test('science ASK never calls the model and is saved as a SCI doubt', async () => {
  const llm = fakeLlm(said('Gemma should never say this'));
  const { send, doubts } = setup(llm);
  await send('JOIN Sita');
  await send('SUBJECT SCI');
  assert.equal(await send('ASK why does light bend in glass?'), REPLIES.askScience);
  assert.equal(await send('ASK what is 2+2'), REPLIES.askScience, 'even a sum, in science');
  await send('SUBJECT MATH');
  assert.equal(await send('ASK what is photosynthesis'), REPLIES.askScience, 'science words in maths subject');
  assert.equal(llm.calls.length, 0);
  assert.deepEqual(doubts().map((d) => [d.subject, d.status]), [['SCI', 'open'], ['SCI', 'open'], ['SCI', 'open']]);
});

test('maths compute ASK: method hint, no model, open doubt', async () => {
  const llm = fakeLlm(said('should not be used'));
  const { send, doubts } = setup(llm);
  await send('JOIN Sita');
  assert.equal(await send('ASK solve x^2-5x+6=0'), METHOD_HINTS.ALG + COMPUTE_TAIL);
  assert.equal(await send('ASK 1000 ko 25% kati hunchha'), METHOD_HINTS.PCT + COMPUTE_TAIL);
  assert.equal(await send('ASK 12 and 30'), METHOD_HINTS.GENERAL + COMPUTE_TAIL, 'no topic, nothing served yet');
  await send('QUIZ SET');
  assert.equal(await send('ASK 12 and 30'), METHOD_HINTS.SET + COMPUTE_TAIL, 'falls back to the last maths topic');
  assert.equal(llm.calls.length, 0);
  assert.deepEqual(doubts()[0], { subject: 'MATH', text: 'solve x^2-5x+6=0', status: 'open', reply: null });
  assert.equal(doubts().length, 4);
});

test('maths concept ASK: model answer saved as answered; failure goes to the teacher', async () => {
  const answer = 'Depreciation means the value of a thing goes down every year by a fixed rate.';
  const llm = fakeLlm(said(answer));
  const { send, doubts } = setup(llm);
  await send('JOIN Sita');
  assert.equal(await send('ASK what is depreciation'), answer);
  assert.equal(llm.calls.length, 1);
  assert.deepEqual(doubts(), [{ subject: 'MATH', text: 'what is depreciation', status: 'answered', reply: answer }]);

  for (const reply of [null, said('', true), said('This is about plants.', false)]) {
    const s = setup(fakeLlm(reply));
    await s.send('JOIN Sita');
    assert.equal(await s.send('ASK what is a set'), REPLIES.askTeacher);
    assert.deepEqual(s.doubts(), [{ subject: 'MATH', text: 'what is a set', status: 'open', reply: null }]);
  }

  const noModel = setup(null);
  await noModel.send('JOIN Sita');
  assert.equal(await noModel.send('ASK what is a set'), REPLIES.askTeacher);
});

test('ALG method hint fits linear equations too', async () => {
  assert.match(METHOD_HINTS.ALG, /get x on one side: undo \+ or - first, then \* or \//);
  assert.ok(fitsOneSms(METHOD_HINTS.ALG + COMPUTE_TAIL));
  const llm = fakeLlm(said('should not be used'));
  const { send } = setup(llm);
  await send('JOIN Sita');
  assert.equal(await send('ASK solve 2x+3=7'), METHOD_HINTS.ALG + COMPUTE_TAIL);
  assert.equal(llm.calls.length, 0);
});
