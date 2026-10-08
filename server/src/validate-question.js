import { gsmLength, SMS_LIMIT } from './gsm7.js';
import { formatQuestionSms, LETTERS, SUBJECTS, TOPIC_CODES } from './sms.js';
import { numericValue, parse, sample } from './expr.js';

// Worst-case id width so a question that passes still fits once imported.
const WORST_CASE_ID = 9999;

// "Rs 1,200" -> "1200", "30 cm^2" -> "30", "20%" -> "20": the bare value text.
function stripUnits(raw) {
  let s = String(raw ?? '').trim().toLowerCase();
  s = s.replace(/^rs\.?\s*/, '');
  s = s.replace(/(\d),(?=\d{3}\b)/g, '$1');
  s = s.replace(/[.\s]+$/, '');
  for (;;) {
    const before = s;
    s = s
      .replace(/\s*(sq\.?\s*)?(cm|mm|km)(\^?[23])?$/, '')
      .replace(/\s+(sq\.?\s*)?m(\^?[23])?$/, '')
      .replace(/\s*%$/, '')
      .replace(/\s+[a-z]{3,}$/, '')
      .trim();
    if (s === before) break;
  }
  return s;
}

// "Rs 1,200", "30 cm^2", "2 and 3", "x^2-1" -> list of sampled value vectors,
// or null if it is not maths we can evaluate.
function valueOf(raw) {
  const s = stripUnits(raw);
  const parts = s.split(/\s*(?:,|;|\band\b|\bor\b)\s*/).filter(Boolean);
  if (parts.length === 0) return null;
  const vectors = [];
  for (const p of parts) {
    const fn = parse(p);
    if (!fn) return null;
    vectors.push(sample(fn));
  }
  return vectors.sort((x, y) => x[0] - y[0]);
}

function close(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.isNaN(a) && Number.isNaN(b) ? null : a === b;
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

const normText = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, '');

// True if two answers have the same value (2/4 vs 1/2, x^2-1 vs (x-1)(x+1)).
export function sameValue(a, b) {
  const va = valueOf(a);
  const vb = valueOf(b);
  if (va && vb) {
    if (va.length !== vb.length) return false;
    let compared = 0;
    for (let k = 0; k < va.length; k++) {
      for (let p = 0; p < va[k].length; p++) {
        const c = close(va[k][p], vb[k][p]);
        if (c === false) return false;
        if (c === true) compared++;
      }
    }
    if (compared > 0) return true;
  }
  return normText(a) === normText(b);
}

// Science options are words. sameValue would read them as algebra (letters as
// variables, trailing words dropped), so Ohm=Mho and Carbon dioxide=Carbon
// monoxide. Compare the text instead, ignoring case, spacing and a final period.
export function sameText(a, b) {
  const norm = (s) => normText(s).replace(/\.+$/, '');
  return norm(a) === norm(b);
}

// Final value a worked solution arrives at: the text after the last '='.
export function finalValue(solution) {
  const segs = String(solution ?? '').split('=');
  return segs[segs.length - 1].trim();
}

// Decimal places written in a number ('3.14' -> 2), or 0.
const decimals = (s) => (/^-?\d*\.(\d+)$/.exec(s.trim())?.[1].length ?? 0);
const shown = (v) => String(Number(v.toFixed(4)));

// Recomputes every "a = b" in a maths solution where both sides are plain
// numbers ("1200*0.9=1080", "Rs 1,200*10/100=Rs 120"); sides with a variable
// ("SP", "x^2-4") or words are skipped. A written decimal may be rounded to
// its last place (22/7=3.14); a whole number must be exact.
export function arithmeticErrors(solution) {
  const errors = [];
  const statements = String(solution ?? '').split(/;|\n|\.\s+|,\s+/);
  for (const st of statements) {
    const sides = st.split('=');
    for (let k = 0; k + 1 < sides.length; k++) {
      const [ta, tb] = [stripUnits(sides[k]), stripUnits(sides[k + 1])];
      const a = numericValue(ta);
      const b = numericValue(tb);
      if (a === null || b === null) continue;
      const places = Math.max(decimals(ta), decimals(tb));
      const tol = places ? 0.5 * 10 ** -places + 1e-12 : 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
      if (Math.abs(a - b) > tol) {
        const step = `${sides[k].trim()}=${sides[k + 1].trim()}`;
        errors.push(`solution step "${step}" is wrong: ${sides[k].trim()} = ${shown(a)}`);
      }
    }
  }
  return errors;
}

