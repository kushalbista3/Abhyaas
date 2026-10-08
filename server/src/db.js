import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// Shared by SCHEMA and the migration that rebuilds an older questions table.
const QUESTIONS_COLUMNS = `
  id              INTEGER PRIMARY KEY,
  subject         TEXT NOT NULL CHECK (subject IN ('MATH','SCI')),
  topic           TEXT NOT NULL,
  stem            TEXT NOT NULL,
  option_a        TEXT NOT NULL,
  option_b        TEXT NOT NULL,
  option_c        TEXT NOT NULL,
  option_d        TEXT NOT NULL,
  correct_option  TEXT NOT NULL CHECK (correct_option IN ('A','B','C','D')),
  solution        TEXT NOT NULL,
  misconceptions  TEXT NOT NULL CHECK (json_valid(misconceptions)),
  source          TEXT NOT NULL CHECK (source IN ('seed','photo-import')),
  source_ref      TEXT,
  status          TEXT NOT NULL DEFAULT 'needs-review' CHECK (status IN ('needs-review','approved')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((subject = 'MATH' AND topic IN ('HCF','PCT','INT','ALG','GEO','SET','PROB'))
      OR (subject = 'SCI' AND topic IN ('PHY','CHEM','BIO','EARTH')))
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS students (
  id          INTEGER PRIMARY KEY,
  phone       TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  class       TEXT NOT NULL,
  current_subject TEXT NOT NULL DEFAULT 'MATH' CHECK (current_subject IN ('MATH','SCI')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS questions (${QUESTIONS_COLUMNS});

CREATE TABLE IF NOT EXISTS explanations (
  id           INTEGER PRIMARY KEY,
  question_id  INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  option       TEXT NOT NULL CHECK (option IN ('A','B','C','D')),
  text         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved')),
  model        TEXT NOT NULL CHECK (model IN ('gemma','teacher')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id                   INTEGER PRIMARY KEY,
  student_id           INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  topic                TEXT,
  current_question_id  INTEGER REFERENCES questions(id),
  state                TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','ended')),
  started_at           TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at             TEXT
);

CREATE TABLE IF NOT EXISTS attempts (
  id             INTEGER PRIMARY KEY,
  student_id     INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  question_id    INTEGER NOT NULL REFERENCES questions(id),
  session_id     INTEGER REFERENCES sessions(id),
  chosen_option  TEXT NOT NULL CHECK (chosen_option IN ('A','B','C','D')),
  is_correct     INTEGER NOT NULL CHECK (is_correct IN (0,1)),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY,
  student_id  INTEGER REFERENCES students(id) ON DELETE SET NULL,
  phone       TEXT NOT NULL,
  direction   TEXT NOT NULL CHECK (direction IN ('in','out')),
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS outbox (
  id          INTEGER PRIMARY KEY,
  phone       TEXT NOT NULL,
  body        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at     TEXT
);

CREATE TABLE IF NOT EXISTS doubts (
  id          INTEGER PRIMARY KEY,
  student_id  INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject     TEXT NOT NULL DEFAULT 'MATH' CHECK (subject IN ('MATH','SCI')),
  text        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered')),
  reply       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_attempts_student ON attempts(student_id);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status);
CREATE INDEX IF NOT EXISTS idx_doubts_status ON doubts(status);
CREATE INDEX IF NOT EXISTS idx_questions_subject ON questions(subject, status);
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  db.exec(SCHEMA);
  return db;
}

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

// Brings a DB made before science existed up to the current schema, in place.
function migrate(db) {
  const qCols = columns(db, 'questions');
  if (qCols.length && !qCols.includes('subject')) {
    // SQLite can't change a CHECK, so rebuild the table. Every old question is
    // maths; the original seed questions are reviewed, anything else is not.
    const keep = qCols.join(', ');
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      db.exec(`CREATE TABLE questions_new (${QUESTIONS_COLUMNS})`);
      db.exec(`INSERT INTO questions_new (${keep}, subject, status)
        SELECT ${keep}, 'MATH', CASE source WHEN 'seed' THEN 'approved' ELSE 'needs-review' END FROM questions`);
      db.exec('DROP TABLE questions');
      db.exec('ALTER TABLE questions_new RENAME TO questions');
    })();
    db.pragma('foreign_keys = ON');
  }
  const sCols = columns(db, 'students');
  if (sCols.length && !sCols.includes('current_subject')) {
    db.exec("ALTER TABLE students ADD COLUMN current_subject TEXT NOT NULL DEFAULT 'MATH' CHECK (current_subject IN ('MATH','SCI'))");
  }
  const dCols = columns(db, 'doubts');
  if (dCols.length && !dCols.includes('subject')) {
    db.exec("ALTER TABLE doubts ADD COLUMN subject TEXT NOT NULL DEFAULT 'MATH' CHECK (subject IN ('MATH','SCI'))");
  }
}
