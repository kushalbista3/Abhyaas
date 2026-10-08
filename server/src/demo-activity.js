// Five days of made-up practice by the 3 demo students, for the dashboard
// demo (npm run demo:reset only). It drives the real SMS engine with a fake
// clock and no model, so sessions, attempts, messages, outbox rows and doubts
// are exactly what real SMS would produce.
// The story: PCT is clearly the class's weakest topic, and on PCT-1 most
// students pick A (a net 13%-10%=3% rate). Nothing is dated today, so the
// daily cap is fresh and the PCT reviews are due when the demo starts.
import { createSmsEngine } from './engine.js';
import { DEMO_STUDENTS } from './seed-data.js';
import { LETTERS } from './sms.js';

export const DEMO_DAYS = 5;
const OTHER_MATH = ['HCF', 'INT', 'ALG', 'GEO', 'SET', 'PROB'];
// Science per student per day (k = 0 is the oldest day). Bikash ends on Science.
const SCIENCE = [
  [[], [], [], [], []],
  [[], [], ['PHY'], ['CHEM', 'BIO'], ['EARTH', 'PHY']],
  [[], [], [], [], ['PHY', 'EARTH']],
];
const DOUBTS = {
  0: { day: 4, text: 'ASK why is VAT added after the discount?' },
  1: { day: 3, text: 'ASK why do we see lightning before we hear thunder?' },
};

const wrongLetter = (q, n, not = null) => {
  const wrong = LETTERS.filter((l) => l !== q.correct_option && l !== not);
  return wrong[n % wrong.length];
};

// First try for student si on day k, slot = position in that day's list.
function firstAnswer(q, si, k, slot) {
  if (q.source_ref === 'seed:PCT-1') return si === 2 && k === 2 ? 'C' : 'A';
  if (q.source_ref === 'seed:PCT-2') return si === 0 && k === 3 ? q.correct_option : wrongLetter(q, si + k);
  return (si * 7 + k * 3 + slot) % 6 === 0 ? wrongLetter(q, si + slot) : q.correct_option;
}

// After a wrong first try: right on the 2nd try, or wrong again (answer shown).
// Either way the session ends, so no question is left waiting.
const secondAnswer = (q, si, k, first) => ((si + k) % 2 === 0 ? q.correct_option : wrongLetter(q, k, first));

export async function seedDemoActivity(db, { now = new Date() } = {}) {
  const count = (sql) => db.prepare(sql).get().n;
  if (count('SELECT COUNT(*) AS n FROM attempts')) return { attempts: 0, doubts: 0, messages: 0 };
  const before = { attempts: 0, doubts: count('SELECT COUNT(*) AS n FROM doubts'), messages: count('SELECT COUNT(*) AS n FROM messages') };

  let clock = 0;
  const engine = createSmsEngine(db, { now: () => new Date(clock), llm: null });
  const question = db.prepare('SELECT * FROM questions WHERE id = ?');
  const students = DEMO_STUDENTS.map((s) => db.prepare('SELECT phone FROM students WHERE phone = ?').get(s.phone));

  for (let k = 0; k < DEMO_DAYS; k++) {
    for (const [si, student] of students.entries()) {
      if (!student) continue;
      const start = new Date(now);
      start.setDate(start.getDate() - (DEMO_DAYS - k));
      start.setHours(16, si * 25, 0, 0);
      clock = start.getTime();
      const sms = async (body) => {
        const { reply } = await engine.receive(student.phone, body);
        clock += 45_000;
        return reply;
      };

      const topics = ['PCT', ...[0, 2, 4].map((o) => OTHER_MATH[(k + si + o) % OTHER_MATH.length]), ...SCIENCE[si][k]];
      for (const [slot, topic] of topics.entries()) {
        const id = (await sms(`QUIZ ${topic}`)).match(/^Q(\d+) /)?.[1];
        if (!id) continue; // e.g. science not approved yet
        const q = question.get(Number(id));
        const first = firstAnswer(q, si, k, slot);
        await sms(first);
        if (first !== q.correct_option) await sms(secondAnswer(q, si, k, first));
      }
      if (si === 2 && SCIENCE[si][k].length) await sms('SUBJECT MATH');
      if (si === 2 && k === DEMO_DAYS - 1) await sms('SCORE');
      // Bikash is on Science by then, so his ASK is a science doubt.
      if (DOUBTS[si]?.day === k) await sms(DOUBTS[si].text);
    }
  }

  return {
    attempts: count('SELECT COUNT(*) AS n FROM attempts') - before.attempts,
    doubts: count('SELECT COUNT(*) AS n FROM doubts') - before.doubts,
    messages: count('SELECT COUNT(*) AS n FROM messages') - before.messages,
  };
}