function parseMisconceptions(m) {
  if (typeof m === 'string') {
    try { return JSON.parse(m); } catch { return null; }
  }
  return m && typeof m === 'object' ? m : null;
}

// Single gate for every question (seed, photo import, teacher edit). Returns all errors.
export function validateQuestion(q) {
  const errors = [];
  if (!q || typeof q !== 'object') return { ok: false, errors: ['question is not an object'] };

  const isMath = q.subject === 'MATH';
  if (!SUBJECTS.includes(q.subject)) errors.push(`subject must be one of ${SUBJECTS.join(', ')}`);
  else if (!TOPIC_CODES[q.subject].includes(q.topic)) {
    errors.push(`topic for ${q.subject} must be one of ${TOPIC_CODES[q.subject].join(', ')}`);
  }

  if (!String(q.stem ?? '').trim()) errors.push('stem is empty');

  const options = LETTERS.map((l) => ({ l, v: String(q[`option_${l.toLowerCase()}`] ?? '').trim() }));
  for (const { l, v } of options) {
    if (!v) errors.push(`option ${l} is empty`);
    else if (gsmLength(v) === null) errors.push(`option ${l} has non GSM-7 characters`);
  }
  const same = isMath ? sameValue : sameText;
  for (let x = 0; x < 4; x++) {
    for (let y = x + 1; y < 4; y++) {
      const a = options[x], b = options[y];
      if (a.v && b.v && same(a.v, b.v)) errors.push(`options ${a.l} and ${b.l} have the same value`);
    }
  }

  const correct = q.correct_option;
  const correctOk = LETTERS.includes(correct);
  if (!correctOk) errors.push('correct_option must be A, B, C or D');

  const sms = formatQuestionSms(q, WORST_CASE_ID);
  const smsLen = gsmLength(sms);
  if (smsLen === null) errors.push('question SMS has non GSM-7 characters (no Devanagari or emoji)');
  else if (smsLen > SMS_LIMIT) errors.push(`question SMS is ${smsLen} chars, max ${SMS_LIMIT}`);

  const solution = String(q.solution ?? '').trim();
  const solLen = gsmLength(solution);
  if (!solution) errors.push('solution is empty');
  else if (solLen === null) errors.push('solution has non GSM-7 characters');
  else if (solLen > SMS_LIMIT) errors.push(`solution is ${solLen} chars, max ${SMS_LIMIT}`);
  // Only maths can be checked by code. A science solution is a short
  // explanation; a teacher checks it before approval (CLAUDE.md rule 8).
  if (isMath && solution) errors.push(...arithmeticErrors(solution));
  if (isMath && solution && correctOk) {
    const want = q[`option_${correct.toLowerCase()}`];
    if (want && !sameValue(finalValue(solution), want)) {
      errors.push(`solution ends at "${finalValue(solution)}", not the correct value "${want}"`);
    }
  }

  const mis = parseMisconceptions(q.misconceptions);
  if (!mis) errors.push('misconceptions must be an object keyed by wrong option letter');
  else if (correctOk) {
    for (const l of LETTERS) {
      const note = String(mis[l] ?? '').trim();
      if (l === correct && note) errors.push(`misconception given for correct option ${l}`);
      if (l !== correct && !note) errors.push(`missing misconception note for wrong option ${l}`);
      if (note && gsmLength(note) === null) errors.push(`misconception ${l} has non GSM-7 characters`);
    }
    for (const k of Object.keys(mis)) if (!LETTERS.includes(k)) errors.push(`misconception key ${k} is not A-D`);
  }

  return { ok: errors.length === 0, errors, smsLength: smsLen };
}
