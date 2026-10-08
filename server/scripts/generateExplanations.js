// Drafts a wrong-option explanation with the local model for every wrong
// option of an approved question that has no approved explanation yet.
// Drafts reach students only after `npm run explain:review -- approve <ids>`.
//   npm run explain:generate             (skips options that already have a draft)
//   npm run explain:generate -- --redo   (replaces existing drafts)
import { pathToFileURL } from 'node:url';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createLlm, parseJson } from '../src/llm/client.js';
import { LETTERS } from '../src/sms.js';
import { EXPLANATION_LIMIT, validateExplanation } from '../src/validate-explanation.js';

export const MAX_TRIES = 3;
const TIMEOUT_MS = 60_000;

const SCHEMA = {
  type: 'object',
  properties: { explanation: { type: 'string' } },
  required: ['explanation'],
};

const SYSTEM = [
  'You write short feedback SMS for Nepal SEE (Grade 10) students who chose a wrong option in a multiple-choice question.',
  `Speak to the student ("You ..."). In at most ${EXPLANATION_LIMIT} characters of plain English, explain the mistake behind the option they chose, using the misconception note.`,
  'Never say which option is correct. Never give the correct answer or its value. Never tell them which numbers to add, subtract, multiply or divide.',
  'Use only numbers and terms that appear in the question, options, solution or note.',
  'Plain ASCII only: no emoji, no Devanagari, no smart quotes.',
  'Reply only with JSON: {"explanation": "..."}',
].join(' ');

export function explanationPrompt(q, letter) {
  const mis = JSON.parse(q.misconceptions);
  const opt = (l) => q[`option_${l.toLowerCase()}`];
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: [
        `Question: ${q.stem}`,
        ...LETTERS.map((l) => `${l}) ${opt(l)}`),
        `Correct answer (for you only, never reveal it): ${q.correct_option}) ${opt(q.correct_option)}`,
        `Solution: ${q.solution}`,
        `The student chose: ${letter}) ${opt(letter)}`,
        `Misconception note: ${mis[letter]}`,
      ].join('\n'),
    },
  ];
}

// Wrong options of approved questions with no approved explanation (and,
// unless redo, no draft either).
function targets(db, { redo }) {
  const has = db.prepare('SELECT status FROM explanations WHERE question_id = ? AND option = ?');
  const out = [];
  for (const q of db.prepare("SELECT * FROM questions WHERE status = 'approved' ORDER BY id").all()) {
    for (const l of LETTERS) {
      if (l === q.correct_option) continue;
      const statuses = has.all(q.id, l).map((r) => r.status);
      if (statuses.includes('approved') || (!redo && statuses.includes('draft'))) continue;
      out.push({ q, letter: l });
    }
  }
  return out;
}

// One option: up to MAX_TRIES model calls, each retry told why the last failed.
async function draftFor(llm, q, letter) {
  const messages = explanationPrompt(q, letter);
  let errors = [];
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const raw = await llm.chat(messages, { format: SCHEMA, timeoutMs: TIMEOUT_MS, task: 'explain' });
    const text = String(parseJson(raw)?.explanation ?? '').trim();
    const r = raw === null ? { ok: false, errors: ['model did not reply'] } : validateExplanation(text, q, letter);
    if (r.ok) return { text, attempt, errors: [] };
    errors = r.errors;
    if (raw !== null) {
      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'user', content: `That failed these checks: ${errors.join('; ')}. Write a new one.` });
    }
  }
  return { text: null, attempt: MAX_TRIES, errors };
}

export async function generateExplanations(db, llm, { redo = false, log = console.log } = {}) {
  const insert = db.prepare("INSERT INTO explanations (question_id, option, text, status, model) VALUES (?, ?, ?, 'draft', 'gemma')");
  const dropDrafts = db.prepare("DELETE FROM explanations WHERE question_id = ? AND option = ? AND status = 'draft'");
  const result = { drafted: 0, failed: [] };
  for (const { q, letter } of targets(db, { redo })) {
    const { text, attempt, errors } = await draftFor(llm, q, letter);
    if (text) {
      db.transaction(() => {
        dropDrafts.run(q.id, letter);
        insert.run(q.id, letter, text);
      })();
      result.drafted++;
      log(`#${q.id}${letter} drafted (try ${attempt})`);
    } else {
      result.failed.push({ id: q.id, letter, errors });
      log(`#${q.id}${letter} FAILED after ${MAX_TRIES} tries: ${errors.join('; ')}`);
    }
  }
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = openDb(config.dbPath);
  try {
    const { drafted, failed } = await generateExplanations(db, createLlm(), { redo: process.argv.includes('--redo') });
    console.log(`${drafted} draft(s) saved, ${failed.length} failed. Review: npm run explain:review -- list`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}
