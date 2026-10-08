import test from 'node:test';
import assert from 'node:assert/strict';
import { SEED_QUESTIONS, DEMO_STUDENTS } from '../src/seed-data.js';
import { validateQuestion } from '../src/validate-question.js';
import { TOPIC_CODES } from '../src/sms.js';

test('every seed question passes validateQuestion', () => {
  for (const q of SEED_QUESTIONS) {
    const r = validateQuestion(q);
    assert.deepEqual(r.errors, [], q.source_ref);
  }
});

test('14 questions, 2 per topic, unique stems and refs', () => {
  assert.equal(SEED_QUESTIONS.length, 14);
  for (const t of TOPIC_CODES) assert.equal(SEED_QUESTIONS.filter((q) => q.topic === t).length, 2, t);
  assert.equal(new Set(SEED_QUESTIONS.map((q) => q.stem)).size, 14);
  assert.equal(new Set(SEED_QUESTIONS.map((q) => q.source_ref)).size, 14);
});

test('correct letters are spread: each of A-D is correct 3 or 4 times', () => {
  for (const l of 'ABCD') {
    const n = SEED_QUESTIONS.filter((q) => q.correct_option === l).length;
    assert.ok(n === 3 || n === 4, `${l} is correct ${n} times`);
  }
});

test('demo students store only phone, name, class', () => {
  assert.equal(DEMO_STUDENTS.length, 3);
  for (const s of DEMO_STUDENTS) assert.deepEqual(Object.keys(s).sort(), ['class', 'name', 'phone']);
});
