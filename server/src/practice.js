// Adaptive practice: which question a student gets next, plus per-subject
// stats for SCORE. Only approved questions are ever candidates.
import { TOPIC_CODES } from './sms.js';

export const DAILY_QUIZ_CAP = 20;
export const MIN_TRIES_FOR_WEAKEST = 2;
export const REVIEW_AFTER_MS = 2 * 24 * 60 * 60 * 1000;

// Same UTC "YYYY-MM-DD HH:MM:SS" text as SQLite's datetime('now'), so
// timestamps we write and column defaults compare correctly as strings.
export const sqlTime = (date) => date.toISOString().slice(0, 19).replace('T', ' ');

// [start, end) of the laptop's local calendar day containing `now`.
export function localDay(now) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return [sqlTime(start), sqlTime(end)];
}

// The first attempt at each served question (one session = one serving),
// oldest first. Only first tries count for stats, streaks and reviews.
export function firstTries(db, studentId, subject) {
  return db.prepare(`
    SELECT a.id, a.question_id, a.is_correct, a.created_at, q.topic
    FROM attempts a JOIN questions q ON q.id = a.question_id
    WHERE a.student_id = ? AND q.subject = ?
      AND a.id = (SELECT MIN(b.id) FROM attempts b WHERE b.session_id = a.session_id)
    ORDER BY a.id`).all(studentId, subject);
}

export function topicStats(tries) {
  const stats = {};
  for (const t of tries) {
    const s = (stats[t.topic] ??= { tries: 0, correct: 0 });
    s.tries++;
    s.correct += t.is_correct;
  }
  return stats;
}

// Lowest first-try accuracy among topics with enough tries. A topic at 100%
// is never weakest. Ties go to the topic with more tries, then topic order.
export function weakestTopic(tries, subject) {
  const stats = topicStats(tries);
  let best = null;
  for (const topic of TOPIC_CODES[subject]) {
    const s = stats[topic];
    if (!s || s.tries < MIN_TRIES_FOR_WEAKEST || s.correct === s.tries) continue;
    // Compare correct/tries by cross-multiplying to avoid float ties.
    const cmp = best ? s.correct * best.tries - best.correct * s.tries : -1;
    if (cmp < 0 || (cmp === 0 && s.tries > best.tries)) best = { topic, ...s };
  }
  return best?.topic ?? null;
}

// Consecutive most recent questions answered right on the first try.
export function streak(tries) {
  let n = 0;
  for (let i = tries.length - 1; i >= 0 && tries[i].is_correct; i--) n++;
  return n;
}

// Questions whose latest first try was wrong, at least REVIEW_AFTER_MS ago.
// Oldest first.
export function dueReviews(tries, now) {
  const cutoff = sqlTime(new Date(now.getTime() - REVIEW_AFTER_MS));
  const latest = new Map();
  for (const t of tries) latest.set(t.question_id, t);
  return [...latest.values()]
    .filter((t) => !t.is_correct && t.created_at <= cutoff)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
}

// Next question for a student, or null if the subject (or topic) has no
// approved questions. Order without a topic:
//   1. due review in the weakest topic   2. any due review
//   3. new question in the weakest topic 4. next new question
//   5. the least recently practised question, so QUIZ never dead-ends.
// With a topic, the same order within that topic (no weakest-topic steps).
// excludeId (the question being skipped) is avoided when there is another choice.
export function pickQuestion(db, studentId, subject, { topic = null, now, excludeId = null } = {}) {
  let pool = db
    .prepare("SELECT * FROM questions WHERE subject = ? AND status = 'approved' ORDER BY id")
    .all(subject)
    .filter((q) => !topic || q.topic === topic);
  if (pool.length > 1) pool = pool.filter((q) => q.id !== excludeId);
  if (!pool.length) return null;

  const byId = new Map(pool.map((q) => [q.id, q]));
  const tries = firstTries(db, studentId, subject);
  const lastSeen = new Map(tries.map((t) => [t.question_id, t.created_at]));
  const due = dueReviews(tries, now).map((t) => byId.get(t.question_id)).filter(Boolean);
  const fresh = pool.filter((q) => !lastSeen.has(q.id));
  const weak = topic ? null : weakestTopic(tries, subject);
  const inWeak = (q) => q.topic === weak;
  const leastRecent = () =>
    [...pool].sort((a, b) => lastSeen.get(a.id).localeCompare(lastSeen.get(b.id)) || a.id - b.id)[0];

  return (weak && due.find(inWeak)) || due[0] || (weak && fresh.find(inWeak)) || fresh[0] || leastRecent();
}

// QUIZ requests served today (local day). Pushes don't count.
export function quizCountToday(db, studentId, now) {
  const [start, end] = localDay(now);
  return db
    .prepare("SELECT COUNT(*) AS n FROM sessions WHERE student_id = ? AND origin = 'quiz' AND started_at >= ? AND started_at < ?")
    .get(studentId, start, end).n;
}
