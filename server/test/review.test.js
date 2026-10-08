import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { seed } from '../src/seed.js';
import { approve, countByStatus, describe, editQuestion, listQuestions, parseAssignments } from '../src/review.js';

function seeded() {
  const db = openDb(':memory:');
  seed(db);
  return db;
}
const idOf = (db, ref) => db.prepare('SELECT id FROM questions WHERE source_ref = ?').get(ref).id;
const statusOf = (db, id) => db.prepare('SELECT status FROM questions WHERE id = ?').get(id).status;

test('list shows only questions needing review unless --all', () => {
  const db = seeded();
  const pending = listQuestions(db);
  assert.equal(pending.length, 8);
  assert.ok(pending.every((q) => q.subject === 'SCI' && q.status === 'needs-review'));
  assert.equal(listQuestions(db, { all: true }).length, 22);
  assert.deepEqual(countByStatus(db), { 'needs-review': 8, approved: 14 });
});

test('describe shows SMS with length, answer, solution and notes', () => {
  const db = seeded();
  const text = describe(listQuestions(db)[0]);
  assert.match(text, /SMS \(\d+\/160\)/);
  assert.match(text, /Correct: [A-D]/);
  assert.match(text, /Solution: /);
  assert.match(text, /Wrong-option notes:\n {4}[A-D]: /);
});

test('approve sets status and reports unknown ids', () => {
  const db = seeded();
  const a = idOf(db, 'seed:PHY-1');
  const b = idOf(db, 'seed:BIO-2');
  const res = approve(db, [a, b, 9999]);
  assert.deepEqual(res.map((r) => r.ok), [true, true, false]);
  assert.match(res[2].errors.join(), /no such question/);
  assert.equal(statusOf(db, a), 'approved');
  assert.equal(statusOf(db, b), 'approved');
});

test('approve refuses a question that no longer validates', () => {
  const db = seeded();
  const id = idOf(db, 'seed:PHY-2');
  db.prepare("UPDATE questions SET misconceptions = '{}' WHERE id = ?").run(id);
  const [r] = approve(db, [id]);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /missing misconception note/);
  assert.equal(statusOf(db, id), 'needs-review');
});

test('parseAssignments maps fields and misconception notes', () => {
  assert.deepEqual(parseAssignments(['option_b=Slows down', 'misconception_c=', 'Solution=a=b']), {
    option_b: 'Slows down',
    misconceptions: { C: '' },
    solution: 'a=b',
  });
  assert.throws(() => parseAssignments(['status=approved']), /can't edit "status"/);
  assert.throws(() => parseAssignments(['stem']), /expected field=value/);
});

test('a valid edit is saved and goes back to needs-review', () => {
  const db = seeded();
  const id = idOf(db, 'seed:EARTH-2');
  approve(db, [id]);
  const r = editQuestion(db, id, parseAssignments(['option_d=How bright', 'misconception_d=Thought it measures brightness.']));
  assert.deepEqual(r, { ok: true, errors: [] });
  const row = db.prepare('SELECT option_d, misconceptions, status FROM questions WHERE id = ?').get(id);
  assert.equal(row.option_d, 'How bright');
  assert.equal(JSON.parse(row.misconceptions).D, 'Thought it measures brightness.');
  assert.equal(JSON.parse(row.misconceptions).A, 'The word "year" made them think it measures time.');
  assert.equal(row.status, 'needs-review');
});

test('an invalid edit is rejected and nothing is written', () => {
  const db = seeded();
  const id = idOf(db, 'seed:CHEM-1');
  const before = db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
  for (const changes of [
    { option_b: 'Hydrogen' },
    { topic: 'PROB' },
    { stem: 'x'.repeat(150) },
    { correct_option: 'B' },
    { misconceptions: { D: '' } },
  ]) {
    const r = editQuestion(db, id, changes);
    assert.equal(r.ok, false, JSON.stringify(changes));
  }
  assert.deepEqual(db.prepare('SELECT * FROM questions WHERE id = ?').get(id), before);
  assert.match(editQuestion(db, 9999, { stem: 'x' }).errors.join(), /no such question/);
});

test('maths edits still need the solution to reach the correct value', () => {
  const db = seeded();
  const id = idOf(db, 'seed:INT-1');
  assert.match(editQuestion(db, id, { solution: 'A=12000' }).errors.join(), /not the correct value/);
});
