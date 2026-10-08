import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { openDb } from './db.js';
import { SEED_QUESTIONS, DEMO_STUDENTS } from './seed-data.js';
import { loadImports, loadSnapshots } from './snapshots.js';
import { validateQuestion } from './validate-question.js';

// snapshots = loadSnapshots(dir): teacher approvals, edits and approved
// explanations from the committed JSON files. Without it, plain seed data.
// imports = loadImports(file): approved photo imports from the gitignored
// local file; each is re-validated, and a stem already in the DB is skipped.
export function seed(db, { reviews = {}, explanations = [], imports = [] } = {}) {
  const questionsIn = SEED_QUESTIONS.map((q) => ({ ...q, ...reviews[q.source_ref] }));
  const bad = questionsIn.map((q) => ({ q, r: validateQuestion(q) })).filter(({ r }) => !r.ok);
  if (bad.length) {
    for (const { q, r } of bad) console.error(`${q.source_ref}:\n  - ${r.errors.join('\n  - ')}`);
    throw new Error(`${bad.length} seed question(s) failed validation`);
  }

  const idOf = db.prepare("SELECT id FROM questions WHERE source = 'seed' AND source_ref = ?");
  const insertQ = db.prepare(`
    INSERT INTO questions (subject, topic, stem, option_a, option_b, option_c, option_d,
      correct_option, solution, misconceptions, source, source_ref, status)
    VALUES (@subject, @topic, @stem, @option_a, @option_b, @option_c, @option_d,
      @correct_option, @solution, @misconceptions, 'seed', @source_ref, @status)`);
  const insertS = db.prepare('INSERT OR IGNORE INTO students (phone, name, class) VALUES (@phone, @name, @class)');
  const hasExp = db.prepare("SELECT 1 FROM explanations WHERE question_id = ? AND option = ? AND text = ? AND status = 'approved'");
  const insertE = db.prepare("INSERT INTO explanations (question_id, option, text, status, model) VALUES (?, ?, ?, 'approved', ?)");
  const hasImport = db.prepare("SELECT 1 FROM questions WHERE source = 'photo-import' AND stem = ?");
  const insertImport = db.prepare(`
    INSERT INTO questions (subject, topic, stem, option_a, option_b, option_c, option_d,
      correct_option, solution, misconceptions, source, source_ref, status)
    VALUES ('MATH', @topic, @stem, @option_a, @option_b, @option_c, @option_d,
      @correct_option, @solution, @misconceptions, 'photo-import', @source_ref, 'approved')`);

  let questions = 0;
  let students = 0;
  let restored = 0;
  let imported = 0;
  db.transaction(() => {
    // Existing rows are skipped, so a re-seed never resets a teacher's approval or edit.
    for (const q of questionsIn) {
      if (idOf.get(q.source_ref)) continue;
      insertQ.run({ ...q, misconceptions: JSON.stringify(q.misconceptions) });
      questions++;
    }
    for (const s of DEMO_STUDENTS) students += insertS.run(s).changes;
    for (const e of explanations) {
      const id = idOf.get(e.source_ref)?.id;
      if (!id || hasExp.get(id, e.option, e.text)) continue;
      insertE.run(id, e.option, e.text, e.model);
      restored++;
    }
    for (const q of imports) {
      const { errors } = validateQuestion({ ...q, subject: 'MATH' });
      if (errors.length) {
        console.error(`Skipped imported question ${q.source_ref ?? ''}: ${errors.join('; ')}`);
        continue;
      }
      if (hasImport.get(q.stem)) continue;
      insertImport.run({ ...q, source_ref: q.source_ref ?? null, misconceptions: JSON.stringify(q.misconceptions) });
      imported++;
    }
  })();
  return { questions, students, explanations: restored, imported };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const db = openDb(config.dbPath);
    const { questions, students, explanations, imported } = seed(db, {
      ...loadSnapshots(config.snapshotDir),
      imports: loadImports(config.importsFile),
    });
    const total = db.prepare('SELECT COUNT(*) AS n FROM questions').get().n;
    console.log(
      `Seeded ${questions} new question(s), ${students} new student(s), ${explanations} explanation(s), ` +
        `${imported} imported question(s). Questions in DB: ${total}.`,
    );
    db.close();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
