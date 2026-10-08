// Teacher review of wrong-option explanations. Only approved ones reach
// students; every change rewrites server/data/explanations.json so a reseed
// keeps them.
//   npm run explain:review -- list
//   npm run explain:review -- approve 3 4,5
//   npm run explain:review -- reject 6
//   npm run explain:review -- edit 7 "You found the LCM, not the HCF."
//   npm run explain:review -- edit 11B "You added the groups but forgot the overlap."
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { openDb } from './db.js';
import { gsmLength } from './gsm7.js';
import { writeExplanationSnapshot } from './snapshots.js';
import { formatQuestionSms } from './sms.js';
import { EXPLANATION_LIMIT, validateExplanation, wrongReply } from './validate-explanation.js';

const questionOf = (db, id) => db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
const optionText = (q, l) => q[`option_${l.toLowerCase()}`];

// Drafts grouped by question: [{ question, drafts: [{ id, option, text, check }] }]
export function listDrafts(db) {
  const rows = db.prepare("SELECT * FROM explanations WHERE status = 'draft' ORDER BY question_id, option, id").all();
  const groups = new Map();
  for (const e of rows) {
    if (!groups.has(e.question_id)) groups.set(e.question_id, { question: questionOf(db, e.question_id), drafts: [] });
    const { question } = groups.get(e.question_id);
    groups.get(e.question_id).drafts.push({ ...e, check: validateExplanation(e.text, question, e.option) });
  }
  return [...groups.values()];
}

export function describeGroup({ question: q, drafts }) {
  const lines = [`#${q.id} ${q.subject} ${q.topic}  correct ${q.correct_option}`];
  for (const line of formatQuestionSms(q).split('\n')) lines.push(`    | ${line}`);
  for (const d of drafts) {
    const full = gsmLength(wrongReply(d.text));
    const verdict = d.check.ok ? 'OK' : `FAIL: ${d.check.errors.join('; ')}`;
    lines.push(`  [${d.id}] ${d.option}) ${optionText(q, d.option)}`);
    lines.push(`      "${d.text}"`);
    lines.push(`      ${d.check.length ?? '?'}/${EXPLANATION_LIMIT}, SMS ${full ?? '?'}/160, ${verdict}`);
    if (d.check.warnings.length) lines.push(`      warning: ${d.check.warnings.join('; ')}`);
  }
  return lines.join('\n');
}

// The approved one replaces every other explanation for that question option.
function makeOnlyApproved(db, id, questionId, option) {
  db.prepare('DELETE FROM explanations WHERE question_id = ? AND option = ? AND id <> ?').run(questionId, option, id);
  db.prepare("UPDATE explanations SET status = 'approved' WHERE id = ?").run(id);
}

// Drafts must pass every check (same as when generated).
export function approveExplanations(db, ids) {
  const get = db.prepare('SELECT * FROM explanations WHERE id = ?');
  return ids.map((id) => {
    const e = get.get(id);
    if (!e) return { id, ok: false, errors: ['no such explanation'] };
    if (e.status !== 'draft') return { id, ok: false, errors: ['already approved'] };
    const { errors } = validateExplanation(e.text, questionOf(db, e.question_id), e.option);
    if (errors.length) return { id, ok: false, errors };
    db.transaction(() => makeOnlyApproved(db, id, e.question_id, e.option))();
    return { id, ok: true, errors: [] };
  });
}

export function rejectExplanations(db, ids) {
  const del = db.prepare("DELETE FROM explanations WHERE id = ? AND status = 'draft'");
  return ids.map((id) => (del.run(id).changes ? { id, ok: true, errors: [] } : { id, ok: false, errors: ['no such draft'] }));
}

// ref: an explanation id ("7") or question id + option ("11B").
export function resolveRef(db, ref) {
  const s = String(ref).trim();
  const qo = s.match(/^(\d+)([A-Da-d])$/);
  if (qo) return { questionId: Number(qo[1]), option: qo[2].toUpperCase() };
  if (/^\d+$/.test(s)) {
    const e = db.prepare('SELECT question_id, option FROM explanations WHERE id = ?').get(Number(s));
    return e ? { questionId: e.question_id, option: e.option } : null;
  }
  return null;
}

// A teacher's text, saved as approved (model 'teacher'). The maths number
// check only warns; every other check must pass.
export function editExplanation(db, ref, text) {
  const target = resolveRef(db, ref);
  if (!target) return { ok: false, errors: [`no explanation or question option "${ref}"`], warnings: [] };
  const q = questionOf(db, target.questionId);
  if (!q) return { ok: false, errors: ['no such question'], warnings: [] };
  const t = String(text ?? '').trim();
  const { errors, warnings } = validateExplanation(t, q, target.option, { mode: 'teacher' });
  if (errors.length) return { ok: false, errors, warnings };
  const id = db.transaction(() => {
    const newId = Number(
      db.prepare("INSERT INTO explanations (question_id, option, text, status, model) VALUES (?, ?, ?, 'draft', 'teacher')")
        .run(q.id, target.option, t).lastInsertRowid,
    );
    makeOnlyApproved(db, newId, q.id, target.option);
    return newId;
  })();
  return { ok: true, errors: [], warnings, id, questionId: q.id, option: target.option };
}

const parseIds = (args) => args.flatMap((a) => a.split(',')).map((s) => s.trim()).filter(Boolean).map(Number);

function report(results, verb) {
  let failed = 0;
  for (const r of results) {
    if (r.ok) console.log(`[${r.id}] ${verb}`);
    else {
      failed++;
      console.error(`[${r.id}] NOT ${verb}:\n  - ${r.errors.join('\n  - ')}`);
    }
  }
  return failed ? 1 : 0;
}

function main(argv) {
  const [cmd, ...args] = argv;
  const db = openDb(config.dbPath);
  try {
    if (cmd === 'list') {
      const groups = listDrafts(db);
      if (groups.length) console.log(groups.map(describeGroup).join('\n\n') + '\n');
      const n = (status) => db.prepare('SELECT COUNT(*) AS n FROM explanations WHERE status = ?').get(status).n;
      console.log(`${n('draft')} draft(s), ${n('approved')} approved.`);
      return 0;
    }
    if (cmd === 'approve' || cmd === 'reject') {
      const ids = parseIds(args);
      if (!ids.length) throw new Error(`usage: ${cmd} <id> [id ...]`);
      const code = cmd === 'approve' ? report(approveExplanations(db, ids), 'approved') : report(rejectExplanations(db, ids), 'rejected');
      writeExplanationSnapshot(db, config.snapshotDir);
      return code;
    }
    if (cmd === 'edit') {
      const [ref, ...words] = args;
      if (!ref || !words.length) throw new Error('usage: edit <id or e.g. 11B> "<text>"');
      const r = editExplanation(db, ref, words.join(' '));
      for (const w of r.warnings) console.warn(`warning: ${w}`);
      if (!r.ok) {
        console.error(`${ref} not saved:\n  - ${r.errors.join('\n  - ')}`);
        return 1;
      }
      writeExplanationSnapshot(db, config.snapshotDir);
      console.log(`[${r.id}] #${r.questionId}${r.option} saved as approved (teacher).`);
      return 0;
    }
    console.error('usage: npm run explain:review -- list | approve <ids> | reject <ids> | edit <id|11B> "<text>"');
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
