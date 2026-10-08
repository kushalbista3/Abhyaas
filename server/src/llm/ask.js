// ASK <text>. Science never goes to the model (CLAUDE.md rule 8). Maths
// compute requests never do either: the model must not do the student's
// sums, so they get a hand-written method hint. Only maths concept questions
// ("what is HCF?") are answered by the model.
import { gsmLength, smsSafe, unsafeChars } from '../gsm7.js';
import { TOPICS } from '../sms.js';
import { parseJson } from './client.js';

export const ASK_LIMIT = 150;
export const COMPUTE_TAIL = ' Sent to your teacher too.';

// One per maths topic; with COMPUTE_TAIL each must fit one SMS (tested).
export const METHOD_HINTS = {
  HCF: 'HCF/LCM: factorise each expression fully. HCF takes common factors with lowest powers, LCM all factors with highest powers.',
  PCT: 'Profit/VAT: take the discount off the marked price first, then add VAT on that price. Profit % is always on the cost price.',
  INT: 'Interest: write P, T and R first. SI=P*T*R/100. Compound amount=P(1+R/100)^T. Depreciation uses (1-R/100)^T.',
  ALG: 'Algebra: bring every term to one side, factorise, then set each factor to 0. For indices, add powers when you multiply.',
  GEO: 'Area/Volume: draw the shape, write its formula, then put in the values with units. Check radius vs diameter.',
  SET: 'Sets: draw a Venn diagram and fill the middle first. n(AuB)=n(A)+n(B)-n(AnB). Neither=total-n(AuB).',
  PROB: 'Probability: list all outcomes first. P=favourable/total. Without replacement the total goes down by 1.',
  GENERAL: 'Write what is given and what is asked, pick the formula for that topic, then work step by step.',
};

const COMPUTE_WORDS =
  /\b(solve|calculate|calc|simplify|factori[sz]e|evaluate|find the value|work out|nikala|nikalnus|kati hunchha|kati huncha|kati hunxa|kati ho|hisab)\b/i;

// Equations, operators, "solve ..." or two or more numbers.
export function isComputeRequest(text) {
  const s = String(text ?? '');
  if (s.includes('=')) return true;
  if (/\d\s*[-+*/^x]\s*\d/i.test(s)) return true;
  if (/[a-z0-9)]\s*[+*/^]\s*[a-z0-9(]/i.test(s)) return true;
  if (COMPUTE_WORDS.test(s)) return true;
  return (s.match(/\d+(?:\.\d+)?/g) ?? []).length >= 2;
}

// Checked in this order, so "compound interest" is INT, not something else.
const TOPIC_WORDS = [
  ['SET', /\b(sets?|venn|union|intersection|n\(|neither|subsets?)\b/i],
  ['PROB', /\b(probability|dice|die|coins?|cards?|balls?|bag|chance|sambhavana)\b/i],
  ['INT', /\b(interest|compound|depreciation|principal|byaj|amount after)\b/i],
  ['PCT', /\b(profit|loss|vat|discount|marked price|cost price|selling price|commission|percent|nafa|noksan)\b|%/i],
  ['HCF', /\b(hcf|lcm|highest common|lowest common|common factors?)\b/i],
  ['GEO', /\b(area|volume|cone|cylinder|sphere|hemisphere|prism|pyramid|triangle|circle|radius|diameter|surface)\b/i],
  ['ALG', /\b(algebra|equation|quadratic|indices|index|exponent|factori[sz]e)\b|\d\s*[a-z]\b|[a-z]\s*\^|\bx\b/i],
];

export function topicOf(text) {
  return TOPIC_WORDS.find(([, re]) => re.test(String(text ?? '')))?.[0] ?? null;
}

export const computeReply = (topic) => (METHOD_HINTS[topic] ?? METHOD_HINTS.GENERAL) + COMPUTE_TAIL;

// A maths-subject ASK that is plainly about science still gets the science
// treatment (rule 8): no model, sent to the teacher.
const SCIENCE_WORDS =
  /\b(science|physics|chemistry|biology|bigyan|vigyan|photosynthesis|cells?|blood|heart|atoms?|electrons?|protons?|neutrons?|molecules?|acids?|force|gravity|weight|energy|light|lens|mirror|current|voltage|magnets?|heat|temperature|chemicals?|reactions?|metals?|genes?|dna|plants?|animals?|virus|bacteria|disease|organs?|planets?|stars?|moon|sun|ozone|greenhouse|pollution|climate|oxygen|hydrogen|carbon|nitrogen|periodic)\b/i;

export const isScienceQuestion = (text) => SCIENCE_WORDS.test(String(text ?? ''));

const ASK_SCHEMA = {
  type: 'object',
  properties: { is_maths: { type: 'boolean' }, reply: { type: 'string' } },
  required: ['is_maths', 'reply'],
};

const topicList = Object.values(TOPICS.MATH).join(', ');

const SYSTEM = [
  'You are Abhyaas, a maths tutor for Nepal SEE (Grade 10) students. Students ask by SMS from basic phones.',
  `SEE maths topics: ${topicList} (HCF and LCM of algebraic expressions, profit and loss, discount, VAT,`,
  'simple and compound interest, depreciation, indices, quadratic equations, area and volume of solids, sets and Venn diagrams, probability).',
  `Answer the student's maths concept question in at most ${ASK_LIMIT} characters,`,
  'in simple English or Romanized Nepali (Latin letters only; no Devanagari, no emoji).',
  'Explain the idea or the method. Never solve a numeric problem or give a final answer to a sum.',
  'If the question is not about maths, set is_maths to false and reply with an empty string.',
  'Reply only with JSON: {"is_maths": true|false, "reply": "..."}.',
].join(' ');

export function askPrompt(text) {
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: String(text).slice(0, 300) },
  ];
}

// Longest start of `s` that ends a sentence and fits `limit`, else null.
function fitSentences(s, limit) {
  if (gsmLength(s) <= limit) return s;
  const ends = [...s.matchAll(/[.!?](?=\s|$)/g)].map((m) => m.index + 1);
  for (const end of ends.reverse()) {
    const cut = s.slice(0, end).trim();
    if (gsmLength(cut) <= limit) return cut;
  }
  return null;
}

// The model's concept answer, ready to send, or null (failure, not maths,
// non-Latin text, empty, or too long to trim at a sentence end).
export async function askModel(llm, text) {
  if (!llm) return null;
  const parsed = parseJson(await llm.chat(askPrompt(text), { format: ASK_SCHEMA, task: 'ask' }));
  if (!parsed || parsed.is_maths !== true || typeof parsed.reply !== 'string') return null;
  if (unsafeChars(parsed.reply).length) return null;
  const reply = smsSafe(parsed.reply, Infinity);
  if (!reply) return null;
  return fitSentences(reply, ASK_LIMIT);
}
