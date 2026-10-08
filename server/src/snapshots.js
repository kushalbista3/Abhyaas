// Teacher decisions that must survive a reseed or demo:reset. The DB is
// gitignored, so approvals, edits and approved explanations are also written
// to committed JSON snapshots that seed() restores. Seed questions only:
// imported questions may be copyrighted and never go into git (CLAUDE.md rule 7).
//   reviews.json       { "seed:BIO-2": { "status": "approved", "solution": "..." } }
//                      (only the fields that differ from seed-data.js)
//   explanations.json  [{ "source_ref": "seed:PCT-1", "option": "A", "text": "...", "model": "teacher" }]
// Approved photo imports go to imported-questions.local.json instead
// (gitignored), so a reseed or demo:reset keeps them too.
import fs from 'node:fs';
import path from 'node:path';
import { SEED_QUESTIONS } from './seed-data.js';

export const REVIEWS_FILE = 'reviews.json';
export const EXPLANATIONS_FILE = 'explanations.json';

const FIELDS = ['subject', 'topic', 'stem', 'option_a', 'option_b', 'option_c', 'option_d', 'correct_option', 'solution', 'status'];

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`${file}: ${err.message}`);
  }
}

// Written via a temp file so a crash never leaves half a snapshot.
export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(`${file}.tmp`, file);
}

export function loadSnapshots(dir) {
  return {
    reviews: readJson(path.join(dir, REVIEWS_FILE), {}),
    explanations: readJson(path.join(dir, EXPLANATIONS_FILE), []),
  };
}

// Each seed question's DB row, as the fields that differ from seed-data.js.
export function reviewSnapshot(db) {
  const get = db.prepare("SELECT * FROM questions WHERE source = 'seed' AND source_ref = ?");
  const out = {};
  for (const seed of SEED_QUESTIONS) {
    const row = get.get(seed.source_ref);
    if (!row) continue;
    const diff = {};
    for (const f of FIELDS) if (row[f] !== seed[f]) diff[f] = row[f];
    const mis = JSON.parse(row.misconceptions);
    if (JSON.stringify(mis) !== JSON.stringify(seed.misconceptions)) diff.misconceptions = mis;
    if (Object.keys(diff).length) out[seed.source_ref] = diff;
  }
  return out;
}

export function explanationSnapshot(db) {
  return db
    .prepare(`SELECT q.source_ref, e.option, e.text, e.model FROM explanations e
      JOIN questions q ON q.id = e.question_id
      WHERE e.status = 'approved' AND q.source = 'seed'
      ORDER BY q.id, e.option, e.id`)
    .all();
}

export const writeReviewSnapshot = (db, dir) => writeJson(path.join(dir, REVIEWS_FILE), reviewSnapshot(db));
export const writeExplanationSnapshot = (db, dir) =>
  writeJson(path.join(dir, EXPLANATIONS_FILE), explanationSnapshot(db));

const IMPORT_FIELDS = ['topic', 'stem', 'option_a', 'option_b', 'option_c', 'option_d', 'correct_option', 'solution', 'source_ref'];

// Every approved photo import, in full (the file is gitignored).
export function writeImportsFile(db, file) {
  const rows = db.prepare("SELECT * FROM questions WHERE source = 'photo-import' ORDER BY id").all();
  writeJson(
    file,
    rows.map((r) => ({
      ...Object.fromEntries(IMPORT_FIELDS.map((f) => [f, r[f]])),
      misconceptions: JSON.parse(r.misconceptions),
      created_at: r.created_at,
    })),
  );
  return rows.length;
}

export const loadImports = (file) => readJson(file, []);
