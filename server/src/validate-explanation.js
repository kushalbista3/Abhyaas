// The only gate for wrong-option explanations (model drafts and teacher
// edits). A student who picked a wrong option gets
//   "Not quite. <text> Try again: reply A/B/C/D"
// so the text must fit that SMS and must not give the answer away.
import { fitsOneSms, gsmLength } from './gsm7.js';
import { LETTERS } from './sms.js';
import { sameValue } from './validate-question.js';

export const EXPLANATION_LIMIT = 120;
export const wrongReply = (text) => `Not quite. ${text} Try again: reply A/B/C/D`;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const optionText = (q, l) => String(q[`option_${l.toLowerCase()}`] ?? '').trim();
const misconceptionsOf = (q) => (typeof q.misconceptions === 'string' ? JSON.parse(q.misconceptions) : q.misconceptions ?? {});

// "option C", "answer: C", "C)", "(C)", or C on its own. Uppercase only, and
// "A" followed by a lowercase word is the article ("A metal ...").
export function mentionsLetter(text, letter) {
  const keyword = new RegExp(`\\b(?:[Oo]ption|[Aa]nswer|[Aa]ns|[Cc]hoice|[Cc]hoose|[Pp]ick|[Rr]eply|[Ss]elect)\\s*[:=-]?\\s*\\(?${letter}\\b`);
  const paren = new RegExp(`(?:^|[^A-Za-z0-9])\\(?${letter}\\)`);
  const alone = letter === 'A' ? /\bA\b(?! [a-z])/ : new RegExp(`\\b${letter}\\b`);
  return keyword.test(text) || paren.test(text) || alone.test(text);
}

// "x - 2" -> "x-2", "Rs 2,034" -> "Rs 2034"
const compact = (text) =>
  String(text)
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/\s*([-+*/^=])\s*/g, '$1');

// Words and tokens that could carry a maths value: "2034", "x-2", "18a^2b^3".
const valueTokens = (text) =>
  compact(text)
    .split(/[\s,;:!?]+/)
    .map((t) => t.replace(/[.]+$/, ''))
    .filter((t) => /[\d+\-*/^()]/.test(t) && /[\da-z]/i.test(t));

export function mentionsValue(text, question, letter) {
  const value = optionText(question, letter);
  if (!value) return false;
  const norm = (s) => compact(s).toLowerCase().replace(/\s+/g, ' ');
  if (new RegExp(`(?:^|[^a-z0-9])${escape(norm(value))}(?![a-z0-9])`).test(norm(text))) return true;
  if (question.subject !== 'MATH') return false;
  return valueTokens(text).some((t) => sameValue(t, value));
}

// Telling the student the operation to finish with: "add 234 to 1800",
// "subtract 10 from 13", "divide 1000 by 1.25". Past tense or a question about
// what they did ("you added", "did you add 13%") is fine.
const OPERATION = /\b(add|subtract|multiply|divide|deduct|take away)\b[^.;!?]*\d/gi;
const NOT_AN_ORDER = /\b(?:did you|you|not|never|don't|didn't)\s+$/i;

export function statesOperation(text) {
  for (const m of String(text).matchAll(OPERATION)) {
    if (!NOT_AN_ORDER.test(text.slice(0, m.index))) return true;
  }
  return false;
}

const numbers = (s) => String(s).replace(/(\d),(?=\d{3}\b)/g, '$1').match(/\d+(?:\.\d+)?/g) ?? [];

// Words that may appear in a science explanation without being a "key term".
const COMMON = new Set(
  `about above after again against always another answer around because before being below between careful carefully
  cause caused change changes check chose choose choice confuse confused correct could depends describe describes
  different doesn't every exactly first given going happen happens inside instead itself later little looks makes
  meaning means might mistake mistook mixed mixing never notice number option other outside people point question
  quite really recall remember right second should since something stays still their there these thing things think
  thinking thought those through under value which while whole without would wrong words where whether means reread
  always actually simply rather often usually forms gives comes takes shows tells become becomes called using found
  finds apply applies works getting taking giving remain remains`
    .split(/\s+/)
    .filter(Boolean),
);
const stemWord = (w) => w.toLowerCase().replace(/(?:ing|ed|es|s|ly)$/, '');

// Science terms in the text that the question, options, solution and the
// option's misconception note never mention.
export function newScienceTerms(text, question, letter) {
  const source = [question.stem, ...LETTERS.map((l) => optionText(question, l)), question.solution, misconceptionsOf(question)[letter]]
    .join(' ');
  const sourceTokens = new Set((source.match(/[A-Za-z0-9]+(?:[.^][A-Za-z0-9]+)*/g) ?? []).map((t) => t.toLowerCase()));
  const sourceStems = new Set([...sourceTokens].map(stemWord));
  const out = [];
  for (const t of String(text).match(/[A-Za-z0-9]+(?:[.^][A-Za-z0-9]+)*/g) ?? []) {
    const lower = t.toLowerCase();
    const technical = /\d/.test(t) || /[a-z][A-Z]/.test(t) || /^[A-Z]{2,}$/.test(t);
    if (technical) {
      if (!sourceTokens.has(lower)) out.push(t);
    } else if (t.length >= 5 && !COMMON.has(lower) && !sourceStems.has(stemWord(t))) {
      out.push(t);
    }
  }
  return [...new Set(out)];
}

// mode 'generate' (model drafts, approve): everything must pass.
// mode 'teacher' (a teacher's own text): the maths number check and the
// science-term check only warn; the teacher is the one checking the facts.
export function validateExplanation(text, question, letter, { mode = 'generate' } = {}) {
  const errors = [];
  const warnings = [];
  const t = String(text ?? '').trim();
  const correct = question.correct_option;
  if (!LETTERS.includes(letter)) errors.push('option must be A, B, C or D');
  else if (letter === correct) errors.push(`option ${letter} is the correct answer; explanations are for wrong options`);
  if (!t) return { ok: false, errors: [...errors, 'explanation is empty'], warnings, length: 0 };

  const length = gsmLength(t);
  if (length === null) errors.push('has non GSM-7 characters (no Devanagari, emoji or smart quotes)');
  else {
    if (length > EXPLANATION_LIMIT) errors.push(`is ${length} chars, max ${EXPLANATION_LIMIT}`);
    if (!fitsOneSms(wrongReply(t))) errors.push(`"Not quite. ... Try again: reply A/B/C/D" is ${gsmLength(wrongReply(t))} chars, max 160`);
  }
  if (mentionsLetter(t, correct)) errors.push(`mentions the correct letter ${correct}`);
  if (mentionsValue(t, question, correct)) errors.push(`gives the correct answer "${optionText(question, correct)}"`);
  if (statesOperation(t)) errors.push('tells the student which operation to do on the numbers (e.g. "add X to Y")');

  if (question.subject === 'MATH') {
    const known = new Set(numbers([question.stem, ...LETTERS.map((l) => optionText(question, l)), question.solution].join(' ')));
    const unknown = [...new Set(numbers(t).filter((n) => !known.has(n)))];
    if (unknown.length) {
      const msg = `numbers not in the question, options or solution: ${unknown.join(', ')}`;
      (mode === 'teacher' ? warnings : errors).push(msg);
    }
  } else {
    const terms = newScienceTerms(t, question, letter);
    if (terms.length) {
      const msg = `science terms not in the question, options, solution or note: ${terms.join(', ')}`;
      (mode === 'teacher' ? warnings : errors).push(msg);
    }
  }
  return { ok: errors.length === 0, errors, warnings, length };
}
