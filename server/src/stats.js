// Teacher dashboard numbers, one subject at a time. Like SCORE, accuracy is
// first tries only: the first attempt in each session (one serving).
import { LETTERS, TOPICS } from './sms.js';
import { firstTries, sqlTime, streak, weakestTopic } from './practice.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const FIRST_TRIES = `
  SELECT a.*, q.topic FROM attempts a JOIN questions q ON q.id = a.question_id
  WHERE q.subject = ? AND a.id IN (SELECT MIN(id) FROM attempts WHERE session_id IS NOT NULL GROUP BY session_id)`;

const pct = (correct, tries) => (tries ? Math.round((100 * correct) / tries) : null);

// Students in the class, answers in the last 7 days, first-try accuracy over them.
export function classOverview(db, subject, now) {
  const since = sqlTime(new Date(now.getTime() - WEEK_MS));
  const students = db.prepare('SELECT COUNT(*) AS n FROM students').get().n;
  const answersWeek = db
    .prepare(`SELECT COUNT(*) AS n FROM attempts a JOIN questions q ON q.id = a.question_id
      WHERE q.subject = ? AND a.created_at >= ?`)
    .get(subject, since).n;
  const week = db
    .prepare(`SELECT COUNT(*) AS tries, COALESCE(SUM(is_correct), 0) AS correct FROM (${FIRST_TRIES}) WHERE created_at >= ?`)
    .get(subject, since);
  return { students, answersWeek, firstTries: week.tries, firstTryAccuracy: pct(week.correct, week.tries) };
}

// Topics with at least one first try, worst first (ties: more tries first).
export function topicAccuracy(db, subject) {
  return db
    .prepare(`SELECT topic, COUNT(*) AS tries, SUM(is_correct) AS correct FROM (${FIRST_TRIES}) GROUP BY topic`)
    .all(subject)
    .map((r) => ({ ...r, name: TOPICS[subject][r.topic], pct: pct(r.correct, r.tries) }))
    .sort((a, b) => a.correct * b.tries - b.correct * a.tries || b.tries - a.tries || a.topic.localeCompare(b.topic));
}

// Per question: first-try %, the wrong option chosen most on first tries and
// its approved explanation (null if none). Lowest first-try % first.
export function misconceptionStats(db, subject) {
  const rows = db
    .prepare(`SELECT question_id, chosen_option, is_correct, COUNT(*) AS n FROM (${FIRST_TRIES})
      GROUP BY question_id, chosen_option, is_correct`)
    .all(subject);
  const getQ = db.prepare('SELECT * FROM questions WHERE id = ?');
  const getExp = db.prepare(`SELECT text FROM explanations
    WHERE question_id = ? AND option = ? AND status = 'approved' ORDER BY id DESC LIMIT 1`);

  const byQuestion = new Map();
  for (const r of rows) {
    const s = byQuestion.get(r.question_id) ?? { tries: 0, correct: 0, wrong: {} };
    s.tries += r.n;
    if (r.is_correct) s.correct += r.n;
    else s.wrong[r.chosen_option] = (s.wrong[r.chosen_option] ?? 0) + r.n;
    byQuestion.set(r.question_id, s);
  }

  return [...byQuestion]
    .map(([id, s]) => {
      const q = getQ.get(id);
      // Most chosen; ties go to the earlier letter.
      const wrongOption = LETTERS.filter((l) => s.wrong[l]).sort((a, b) => s.wrong[b] - s.wrong[a])[0] ?? null;
      return {
        id,
        topic: q.topic,
        stem: q.stem,
        tries: s.tries,
        correct: s.correct,
        pct: pct(s.correct, s.tries),
        wrongOption,
        wrongText: wrongOption ? q[`option_${wrongOption.toLowerCase()}`] : null,
        wrongCount: wrongOption ? s.wrong[wrongOption] : 0,
        explanation: wrongOption ? getExp.get(id, wrongOption)?.text ?? null : null,
      };
    })
    .sort((a, b) => a.correct * b.tries - b.correct * a.tries || b.wrongCount - a.wrongCount || a.id - b.id);
}

// One row per student. Names only, never phone numbers.
export function studentStats(db, subject) {
  return db
    .prepare('SELECT id, name FROM students ORDER BY name, id')
    .all()
    .map(({ id, name }) => {
      const tries = firstTries(db, id, subject);
      const correct = tries.filter((t) => t.is_correct).length;
      return { id, name, tries: tries.length, pct: pct(correct, tries.length), streak: streak(tries), weakest: weakestTopic(tries, subject) };
    });
}

export function dashboard(db, subject, now) {
  return {
    overview: classOverview(db, subject, now),
    topics: topicAccuracy(db, subject),
    misconceptions: misconceptionStats(db, subject),
    students: studentStats(db, subject),
  };
}
