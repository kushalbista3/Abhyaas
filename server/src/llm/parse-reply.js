// Free-text reply to a pending question -> A-D, or null. Code first:
//   1. matchLetter: "b", "B)", "b ho", "mero answer c"
//   2. matchValue: the typed value equals exactly one option ("2034", "Rs 2,034", "slows down")
//   3. modelLetter: the local model maps anything else to A-D or UNKNOWN (null)
// This only finds which option the student meant. Grading stays in code
// (CLAUDE.md rule 2): the letter goes to the same answer() as a plain "B".
import { LETTERS } from '../sms.js';
import { sameText, sameValue } from '../validate-question.js';
import { parseJson } from './client.js';

// Romanised Nepali and English words that may follow the letter.
const FILLER = '(?:ho|hola|hunchha|huncha|hunxa|ki|hai|ni|la|sir|miss|maam|madam|please|pls|i think|hoina ra)';
const LETTER_ALONE = new RegExp(`^\\(?([a-d])\\)?[.):]?(?:\\s+${FILLER})*$`);
const KEYWORD = '(?:mero\\s+)?(?:answer|ans|uttar|option|opt|choice)\\b';
const LETTER_AFTER_KEYWORD = new RegExp(
  `(?:^|\\s)${KEYWORD}\\s*(?:is|ho|[:=-])?\\s*\\(?([a-d])\\)?[.)]?(?:\\s+${FILLER})*$`,
);

const tidy = (text) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[!?.,]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();

export function matchLetter(text) {
  const s = tidy(text);
  const m = s.match(LETTER_ALONE) ?? s.match(LETTER_AFTER_KEYWORD);
  return m ? m[1].toUpperCase() : null;
}

// "mero answer Rs 2034 ho" -> "rs 2034"
const LEADING = new RegExp(`^(?:i think\\s+|${KEYWORD}\\s*(?:is|ho|[:=-])?\\s*)`);
const TRAILING = new RegExp(`(?:\\s+${FILLER})+$`);

export function matchValue(text, question) {
  const s = tidy(text).replace(LEADING, '').replace(TRAILING, '').trim();
  if (!s) return null;
  const same = question.subject === 'MATH' ? sameValue : sameText;
  const hits = LETTERS.filter((l) => same(s, question[`option_${l.toLowerCase()}`]));
  return hits.length === 1 ? hits[0] : null;
}

export const localLetter = (text, question) => matchLetter(text) ?? matchValue(text, question);

const ANSWER_SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string', enum: [...LETTERS, 'UNKNOWN'] } },
  required: ['answer'],
};

const SYSTEM = [
  'A student got a multiple-choice question by SMS and replied in free text (English or Romanized Nepali).',
  'Decide which option the student chose. Do not judge whether it is correct.',
  'If the reply does not clearly pick exactly one option, answer UNKNOWN.',
  'Reply only with JSON: {"answer": "A"|"B"|"C"|"D"|"UNKNOWN"}.',
].join(' ');

export function letterPrompt(question, text) {
  const options = LETTERS.map((l) => `${l}) ${question[`option_${l.toLowerCase()}`]}`).join('\n');
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Question: ${question.stem}\n${options}\n\nStudent reply: ${String(text).slice(0, 300)}` },
  ];
}

// A-D, or null for UNKNOWN, a model failure or anything unexpected.
export async function modelLetter(llm, question, text) {
  if (!llm) return null;
  const raw = await llm.chat(letterPrompt(question, text), { format: ANSWER_SCHEMA, task: 'parse-reply' });
  const answer = String(parseJson(raw)?.answer ?? '').trim().toUpperCase();
  return LETTERS.includes(answer) ? answer : null;
}

export async function parseReply(text, question, llm) {
  return localLetter(text, question) ?? (await modelLetter(llm, question, text));
}
