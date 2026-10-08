import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { seed } from '../src/seed.js';

const TABLES = ['students', 'questions', 'explanations', 'attempts', 'sessions', 'messages', 'outbox', 'doubts'];

test('schema creates all tables', () => {
  const db = openDb(':memory:');
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const t of TABLES) assert.ok(names.includes(t), t);
});

test('students table holds only phone, name, class (plus id, created_at, current_subject)', () => {
  const db = openDb(':memory:');
  const cols = db.prepare('PRAGMA table_info(students)').all().map((c) => c.name).sort();
  assert.deepEqual(cols, ['class', 'created_at', 'current_subject', 'id', 'name', 'phone']);
  db.prepare("INSERT INTO students (phone, name, class) VALUES ('1', 'A', '10')").run();
  assert.equal(db.prepare('SELECT current_subject FROM students').get().current_subject, 'MATH');
});

test('CHECK constraints reject bad enum values', () => {
  const db = openDb(':memory:');
  assert.throws(() => db.prepare("INSERT INTO outbox (phone, body, status) VALUES ('1', 'x', 'pending')").run());
  db.prepare("INSERT INTO students (phone, name, class) VALUES ('1', 'A', '10')").run();
  assert.throws(() => db.prepare("INSERT INTO doubts (student_id, text, status) VALUES (1, 'x', 'closed')").run());
  assert.throws(() => db.prepare("INSERT INTO doubts (student_id, text, subject) VALUES (1, 'x', 'ENG')").run());
  assert.throws(() => db.prepare("UPDATE students SET current_subject = 'ENG'").run());
  const insertQ = (subject, topic, status = 'needs-review') =>
    db.prepare(`INSERT INTO questions (subject, topic, stem, option_a, option_b, option_c, option_d, correct_option,
      solution, misconceptions, source, status) VALUES (?, ?,'s','a','b','c','d','A','s','{}','seed', ?)`).run(subject, topic, status);
  assert.throws(() => insertQ('MATH', 'TRIG'));
  assert.throws(() => insertQ('ENG', 'HCF'));
  assert.throws(() => insertQ('MATH', 'PHY'), 'science topic under maths');
  assert.throws(() => insertQ('SCI', 'HCF'), 'maths topic under science');
  assert.throws(() => insertQ('SCI', 'PHY', 'pending'));
  insertQ('SCI', 'PHY');
  insertQ('MATH', 'HCF', 'approved');
});

test('seed is idempotent', () => {
  const db = openDb(':memory:');
  assert.deepEqual(seed(db), { questions: 22, students: 3 });
  assert.deepEqual(seed(db), { questions: 0, students: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM questions').get().n, 22);
});

test('seed: maths approved, science needs review; re-seed keeps an approval', () => {
  const db = openDb(':memory:');
  seed(db);
  const rows = db.prepare('SELECT subject, status, COUNT(*) AS n FROM questions GROUP BY subject, status').all();
  assert.deepEqual(rows, [
    { subject: 'MATH', status: 'approved', n: 14 },
    { subject: 'SCI', status: 'needs-review', n: 8 },
  ]);
  db.prepare("UPDATE questions SET status = 'approved' WHERE source_ref = 'seed:PHY-1'").run();
  seed(db);
  assert.equal(db.prepare("SELECT status FROM questions WHERE source_ref = 'seed:PHY-1'").get().status, 'approved');
});

test('openDb migrates a DB made before science existed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abhyaas-test-'));
  const file = path.join(dir, 'old.db');
  try {
    const old = new Database(file);
    old.exec(`
      CREATE TABLE students (id INTEGER PRIMARY KEY, phone TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        class TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE questions (id INTEGER PRIMARY KEY,
        topic TEXT NOT NULL CHECK (topic IN ('HCF','PCT','INT','ALG','GEO','SET','PROB')),
        stem TEXT NOT NULL, option_a TEXT NOT NULL, option_b TEXT NOT NULL, option_c TEXT NOT NULL,
        option_d TEXT NOT NULL, correct_option TEXT NOT NULL, solution TEXT NOT NULL,
        misconceptions TEXT NOT NULL, source TEXT NOT NULL, source_ref TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE attempts (id INTEGER PRIMARY KEY,
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        question_id INTEGER NOT NULL REFERENCES questions(id), chosen_option TEXT NOT NULL,
        is_correct INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE doubts (id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES students(id),
        text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', reply TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO students (phone, name, class) VALUES ('9800000001', 'A', '10');
      INSERT INTO questions (topic, stem, option_a, option_b, option_c, option_d, correct_option, solution,
        misconceptions, source, source_ref) VALUES
        ('HCF','s','a','b','c','d','A','s','{}','seed','seed:HCF-1'),
        ('ALG','t','a','b','c','d','B','s','{}','photo-import','book p1');
      INSERT INTO attempts (student_id, question_id, chosen_option, is_correct) VALUES (1, 1, 'A', 1);
      INSERT INTO doubts (student_id, text) VALUES (1, 'why?');
    `);
    old.close();

    const db = openDb(file);
    assert.deepEqual(
      db.prepare('SELECT id, subject, status FROM questions ORDER BY id').all(),
      [{ id: 1, subject: 'MATH', status: 'approved' }, { id: 2, subject: 'MATH', status: 'needs-review' }],
    );
    assert.equal(db.prepare('SELECT current_subject FROM students').get().current_subject, 'MATH');
    assert.equal(db.prepare('SELECT subject FROM doubts').get().subject, 'MATH');
    assert.equal(db.prepare('SELECT question_id FROM attempts').get().question_id, 1);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    assert.equal(seed(db).questions, 21, 'HCF-1 already there; the rest are new');
    db.close();
    // A second open is a no-op.
    openDb(file).close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
