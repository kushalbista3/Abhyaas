export const TOPICS = {
  MATH: {
    HCF: 'HCF/LCM',
    PCT: 'Profit/VAT',
    INT: 'Interest',
    ALG: 'Algebra',
    GEO: 'Area/Volume',
    SET: 'Sets',
    PROB: 'Probability',
  },
  SCI: {
    PHY: 'Physics',
    CHEM: 'Chemistry',
    BIO: 'Biology',
    EARTH: 'Earth/Space',
  },
};

export const SUBJECTS = Object.keys(TOPICS);

const SUBJECT_NAMES = { MATH: 'Maths', SCI: 'Science' };
const EXAMPLE_TOPIC = { MATH: 'PCT', SCI: 'BIO' };

// Per subject: TOPIC_CODES.SCI = ['PHY', ...], TOPICS_MESSAGE.SCI = 'Science topics: ...'
export const TOPIC_CODES = Object.fromEntries(SUBJECTS.map((s) => [s, Object.keys(TOPICS[s])]));

export const TOPICS_MESSAGE = Object.fromEntries(
  SUBJECTS.map((s) => [
    s,
    `${SUBJECT_NAMES[s]} topics: ` +
      Object.entries(TOPICS[s]).map(([code, name]) => `${code}=${name}`).join(' ') +
      `. Reply a code, e.g. ${EXAMPLE_TOPIC[s]}`,
  ]),
);

export const LETTERS = ['A', 'B', 'C', 'D'];

export function formatQuestionSms(q, id = q.id) {
  return [
    `Q${id} ${q.topic}`,
    q.stem,
    ...LETTERS.map((l) => `${l}) ${q[`option_${l.toLowerCase()}`]}`),
    'Reply A/B/C/D',
  ].join('\n');
}

// For any screen (teacher dashboard, logs): 9800000001 -> 98******01
export function maskPhone(phone) {
  const s = String(phone ?? '');
  if (s.length <= 4) return '*'.repeat(s.length);
  return s.slice(0, 2) + '*'.repeat(s.length - 4) + s.slice(-2);
}
