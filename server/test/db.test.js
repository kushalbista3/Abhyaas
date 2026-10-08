import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { seed } from '../src/seed.js';

const TABLES = ['students', 'questions', 'explanations', 'attempts', 'sessions', 'messages', 'outbox', 'doubts'];

test('schema creates all tables', () => {
  const db = openDb(':memory:');
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const t of TABLES) assert.ok(names.includes(t), t);
});

test('students table holds only phone, name, class (plus id, created_at)', () => {
  const db = openDb(':memory:');
  const cols = db.prepare('PRAGMA table_info(students)').all().map((c) => c.name).sort();
  assert.deepEqual(cols, ['class', 'created_at', 'id', 'name', 'phone']);
});

test('CHECK constraints reject bad enum values', () => {
  const db = openDb(':memory:');
  assert.throws(() => db.prepare("INSERT INTO outbox (phone, body, status) VALUES ('1', 'x', 'pending')").run());
  db.prepare("INSERT INTO students (phone, name, class) VALUES ('1', 'A', '10')").run();
  assert.throws(() => db.prepare("INSERT INTO doubts (student_id, text, status) VALUES (1, 'x', 'closed')").run());
  assert.throws(() =>
    db.prepare(`INSERT INTO questions (topic, stem, option_a, option_b, option_c, option_d, correct_option,
      solution, misconceptions, source) VALUES ('TRIG','s','a','b','c','d','A','s','{}','seed')`).run(),
  );
});

test('seed is idempotent', () => {
  const db = openDb(':memory:');
  assert.deepEqual(seed(db), { questions: 14, students: 3 });
  assert.deepEqual(seed(db), { questions: 0, students: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM questions').get().n, 14);
});
