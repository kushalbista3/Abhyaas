import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { sqlTime } from '../src/practice.js';
import { classOverview, misconceptionStats, studentStats, topicAccuracy } from '../src/stats.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 9, 8, 12, 0, 0);

function setup() {
  const db = openDb(':memory:');
  const student = (phone, name) =>
    db.prepare("INSERT INTO students (phone, name, class) VALUES (?, ?, '10')").run(phone, name).lastInsertRowid;
  const addQ = (subject, topic, correct) =>
    db
      .prepare(`INSERT INTO questions (subject, topic, stem, option_a, option_b, option_c, option_d, correct_option,
        solution, misconceptions, source, status) VALUES (?, ?, ?, 'w', 'x', 'y', 'z', ?, 's', '{}', 'seed', 'approved')`)
      .run(subject, topic, `${topic} stem`, correct).lastInsertRowid;
  // One serving of question qid: the letters chosen in order, `daysAgo` days back.
  const serve = (sid, qid, letters, daysAgo = 1) => {
    const at = sqlTime(new Date(NOW.getTime() - daysAgo * DAY));
    const session = db
      .prepare("INSERT INTO sessions (student_id, current_question_id, state, started_at) VALUES (?, ?, 'ended', ?)")
      .run(sid, qid, at).lastInsertRowid;
    const right = db.prepare('SELECT correct_option FROM questions WHERE id = ?').get(qid).correct_option;
    for (const l of letters) {
      db.prepare('INSERT INTO attempts (student_id, question_id, session_id, chosen_option, is_correct, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(sid, qid, session, l, l === right ? 1 : 0, at);
    }
  };
  return { db, student, addQ, serve };
}

test('overview: last 7 days, all answers counted, accuracy on first tries only', () => {
  const { db, student, addQ, serve } = setup();
  const a = student('9800000011', 'Asha');
  student('9800000012', 'Binod');
  const q = addQ('MATH', 'HCF', 'A');
  const sci = addQ('SCI', 'PHY', 'B');
  serve(a, q, ['B', 'A']); // wrong, then right on the 2nd try
  serve(a, q, ['A']);
  serve(a, q, ['A'], 8); // older than a week
  serve(a, sci, ['A']); // other subject

  assert.deepEqual(classOverview(db, 'MATH', NOW), { students: 2, answersWeek: 3, firstTries: 2, firstTryAccuracy: 50 });
  assert.deepEqual(classOverview(db, 'SCI', NOW), { students: 2, answersWeek: 1, firstTries: 1, firstTryAccuracy: 0 });
  const empty = openDb(':memory:');
  assert.deepEqual(classOverview(empty, 'MATH', NOW), { students: 0, answersWeek: 0, firstTries: 0, firstTryAccuracy: null });
});

test('weak topics: first-try accuracy per topic, worst first, subject only', () => {
  const { db, student, addQ, serve } = setup();
  const a = student('9800000011', 'Asha');
  const hcf = addQ('MATH', 'HCF', 'A');
  const pct = addQ('MATH', 'PCT', 'B');
  const alg = addQ('MATH', 'ALG', 'C');
  serve(a, hcf, ['A']);
  serve(a, hcf, ['B', 'A']);
  serve(a, pct, ['A', 'B']); // a right 2nd try doesn't help
  serve(a, pct, ['C']);
  serve(a, pct, ['B']);
  serve(a, alg, ['C']);
  serve(a, addQ('SCI', 'BIO', 'A'), ['B']);

  assert.deepEqual(
    topicAccuracy(db, 'MATH').map((t) => [t.topic, t.name, t.correct, t.tries, t.pct]),
    [['PCT', 'Profit/VAT', 1, 3, 33], ['HCF', 'HCF/LCM', 1, 2, 50], ['ALG', 'Algebra', 1, 1, 100]],
  );
  assert.deepEqual(topicAccuracy(db, 'SCI').map((t) => t.topic), ['BIO']);
});

test('misconceptions: most-chosen wrong first try and its approved explanation, lowest first', () => {
  const { db, student, addQ, serve } = setup();
  const [a, b, c] = ['Asha', 'Binod', 'Chandra'].map((n, i) => student(`980000002${i}`, n));
  const q1 = addQ('MATH', 'PCT', 'B');
  const q2 = addQ('MATH', 'HCF', 'A');
  const exp = db.prepare('INSERT INTO explanations (question_id, option, text, status, model) VALUES (?, ?, ?, ?, ?)');
  exp.run(q1, 'A', 'Old approved text.', 'approved', 'gemma');
  exp.run(q1, 'A', 'Net rate on the marked price.', 'approved', 'teacher');
  exp.run(q1, 'C', 'A draft only.', 'draft', 'gemma');
  serve(a, q1, ['A', 'C']); // second tries don't count as the misconception
  serve(b, q1, ['A', 'C']);
  serve(c, q1, ['C']);
  serve(a, q2, ['A']);
  serve(b, q2, ['C']);

  const rows = misconceptionStats(db, 'MATH');
  assert.deepEqual(
    rows.map((r) => [r.id, r.pct, r.tries, r.wrongOption, r.wrongText, r.wrongCount, r.explanation]),
    [
      [q1, 0, 3, 'A', 'w', 2, 'Net rate on the marked price.'],
      [q2, 50, 2, 'C', 'y', 1, null],
    ],
  );
  assert.equal(rows[0].topic, 'PCT');
});

test('students: name, streak, accuracy and weakest topic per subject, never a phone', () => {
  const { db, student, addQ, serve } = setup();
  const a = student('9800000011', 'Asha');
  student('9800000012', 'Binod');
  const hcf = addQ('MATH', 'HCF', 'A');
  const pct = addQ('MATH', 'PCT', 'B');
  serve(a, pct, ['A'], 3);
  serve(a, pct, ['C'], 2);
  serve(a, hcf, ['A'], 1);
  serve(a, hcf, ['A'], 0);

  const rows = studentStats(db, 'MATH');
  assert.deepEqual(rows, [
    { id: a, name: 'Asha', tries: 4, pct: 50, streak: 2, weakest: 'PCT' },
    { id: 2, name: 'Binod', tries: 0, pct: null, streak: 0, weakest: null },
  ]);
  assert.doesNotMatch(JSON.stringify(rows), /98000000/);
  assert.deepEqual(studentStats(db, 'SCI').map((r) => r.tries), [0, 0]);
});
