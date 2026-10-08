import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { seed } from '../src/seed.js';
import {
  approveExplanations,
  describeGroup,
  editExplanation,
  listDrafts,
  rejectExplanations,
} from '../src/explain-review.js';
import { MAX_TRIES, generateExplanations } from '../scripts/generateExplanations.js';
import { loadSnapshots } from '../src/snapshots.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const idOf = (db, ref) => db.prepare('SELECT id FROM questions WHERE source_ref = ?').get(ref).id;
const rows = (db) => db.prepare('SELECT id, question_id, option, text, status, model FROM explanations ORDER BY id').all();

function seeded() {
  const db = openDb(':memory:');
  seed(db);
  return db;
}

// A fake model whose reply depends on the prompt: fn(userPrompt, callNumber) -> string|null.
function fakeLlm(fn) {
  const calls = [];
  return {
    calls,
    async chat(messages) {
      calls.push(messages);
      return fn(messages.map((m) => m.content).join('\n'), calls.length);
    },
  };
}
const explain = (text) => JSON.stringify({ explanation: text });
const quiet = { log: () => {} };

test('generator: drafts every wrong option of approved questions only', async () => {
  const db = seeded(); // 14 approved maths, science still needs review
  const llm = fakeLlm(() => explain('You mixed up the steps. Check your working again.'));
  const r = await generateExplanations(db, llm, quiet);
  assert.equal(r.drafted, 14 * 3);
  assert.deepEqual(r.failed, []);
  const all = rows(db);
  assert.ok(all.every((e) => e.status === 'draft' && e.model === 'gemma'));
  const sci = db.prepare("SELECT id FROM questions WHERE subject = 'SCI'").all().map((q) => q.id);
  assert.ok(all.every((e) => !sci.includes(e.question_id)), 'needs-review questions are skipped');
  for (const e of all) {
    const q = db.prepare('SELECT correct_option FROM questions WHERE id = ?').get(e.question_id);
    assert.notEqual(e.option, q.correct_option);
  }
  // The prompt carries the question, solution and that option's misconception note.
  const prompt = llm.calls.map((m) => m.map((x) => x.content).join('\n')).find((p) => p.includes('The student chose: C) Rs 1800'));
  assert.match(prompt, /Marked price Rs 2000/);
  assert.match(prompt, /Solution: After discount/);
  assert.match(prompt, /Misconception note: Gave the price after discount and forgot to add VAT\./);

  // A second run skips options with drafts; --redo replaces them.
  assert.equal((await generateExplanations(db, llm, quiet)).drafted, 0);
  assert.equal((await generateExplanations(db, llm, { ...quiet, redo: true })).drafted, 42);
  assert.equal(rows(db).length, 42);
});

