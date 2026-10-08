import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { openDb } from './db.js';
import { SEED_QUESTIONS, DEMO_STUDENTS } from './seed-data.js';
import { validateQuestion } from './validate-question.js';

export function seed(db) {
  const bad = SEED_QUESTIONS.map((q) => ({ q, r: validateQuestion(q) })).filter(({ r }) => !r.ok);
  if (bad.length) {
    for (const { q, r } of bad) console.error(`${q.source_ref}:\n  - ${r.errors.join('\n  - ')}`);
    throw new Error(`${bad.length} seed question(s) failed validation`);
  }

  const exists = db.prepare("SELECT 1 FROM questions WHERE source = 'seed' AND source_ref = ?");
  const insertQ = db.prepare(`
    INSERT INTO questions (subject, topic, stem, option_a, option_b, option_c, option_d,
      correct_option, solution, misconceptions, source, source_ref, status)
    VALUES (@subject, @topic, @stem, @option_a, @option_b, @option_c, @option_d,
      @correct_option, @solution, @misconceptions, 'seed', @source_ref, @status)`);
  const insertS = db.prepare('INSERT OR IGNORE INTO students (phone, name, class) VALUES (@phone, @name, @class)');

  let questions = 0;
  let students = 0;
  db.transaction(() => {
    // Existing rows are skipped, so a re-seed never resets a teacher's approval or edit.
    for (const q of SEED_QUESTIONS) {
      if (exists.get(q.source_ref)) continue;
      insertQ.run({ ...q, misconceptions: JSON.stringify(q.misconceptions) });
      questions++;
    }
    for (const s of DEMO_STUDENTS) students += insertS.run(s).changes;
  })();
  return { questions, students };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const db = openDb(config.dbPath);
    const { questions, students } = seed(db);
    const total = db.prepare('SELECT COUNT(*) AS n FROM questions').get().n;
    console.log(`Seeded ${questions} new question(s), ${students} new student(s). Questions in DB: ${total}.`);
    db.close();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
