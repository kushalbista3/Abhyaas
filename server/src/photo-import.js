// Teacher photo import (maths only). The cloud model reads a photo of an exam
// page and drafts one card per numbered sub-part; code does every check:
// validateQuestion() (including the arithmetic re-check), the not-SMS-suitable
// filter, and shuffling the options. No Node APIs here: the /import page
// imports checkCard() to show the same reasons live while the teacher edits.
import { gsmLength, SMS_LIMIT } from './gsm7.js';
import { formatQuestionSms, LETTERS, TOPIC_CODES } from './sms.js';
import { validateQuestion } from './validate-question.js';

const LONGEST_TOPIC = TOPIC_CODES.MATH.reduce((a, b) => (b.length > a.length ? b : a));
const SKELETON = formatQuestionSms(
  { topic: LONGEST_TOPIC, stem: '', option_a: '', option_b: '', option_c: '', option_d: '' },
  9999,
);
// Characters left for the stem and the four options in one SMS.
export const STEM_OPTIONS_BUDGET = SMS_LIMIT - gsmLength(SKELETON);

const TOPIC_HINTS = {
  HCF: 'HCF and LCM of numbers or algebraic expressions',
  PCT: 'profit, loss, discount, VAT, commission',
  INT: 'simple or compound interest, population growth, depreciation',
  ALG: 'indices, equations, simplifying, factorising',
  GEO: 'area, surface area, volume (answer must be a number)',
  SET: 'sets and Venn diagram counting (answer must be a number)',
  PROB: 'probability',
};

const UNSUITABLE_WORDS = /\b(compare|explain|justify|draw|prove|construct|show that)\b/i;

export function importInstruction(budget = STEM_OPTIONS_BUDGET) {
  return [
    'This is a photo of a Nepal SEE (Grade 10) maths exam page. Turn it into multiple-choice practice cards sent by SMS.',
    'Step 1: list every numbered sub-part on the page in sub_parts, e.g. "1(a)", "1(b)", "2(a)". Include every part, even ones you cannot turn into a card.',
    'Step 2: write exactly ONE card per sub-part, in the same order, with source_ref equal to its label.',
    'Each card must be self-contained: copy the shared context of the main question (numbers, sets, given values) into its stem.',
    `topic is one of: ${TOPIC_CODES.MATH.map((c) => `${c} (${TOPIC_HINTS[c]})`).join(', ')}, or OTHER.`,
    'If a part needs a diagram, a construction or a proof, asks for a comparison or explanation in words, or its topic is OTHER: set sms_suitable to false, give a short reason, and leave the other fields empty.',
    'Write sets in plain words, never set notation: "students who like only tea", "who like neither". A bar over a set means its complement (not in that set).',
    'Plain ASCII only: x^2 for powers, * to multiply, / to divide, pi or 22/7. Never use superscripts, the times or divide signs, root signs, Greek letters, Devanagari or emoji.',
    `The stem and the four answer options together must be at most ${budget} characters. Keep the stem short.`,
    'answer is the correct answer, short: a number with its unit, or an expression.',
    'wrong_answers has exactly 3 wrong answers that real students get from real mistakes, each with a misconception note (under 100 characters) naming that mistake. If the part already has printed options, the wrong answers are the printed wrong options.',
    'solution: at most 2 short steps, under 100 characters, ending "= <answer>", e.g. "SP=1200*0.9=1080".',
    'Reply with JSON only, no other text:',
    '{"sub_parts": ["1(a)"], "cards": [{"source_ref": "1(a)", "topic": "PCT", "sms_suitable": true, "reason": "", "stem": "...", "answer": "...", "wrong_answers": [{"answer": "...", "misconception": "..."}], "solution": "..."}]}',
  ].join('\n');
}

export class ImportError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

// The model's JSON, tolerating code fences and text around the object.
export function parseModelJson(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const v = JSON.parse(s.slice(start, end + 1));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const str = (v) => String(v ?? '').trim();

// Why a card can't be an SMS MCQ, or null. The model's own flag, a topic
// outside the 7 maths codes, or a stem asking for words, a drawing or a proof.
export function unsuitableReason(card) {
  if (card.sms_suitable === false) return str(card.reason) || 'Marked not SMS-suitable by the model.';
  if (!TOPIC_CODES.MATH.includes(card.topic)) return `Topic ${str(card.topic) || 'missing'} is not one of the SMS maths topics.`;
  const word = UNSUITABLE_WORDS.exec(str(card.stem));
  if (word) return `Asks to "${word[1].toLowerCase()}": needs a written answer, not A-D.`;
  return null;
}

// One model card -> a question-shaped card with the options shuffled in code.
export function toCard(raw, rng = Math.random) {
  const base = {
    source_ref: str(raw?.source_ref),
    subject: 'MATH',
    topic: str(raw?.topic).toUpperCase(),
    stem: str(raw?.stem),
    solution: str(raw?.solution),
    sms_suitable: raw?.sms_suitable !== false,
    reason: str(raw?.reason),
  };
  const reason = unsuitableReason(base);
  if (reason) return { ...base, unsuitable: reason };

  const wrong = Array.isArray(raw?.wrong_answers) ? raw.wrong_answers.slice(0, 3) : [];
  const choices = [{ text: str(raw?.answer), note: '', correct: true }];
  for (const w of wrong) choices.push({ text: str(w?.answer), note: str(w?.misconception), correct: false });
  while (choices.length < 4) choices.push({ text: '', note: '', correct: false });
  // Fisher-Yates, so the correct letter is spread across A-D.
  for (let i = choices.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [choices[i], choices[j]] = [choices[j], choices[i]];
  }
  const card = { ...base, unsuitable: null, misconceptions: {} };
  choices.forEach((c, i) => {
    const l = LETTERS[i];
    card[`option_${l.toLowerCase()}`] = c.text;
    if (c.correct) card.correct_option = l;
    else if (c.note) card.misconceptions[l] = c.note;
  });
  return card;
}

// Same checks on the page (live) and on approve (server).
export function checkCard(card) {
  const unsuitable = str(card?.unsuitable) || unsuitableReason({ topic: card?.topic, stem: card?.stem });
  if (unsuitable) return { unsuitable, errors: [] };
  const { errors } = validateQuestion({ ...card, subject: 'MATH' });
  return { unsuitable: null, errors };
}

// gemini.generate({ image, mimeType, instruction }) -> reply text. Retried
// once on a 5xx. Returns the cards with their check results.
export async function extractCards(gemini, { image, mimeType }, { rng = Math.random } = {}) {
  const instruction = importInstruction();
  let text;
  for (let attempt = 1; ; attempt++) {
    try {
      text = await gemini.generate({ image, mimeType, instruction });
      break;
    } catch (err) {
      if (attempt === 1 && err?.status >= 500) continue;
      throw new ImportError(`The photo model failed (${err?.status ?? 'error'}): ${str(err?.message) || 'no message'}`);
    }
  }
  const json = parseModelJson(text);
  if (!json || !Array.isArray(json.cards)) throw new ImportError('Could not read the model reply. Try a clearer photo.');
  const subParts = Array.isArray(json.sub_parts) ? json.sub_parts.map(str).filter(Boolean) : [];
  const cards = json.cards.map((raw) => {
    const card = toCard(raw, rng);
    return { ...card, errors: card.unsuitable ? [] : checkCard(card).errors };
  });
  const refs = new Set(cards.map((c) => c.source_ref));
  return {
    subParts,
    cards,
    missing: subParts.filter((p) => !refs.has(p)),
    summary: `Found ${subParts.length} sub-parts, ${cards.length} cards returned`,
  };
}
