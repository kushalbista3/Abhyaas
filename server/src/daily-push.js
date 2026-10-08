// One question per student per day at DAILY_PUSH_TIME, from each student's
// weakest topic (or a topic the teacher picked), queued in the outbox via
// engine.pushQuestion(). "Send now" on the dashboard runs the same push.
// Settings live in the settings table: push_topic (unset = weakest topic)
// and last_daily_push (local YYYY-MM-DD, so a day is pushed at most once).
import { firstTries, weakestTopic } from './practice.js';
import { TOPIC_CODES, maskPhone } from './sms.js';

const CHECK_MS = 30_000;
const ALL_TOPICS = Object.values(TOPIC_CODES).flat();

// "7:05" / "07:05" -> { hours: 7, minutes: 5, text: '07:05' }; anything else null.
export function parsePushTime(text) {
  const m = String(text ?? '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  return { hours, minutes, text: `${String(hours).padStart(2, '0')}:${m[2]}` };
}

const localDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function createDailyPush(db, engine, { now = () => new Date(), time = '' } = {}) {
  const at = parsePushTime(time);
  const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?').pluck();
  const putSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const delSetting = db.prepare('DELETE FROM settings WHERE key = ?');

  const topic = () => getSetting.get('push_topic') ?? null;

  function setTopic(code) {
    if (code === null || code === undefined || code === '') return delSetting.run('push_topic'), status();
    if (!ALL_TOPICS.includes(code)) throw new Error(`unknown topic ${code}`);
    putSetting.run('push_topic', code);
    return status();
  }

  // One question per student. A student whose weakest topic has no approved
  // question gets the usual QUIZ pick instead. One failure never stops the rest.
  function sendNow() {
    const override = topic();
    let queued = 0;
    let skipped = 0;
    for (const s of db.prepare('SELECT id, phone, current_subject FROM students ORDER BY id').all()) {
      try {
        const weak = override ?? weakestTopic(firstTries(db, s.id, s.current_subject), s.current_subject);
        const body = engine.pushQuestion(s.id, { topic: weak }) ?? (override ? null : engine.pushQuestion(s.id));
        if (body) queued++;
        else skipped++;
      } catch (err) {
        skipped++;
        console.error(`Daily push ${maskPhone(s.phone)}: ${err.message}`);
      }
    }
    return { queued, skipped };
  }

  // Pushes once per local day, at or after the push time. The day is marked
  // first, so a crash mid-push never sends it twice.
  function runIfDue() {
    if (!at) return null;
    const t = now();
    if (t.getHours() * 60 + t.getMinutes() < at.hours * 60 + at.minutes) return null;
    const today = localDate(t);
    if (getSetting.get('last_daily_push') === today) return null;
    putSetting.run('last_daily_push', today);
    const result = sendNow();
    console.log(`Daily push: ${result.queued} question(s) queued, ${result.skipped} skipped.`);
    return result;
  }

  function status() {
    return { time: at?.text ?? null, topic: topic(), lastPushDate: getSetting.get('last_daily_push') ?? null };
  }

  function start() {
    if (time && !at) console.warn(`DAILY_PUSH_TIME "${time}" is not HH:MM (24h); the daily push is off.`);
    if (!at) return null;
    const check = () => {
      try {
        runIfDue();
      } catch (err) {
        console.error(`Daily push: ${err.message}`);
      }
    };
    check();
    const timer = setInterval(check, CHECK_MS);
    timer.unref();
    return timer;
  }

  return { sendNow, runIfDue, status, setTopic, start };
}
