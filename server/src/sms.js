export const TOPICS = {
  HCF: 'HCF/LCM',
  PCT: 'Profit/VAT',
  INT: 'Interest',
  ALG: 'Algebra',
  GEO: 'Area/Volume',
  SET: 'Sets',
  PROB: 'Probability',
};

export const TOPIC_CODES = Object.keys(TOPICS);

export const TOPICS_MESSAGE =
  'Topics: ' +
  Object.entries(TOPICS).map(([code, name]) => `${code}=${name}`).join(' ') +
  '. Reply a code, e.g. PCT';

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
