import { gsmLength, SMS_LIMIT } from './gsm7.js';
import { formatQuestionSms, LETTERS, TOPIC_CODES } from './sms.js';
import { parse, sample } from './expr.js';

// Worst-case id width so a question that passes still fits once imported.
const WORST_CASE_ID = 9999;

// "Rs 1,200", "30 cm^2", "2 and 3", "x^2-1" -> list of sampled value vectors,
// or null if it is not maths we can evaluate.
function valueOf(raw) {
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

// Final value a worked solution arrives at: the text after the last '='.
export function finalValue(solution) {
  const segs = String(solution ?? '').split('=');
  return segs[segs.length - 1].trim();
}

function parseMisconceptions(m) {
  if (typeof m === 'string') {
    try { return JSON.parse(m); } catch { return null; }
  }
  return m && typeof m === 'object' ? m : null;
}

// Single gate for every question (seed and photo import). Returns all errors.
export function validateQuestion(q) {
  const errors = [];
  if (!q || typeof q !== 'object') return { ok: false, errors: ['question is not an object'] };

  if (!TOPIC_CODES.includes(q.topic)) errors.push(`topic must be one of ${TOPIC_CODES.join(', ')}`);

  if (!String(q.stem ?? '').trim()) errors.push('stem is empty');

  const options = LETTERS.map((l) => ({ l, v: String(q[`option_${l.toLowerCase()}`] ?? '').trim() }));
  for (const { l, v } of options) {
    if (!v) errors.push(`option ${l} is empty`);
    else if (gsmLength(v) === null) errors.push(`option ${l} has non GSM-7 characters`);
  }
  for (let x = 0; x < 4; x++) {
    for (let y = x + 1; y < 4; y++) {
      const a = options[x], b = options[y];
      if (a.v && b.v && sameValue(a.v, b.v)) errors.push(`options ${a.l} and ${b.l} have the same value`);
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
  if (solution && correctOk) {
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