test('generator: retries with the errors, up to 3 tries, and logs failures', async () => {
  const db = seeded();
  db.prepare("UPDATE questions SET status = 'needs-review' WHERE source_ref <> 'seed:PCT-1'").run();
  // Option A: leaks the answer, then passes. C: fails every time. D: model down.
  const llm = fakeLlm((prompt) => {
    if (prompt.includes('chose: A)')) {
      return prompt.includes('failed these checks') ? explain('You took 13% less 10% as one rate on the marked price.') : explain('It is Rs 2034.');
    }
    if (prompt.includes('chose: C)')) return explain('Option B is right.');
    return null;
  });
  const logs = [];
  const r = await generateExplanations(db, llm, { log: (m) => logs.push(m) });
  assert.equal(r.drafted, 1);
  assert.deepEqual(r.failed.map((f) => f.letter), ['C', 'D']);
  assert.match(r.failed[0].errors.join(), /correct letter B/);
  assert.match(r.failed[1].errors.join(), /model did not reply/);
  const retried = llm.calls.find((m) => m.some((x) => x.content.includes('failed these checks')));
  assert.match(retried.at(-1).content, /gives the correct answer "Rs 2034"/, 'the errors go back to the model');
  assert.equal(llm.calls.filter((m) => m.some((x) => x.content.includes('chose: C)'))).length, MAX_TRIES);
  assert.ok(logs.some((m) => /#\d+C FAILED after 3 tries/.test(m)));
  assert.deepEqual(rows(db).map((e) => [e.option, e.text]), [['A', 'You took 13% less 10% as one rate on the marked price.']]);
});

test('list groups drafts by question with lengths and validator results', () => {
  const db = seeded();
  const pct = idOf(db, 'seed:PCT-1');
  const add = db.prepare("INSERT INTO explanations (question_id, option, text, status, model) VALUES (?, ?, ?, 'draft', 'gemma')");
  add.run(pct, 'C', 'You stopped after the discount. VAT is added after it.');
  add.run(pct, 'A', 'Option B is right.');
  const groups = listDrafts(db);
  assert.equal(groups.length, 1);
  const text = describeGroup(groups[0]);
  assert.match(text, /^#\d+ MATH PCT {2}correct B/);
  assert.match(text, /\| Marked price Rs 2000/);
  assert.match(text, /A\) Rs 2060\n {6}"Option B is right\."\n {6}18\/120, SMS 54\/160, FAIL: mentions the correct letter B/);
  assert.match(text, /C\) Rs 1800\n {6}"You stopped.*"\n {6}\d+\/120, SMS \d+\/160, OK/);
});

test('approve (checks must pass), reject, and edit by id or 11B', () => {
  const db = seeded();
  const pct = idOf(db, 'seed:PCT-1');
  const add = (option, text) =>
    Number(db.prepare("INSERT INTO explanations (question_id, option, text, status, model) VALUES (?, ?, ?, 'draft', 'gemma')")
      .run(pct, option, text).lastInsertRowid);
  const good = add('C', 'You stopped after the discount. VAT is added after it.');
  const leaky = add('A', 'Option B is right.');
  const meh = add('D', 'You forgot something.');

  const res = approveExplanations(db, [good, leaky, 999]);
  assert.deepEqual(res.map((r) => r.ok), [true, false, false]);
  assert.match(res[1].errors.join(), /correct letter/);
  assert.deepEqual(rejectExplanations(db, [meh, good]).map((r) => r.ok), [true, false], 'approved ones are not drafts');

  // Edit by explanation id: teacher text replaces the draft, approved.
  const e1 = editExplanation(db, String(leaky), 'You took 13%-10%=3% as one rate on the marked price.');
  assert.equal(e1.ok, true);
  // Edit by question+option; the number check only warns for a teacher.
  const e2 = editExplanation(db, `${pct}d`, 'You added VAT, but 15% off came first.');
  assert.equal(e2.ok, true);
  assert.match(e2.warnings.join(), /15/);
  assert.equal(editExplanation(db, `${pct}C`, 'It is Rs 2034.').ok, false, 'other checks must pass');
  assert.equal(editExplanation(db, 'nope', 'x').ok, false);

  assert.deepEqual(
    rows(db).map((e) => [e.option, e.status, e.model]),
    [['C', 'approved', 'gemma'], ['A', 'approved', 'teacher'], ['D', 'approved', 'teacher']],
  );
});

test('CLI: approved explanations go to explanations.json and survive demo:reset', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abhyaas-explain-'));
  const env = { ...process.env, DB_PATH: path.join(dir, 'test.db'), SNAPSHOT_DIR: dir };
  const run = (script, ...args) => execFileSync(process.execPath, [path.join(SRC, script), ...args], { env, encoding: 'utf8' });
  try {
    run('seed.js');
    const db = new Database(env.DB_PATH);
    const pct = idOf(db, 'seed:PCT-1');
    const draft = db.prepare("INSERT INTO explanations (question_id, option, text, status, model) VALUES (?, 'C', ?, 'draft', 'gemma')")
      .run(pct, 'You stopped after the discount. VAT is added after it.').lastInsertRowid;
    db.close();

    run('explain-review.js', 'approve', String(draft));
    run('explain-review.js', 'edit', `${pct}A`, 'You used one net rate on the marked price.');
    assert.match(run('explain-review.js', 'list'), /0 draft\(s\), 2 approved\./);
    assert.deepEqual(loadSnapshots(dir).explanations.map((e) => [e.source_ref, e.option, e.model]), [
      ['seed:PCT-1', 'A', 'teacher'],
      ['seed:PCT-1', 'C', 'gemma'],
    ]);

    run('demo-reset.js');
    const after = new Database(env.DB_PATH, { readonly: true });
    assert.deepEqual(
      after.prepare("SELECT option, status FROM explanations WHERE question_id = ? ORDER BY option").all(pct),
      [{ option: 'A', status: 'approved' }, { option: 'C', status: 'approved' }],
    );
    after.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
