import test from 'node:test';
import assert from 'node:assert/strict';
import { SEED_QUESTIONS, DEMO_STUDENTS } from '../src/seed-data.js';
import { validateQuestion } from '../src/validate-question.js';
import { SUBJECTS, TOPIC_CODES } from '../src/sms.js';

test('every seed question passes validateQuestion', () => {
  for (const q of SEED_QUESTIONS) {
    const r = validateQuestion(q);
    assert.deepEqual(r.errors, [], q.source_ref);
  }
});

const bySubject = (s) => SEED_QUESTIONS.filter((q) => q.subject === s);

test('14 maths + 8 science questions, 2 per topic, unique stems and refs', () => {
  assert.equal(bySubject('MATH').length, 14);
  assert.equal(bySubject('SCI').length, 8);
  assert.equal(SEED_QUESTIONS.length, 22);
  for (const s of SUBJECTS) {
    for (const t of TOPIC_CODES[s]) assert.equal(bySubject(s).filter((q) => q.topic === t).length, 2, t);
  }
  assert.equal(new Set(SEED_QUESTIONS.map((q) => q.stem)).size, 22);
  assert.equal(new Set(SEED_QUESTIONS.map((q) => q.source_ref)).size, 22);
});

test('correct letters are spread within each subject', () => {
  for (const l of 'ABCD') {
    const math = bySubject('MATH').filter((q) => q.correct_option === l).length;
    assert.ok(math === 3 || math === 4, `maths: ${l} is correct ${math} times`);
    assert.equal(bySubject('SCI').filter((q) => q.correct_option === l).length, 2, `science: ${l}`);
  }
});

test('maths seeds as approved, science as needs-review (CLAUDE.md rule 8)', () => {
  for (const q of bySubject('MATH')) assert.equal(q.status, 'approved', q.source_ref);
  for (const q of bySubject('SCI')) assert.equal(q.status, 'needs-review', q.source_ref);
});

test('demo students store only phone, name, class', () => {
  assert.equal(DEMO_STUDENTS.length, 3);
  for (const s of DEMO_STUDENTS) assert.deepEqual(Object.keys(s).sort(), ['class', 'name', 'phone']);
});
