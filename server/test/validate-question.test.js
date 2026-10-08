import test from 'node:test';
import assert from 'node:assert/strict';
import { validateQuestion, sameValue, sameText } from '../src/validate-question.js';

const good = () => ({
  subject: 'MATH',
  topic: 'INT',
  stem: 'Find the compound amount on Rs 10000 at 10% p.a. for 2 years.',
  option_a: 'Rs 12100',
  option_b: 'Rs 12000',
  option_c: 'Rs 2100',
  option_d: 'Rs 11000',
  correct_option: 'A',
  solution: 'A=10000*(1.1)^2=12100',
  misconceptions: { B: 'simple interest', C: 'only the interest', D: 'one year only' },
});

const errorsOf = (patch) => validateQuestion({ ...good(), ...patch }).errors;

test('a valid question passes', () => {
  const r = validateQuestion(good());
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test('misconceptions may be a JSON string (as stored in the DB)', () => {
  assert.equal(validateQuestion({ ...good(), misconceptions: JSON.stringify(good().misconceptions) }).ok, true);
});

const goodSci = () => ({
  subject: 'SCI',
  topic: 'CHEM',
  stem: 'Which gas is given off when zinc reacts with dilute hydrochloric acid?',
  option_a: 'Hydrogen',
  option_b: 'Oxygen',
  option_c: 'Chlorine',
  option_d: 'Carbon dioxide',
  correct_option: 'A',
  solution: 'Zn+2HCl->ZnCl2+H2. A metal and a dilute acid give a salt and hydrogen.',
  misconceptions: { B: 'no oxygen in HCl', C: 'chlorine stays in ZnCl2', D: 'carbonate reaction' },
});

const sciErrorsOf = (patch) => validateQuestion({ ...goodSci(), ...patch }).errors;

test('rejects unknown topic', () => {
  assert.match(errorsOf({ topic: 'TRIG' }).join(), /topic for MATH must be one of/);
});

test('rejects unknown or missing subject', () => {
  assert.match(errorsOf({ subject: 'ENG' }).join(), /subject must be one of MATH, SCI/);
  assert.match(errorsOf({ subject: undefined }).join(), /subject must be one of/);
});

test('topic must belong to the subject', () => {
  assert.match(errorsOf({ topic: 'PHY' }).join(), /topic for MATH must be one of HCF/);
  assert.match(sciErrorsOf({ topic: 'PROB' }).join(), /topic for SCI must be one of PHY, CHEM, BIO, EARTH/);
});

test('a science question passes with a prose solution (no value check)', () => {
  assert.deepEqual(validateQuestion(goodSci()).errors, []);
  assert.deepEqual(sciErrorsOf({ solution: 'Metal + dilute acid gives a salt and hydrogen gas.' }), []);
});

test('science still checks length, GSM-7 and misconceptions', () => {
  assert.match(sciErrorsOf({ solution: 'x'.repeat(161) }).join(), /solution is 161 chars/);
  assert.match(sciErrorsOf({ solution: 'H₂ gas' }).join(), /solution has non GSM-7/);
  assert.match(sciErrorsOf({ stem: 'x'.repeat(120) }).join(), /question SMS is \d+ chars/);
  assert.match(sciErrorsOf({ misconceptions: { B: 'a', C: 'b' } }).join(), /wrong option D/);
});

test('science options are compared as text, not as algebra', () => {
  assert.ok(sameValue('Carbon dioxide', 'Carbon monoxide'), 'why maths comparison is wrong for words');
  assert.ok(!sameText('Carbon dioxide', 'Carbon monoxide'));
  assert.ok(!sameText('Ohm', 'Mho'));
  assert.ok(sameText('Hydrogen', ' hydrogen.'));
  assert.ok(sameText('Pulmonary  vein', 'pulmonary vein'));
  assert.deepEqual(sciErrorsOf({ option_d: 'Carbon monoxide', option_c: 'Carbon dioxide' }), []);
  assert.match(sciErrorsOf({ option_b: 'hydrogen.' }).join(), /options A and B have the same value/);
});

test('rejects empty and duplicate options', () => {
  assert.match(errorsOf({ option_c: '' }).join(), /option C is empty/);
  assert.match(errorsOf({ option_d: 'Rs 12000' }).join(), /options B and D have the same value/);
});

test('equal values in different forms count as duplicates', () => {
  assert.ok(sameValue('2/4', '1/2'));
  assert.ok(sameValue('Rs 1,200', '1200'));
  assert.ok(sameValue('0.5', '1/2'));
  assert.ok(sameValue('x^2-1', '(x-1)(x+1)'));
  assert.ok(sameValue('2 and 3', '3, 2'));
  assert.ok(sameValue('30 cm^2', '30'));
  assert.ok(!sameValue('x-2', 'x+2'));
  assert.ok(!sameValue('2 and 3', '-2 and -3'));
  assert.ok(!sameValue('1/11', '1/12'));
  const errs = errorsOf({ option_a: '2/4', option_b: '1/2', solution: 'P=1/2' });
  assert.match(errs.join(), /options A and B have the same value/);
});

test('rejects bad correct_option', () => {
  assert.match(errorsOf({ correct_option: 'E' }).join(), /correct_option must be/);
  assert.match(errorsOf({ correct_option: 'a' }).join(), /correct_option must be/);
});

test('rejects a question SMS over 160 GSM-7 chars', () => {
  assert.match(errorsOf({ stem: 'x'.repeat(120) }).join(), /question SMS is \d+ chars/);
  // 60 carets = 120 septets even though only 60 JS chars
  assert.match(errorsOf({ stem: 'Find ' + '^'.repeat(60) }).join(), /question SMS is \d+ chars/);
});

test('rejects Devanagari and emoji', () => {
  assert.match(errorsOf({ stem: 'चक्रीय ब्याज?' }).join(), /non GSM-7/);
  assert.match(errorsOf({ option_b: '12000 👍' }).join(), /option B has non GSM-7/);
  assert.match(errorsOf({ solution: 'A=12100 ✓' }).join(), /solution has non GSM-7/);
});

test('rejects a long solution', () => {
  assert.match(errorsOf({ solution: 'x'.repeat(155) + '=12100' }).join(), /solution is \d+ chars/);
});

test('rejects a solution that does not reach the correct value', () => {
  assert.match(errorsOf({ solution: 'A=10000*(1.1)^2=12000' }).join(), /not the correct value/);
  assert.match(errorsOf({ correct_option: 'B', misconceptions: { A: 'x', C: 'y', D: 'z' } }).join(), /not the correct value/);
});

test('requires a misconception note for every wrong option, none for the correct one', () => {
  assert.match(errorsOf({ misconceptions: { B: 'a', C: 'b' } }).join(), /missing misconception note for wrong option D/);
  assert.match(errorsOf({ misconceptions: { B: 'a', C: 'b', D: ' ' } }).join(), /wrong option D/);
  assert.match(errorsOf({ misconceptions: { A: 'x', B: 'a', C: 'b', D: 'c' } }).join(), /given for correct option A/);
  assert.match(errorsOf({ misconceptions: 'not json' }).join(), /misconceptions must be an object/);
});

test('reports all errors at once', () => {
  const errs = errorsOf({ topic: 'X', option_a: '', misconceptions: {} });
  assert.ok(errs.length >= 3, errs.join('\n'));
});
