import test from 'node:test';
import assert from 'node:assert/strict';
import { SEED_QUESTIONS } from '../src/seed-data.js';
import {
  EXPLANATION_LIMIT,
  mentionsLetter,
  newScienceTerms,
  statesOperation,
  validateExplanation,
  wrongReply,
} from '../src/validate-explanation.js';
import { fitsOneSms } from '../src/gsm7.js';

const seedQ = (ref) => SEED_QUESTIONS.find((q) => q.source_ref === ref);
const VAT = seedQ('seed:PCT-1'); // correct B) Rs 2034; C) Rs 1800 forgot VAT
const HCF = seedQ('seed:HCF-1'); // correct A) x-2
const MASS = seedQ('seed:PHY-1'); // correct D) 60 kg
const GAS = seedQ('seed:CHEM-1'); // correct A) Hydrogen
const errorsOf = (text, q, letter, opts) => validateExplanation(text, q, letter, opts).errors.join(' | ');

test('a good explanation passes', () => {
  const r = validateExplanation('You stopped after the discount. VAT is added after it.', VAT, 'C');
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  const s = validateExplanation('Weight changes on the Moon, but mass is the amount of matter.', MASS, 'A');
  assert.deepEqual(s.errors, []);
});

test('length: at most 120 GSM-7 chars, and the full reply fits one SMS', () => {
  const max = 'y'.repeat(EXPLANATION_LIMIT);
  assert.ok(fitsOneSms(wrongReply(max)));
  assert.doesNotMatch(errorsOf(max, MASS, 'A'), /chars/);
  assert.match(errorsOf(`${max}y`, VAT, 'C'), /121 chars, max 120/);
  assert.match(errorsOf(`${'{'.repeat(61)}`, VAT, 'C'), /122 chars/, 'extension chars count 2');
  assert.match(errorsOf('', VAT, 'C'), /empty/);
});

test('GSM-7 only', () => {
  assert.match(errorsOf('You forgot VAT 👍', VAT, 'C'), /non GSM-7/);
  assert.match(errorsOf('You forgot “VAT”', VAT, 'C'), /non GSM-7/);
  assert.match(errorsOf('भ्याट', VAT, 'C'), /non GSM-7/);
});

test('never the correct letter', () => {
  for (const text of ['Option B is right.', 'The answer: B', 'Pick (B) next time.', 'B) is right.', 'It is B.']) {
    assert.match(errorsOf(text, VAT, 'C'), /correct letter B/, text);
  }
  assert.doesNotMatch(errorsOf('You picked C, but VAT is added after the discount.', VAT, 'C'), /letter/);
  // "A" as an article is fine; "A" as the option is not.
  assert.equal(mentionsLetter('A metal and an acid give a salt.', 'A'), false);
  assert.equal(mentionsLetter('Choose A.', 'A'), true);
  assert.equal(mentionsLetter('(A) is right', 'A'), true);
  assert.equal(mentionsLetter('It is A.', 'A'), true);
  assert.equal(mentionsLetter('CO2 is a gas', 'C'), false, 'part of a word');
});

test('never the correct option value', () => {
  assert.match(errorsOf('The selling price is Rs 2,034.', VAT, 'C'), /correct answer "Rs 2034"/);
  assert.match(errorsOf('It comes to 2034.', VAT, 'C'), /correct answer/);
  assert.match(errorsOf('Check the factors: x - 2 is common.', HCF, 'B'), /correct answer "x-2"/);
  assert.match(errorsOf('Mass stays 60 kg.', MASS, 'A'), /correct answer "60 kg"/);
  assert.match(errorsOf('The gas is hydrogen.', GAS, 'B'), /correct answer "Hydrogen"/);
});

test('never states the final operation on the numbers; past tense is fine', () => {
  for (const text of ['Now add 234 to 1800.', 'Subtract 10 from 13 first.', 'Divide 1000 by 1.25', 'multiply 10000 by 1.21']) {
    assert.equal(statesOperation(text), true, text);
  }
  for (const text of [
    'You added 13% to the marked price.', 'Did you add 13% VAT to 2000?', 'You subtracted 10% from 13%.',
    'Remember to add VAT after the discount.', 'You did not add 13% VAT.',
  ]) {
    assert.equal(statesOperation(text), false, text);
  }
  assert.match(errorsOf('Now add 234 to 1800.', VAT, 'C'), /which operation/);
});

test('maths numbers must come from the stem, options or solution (teacher: warning only)', () => {
  assert.match(errorsOf('VAT is 15% here.', VAT, 'C'), /numbers not in the question.*: 15/);
  assert.doesNotMatch(errorsOf('You found 1800 but VAT of 13% is still to come.', VAT, 'C'), /numbers/);
  const r = validateExplanation('VAT is 15% here.', VAT, 'C', { mode: 'teacher' });
  assert.equal(r.ok, true);
  assert.match(r.warnings.join(), /15/);
  const bad = validateExplanation('Option B. VAT is 15%.', VAT, 'C', { mode: 'teacher' });
  assert.equal(bad.ok, false, 'other checks still bind a teacher');
});

test('science: no key terms beyond the question, options, solution and note', () => {
  assert.deepEqual(newScienceTerms('Inertia is what changes.', MASS, 'A'), ['Inertia']);
  assert.deepEqual(newScienceTerms('You mixed up mass and weight.', MASS, 'A'), []);
  assert.deepEqual(newScienceTerms('Check your thinking again carefully.', MASS, 'A'), [], 'common words are fine');
  assert.deepEqual(newScienceTerms('It forms ZnSO4.', GAS, 'B'), ['ZnSO4'], 'formulas must be in the question');
  assert.match(errorsOf('Inertia is what changes.', MASS, 'A'), /science terms.*Inertia/);
  assert.match(errorsOf('Inertia is what changes.', MASS, 'A', { mode: 'teacher' }), /science terms/);
});

test('only wrong options get explanations', () => {
  assert.match(errorsOf('Anything.', VAT, 'B'), /correct answer; explanations are for wrong options/);
  assert.match(errorsOf('Anything.', VAT, 'E'), /A, B, C or D/);
});
