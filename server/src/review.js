// Teacher review of the question bank (CLAUDE.md rule 8: science reaches
// students only after a teacher approves it).
//   npm run questions:review -- list [--all]
//   npm run questions:review -- approve 15 16,17
//   npm run questions:review -- edit 15 option_b="Slows down" misconception_c=
//   npm run questions:review -- edit 15            (opens the question in $EDITOR)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { openDb } from './db.js';
import { gsmLength } from './gsm7.js';
import { formatQuestionSms, LETTERS } from './sms.js';
import { validateQuestion } from './validate-question.js';

const EDITABLE = ['subject', 'topic', 'stem', 'option_a', 'option_b', 'option_c', 'option_d', 'correct_option', 'solution'];

const fromRow = (row) => ({ ...row, misconceptions: JSON.parse(row.misconceptions) });

export function listQuestions(db, { all = false } = {}) {
  const sql = all
    ? 'SELECT * FROM questions ORDER BY id'
    : "SELECT * FROM questions WHERE status = 'needs-review' ORDER BY id";
  return db.prepare(sql).all().map(fromRow);
}

export function countByStatus(db) {
  const counts = { 'needs-review': 0, approved: 0 };
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM questions GROUP BY status').all()) counts[r.status] = r.n;
  return counts;
}

// Re-validates each question before approving it. Returns per-id results.
export function approve(db, ids) {
  const get = db.prepare('SELECT * FROM questions WHERE id = ?');
  const set = db.prepare("UPDATE questions SET status = 'approved' WHERE id = ?");
  return ids.map((id) => {
    const row = get.get(id);
    if (!row) return { id, ok: false, errors: ['no such question'] };
    const { errors } = validateQuestion(fromRow(row));
    if (errors.length) return { id, ok: false, errors };
    set.run(id);
    return { id, ok: true, errors: [] };
  });
}

// "option_b=Slows down", "misconception_c=" -> { option_b: 'Slows down', misconceptions: { C: '' } }
export function parseAssignments(args) {
  const changes = {};
  for (const arg of args) {
    const eq = arg.indexOf('=');
    if (eq < 1) throw new Error(`expected field=value, got "${arg}"`);
    const field = arg.slice(0, eq).trim().toLowerCase();
    const value = arg.slice(eq + 1);
    const mis = field.match(/^misconception_([a-d])$/);
    if (mis) (changes.misconceptions ??= {})[mis[1].toUpperCase()] = value;
    else if (EDITABLE.includes(field)) changes[field] = value;
    else throw new Error(`can't edit "${field}". Fields: ${EDITABLE.join(', ')}, misconception_a..d`);
  }
  return changes;
}

// Merges changes, validates, and saves only if valid. A saved edit goes back
// to needs-review so it is approved as a whole.
export function editQuestion(db, id, changes) {
  const row = db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
  if (!row) return { ok: false, errors: ['no such question'] };
  const current = fromRow(row);
  const q = { ...current };
  for (const f of EDITABLE) if (f in changes) q[f] = String(changes[f]).trim();
  if (changes.misconceptions) {
    const mis = { ...current.misconceptions };
    for (const [l, note] of Object.entries(changes.misconceptions)) {
      if (String(note ?? '').trim()) mis[l] = String(note).trim();
      else delete mis[l];
    }
    q.misconceptions = mis;
  }
  const { errors } = validateQuestion(q);
  if (errors.length) return { ok: false, errors };
  db.prepare(`
    UPDATE questions SET subject = @subject, topic = @topic, stem = @stem,
      option_a = @option_a, option_b = @option_b, option_c = @option_c, option_d = @option_d,
      correct_option = @correct_option, solution = @solution, misconceptions = @misconceptions,
      status = 'needs-review'
    WHERE id = @id`).run({ ...q, misconceptions: JSON.stringify(q.misconceptions) });
  return { ok: true, errors: [] };
}

function editInEditor(db, id) {
  const row = db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
  if (!row) return { ok: false, errors: ['no such question'] };
  const q = fromRow(row);
  const draft = Object.fromEntries([...EDITABLE, 'misconceptions'].map((f) => [f, q[f]]));
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'abhyaas-')), `question-${id}.json`);
  fs.writeFileSync(file, JSON.stringify(draft, null, 2) + '\n');
  try {
    const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
    // Through a shell so EDITOR may carry flags, e.g. "code --wait".
    const r = spawnSync(`${editor} "${file}"`, { stdio: 'inherit', shell: true });
    if (r.status !== 0) return { ok: false, errors: [`editor exited with ${r.status}`] };
    let changes;
    try {
      changes = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      return { ok: false, errors: [`not valid JSON: ${err.message}`] };
    }
    // Replace the notes as a whole: drop letters the teacher removed.
    const mis = changes.misconceptions ?? {};
    for (const l of LETTERS) if (!(l in mis)) mis[l] = '';
    return editQuestion(db, id, { ...changes, misconceptions: mis });
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

export function describe(q) {
  const sms = formatQuestionSms(q);
  const notes = LETTERS.filter((l) => q.misconceptions[l]).map((l) => `    ${l}: ${q.misconceptions[l]}`);
  return [
    `#${q.id}  ${q.subject} ${q.topic}  [${q.status}]  ${q.source_ref ?? q.source}`,
    `  SMS (${gsmLength(sms)}/160):`,
    ...sms.split('\n').map((line) => `    | ${line}`),
    `  Correct: ${q.correct_option}`,
    `  Solution: ${q.solution}`,
    '  Wrong-option notes:',
    ...notes,
  ].join('\n');
}

const parseIds = (args) => args.flatMap((a) => a.split(',')).map((s) => s.trim()).filter(Boolean);

function main(argv) {
  const [cmd, ...args] = argv;
  const db = openDb(config.dbPath);
  try {
    if (cmd === 'list') {
      const all = args.includes('--all');
      const qs = listQuestions(db, { all });
      if (qs.length) console.log(qs.map(describe).join('\n\n') + '\n');
      else if (!all) console.log('Nothing needs review.\n');
      const c = countByStatus(db);
      console.log(`${c['needs-review']} need review, ${c.approved} approved.`);
      return 0;
    }
    if (cmd === 'approve') {
      const ids = parseIds(args);
      if (!ids.length) throw new Error('usage: approve <id> [id ...]');
      let failed = 0;
      for (const r of approve(db, ids.map(Number))) {
        if (r.ok) console.log(`#${r.id} approved`);
        else {
          failed++;
          console.error(`#${r.id} NOT approved:\n  - ${r.errors.join('\n  - ')}`);
        }
      }
      return failed ? 1 : 0;
    }
    if (cmd === 'edit') {
      const [idArg, ...assignments] = args;
      const id = Number(idArg);
      if (!Number.isInteger(id)) throw new Error('usage: edit <id> [field=value ...]');
      const r = assignments.length ? editQuestion(db, id, parseAssignments(assignments)) : editInEditor(db, id);
      if (!r.ok) {
        console.error(`#${id} not saved:\n  - ${r.errors.join('\n  - ')}`);
        return 1;
      }
      const q = fromRow(db.prepare('SELECT * FROM questions WHERE id = ?').get(id));
      console.log(`${describe(q)}\n\nSaved. #${id} needs review again: run approve ${id} when it is right.`);
      return 0;
    }
    console.error('usage: npm run questions:review -- list [--all] | approve <ids> | edit <id> [field=value ...]');
    return 1;
  } finally {
    db.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
