// Teacher actions from the dashboard: the doubts inbox, doubt replies and
// broadcasts. Every SMS goes through engine.queueSms() into the outbox.
import { sqlTime } from './practice.js';

const GEMMA_RECENT_MS = 7 * 24 * 60 * 60 * 1000;

export class TeacherError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Doubts waiting for the teacher: open ones, plus maths concept questions
// Gemma answered in the last 7 days (so the teacher can check its answer).
// Oldest first. Student name only, never the phone.
export function listDoubts(db, now) {
  return db
    .prepare(`SELECT d.id, s.name, d.subject, d.text, d.status, d.reply AS gemmaReply, d.created_at
      FROM doubts d JOIN students s ON s.id = d.student_id
      WHERE d.teacher_reply IS NULL
        AND (d.status = 'open' OR (d.reply IS NOT NULL AND d.created_at >= ?))
      ORDER BY d.created_at, d.id`)
    .all(sqlTime(new Date(now.getTime() - GEMMA_RECENT_MS)));
}

// Queues the reply to the student and marks the doubt answered, together.
export function replyToDoubt(db, engine, id, text) {
  const doubt = db
    .prepare('SELECT d.*, s.phone FROM doubts d JOIN students s ON s.id = d.student_id WHERE d.id = ?')
    .get(id);
  if (!doubt) throw new TeacherError(404, 'no such doubt');
  if (doubt.teacher_reply !== null) throw new TeacherError(409, 'this doubt already has a teacher reply');
  return db.transaction(() => {
    const outboxId = engine.queueSms(doubt.phone, text);
    const { body } = db.prepare('SELECT body FROM outbox WHERE id = ?').get(outboxId);
    db.prepare("UPDATE doubts SET status = 'answered', teacher_reply = ? WHERE id = ?").run(body, id);
    return { ok: true, outboxId };
  })();
}

// The same SMS to every student, one outbox row each. All or nothing.
export function broadcast(db, engine, text) {
  const phones = db.prepare('SELECT phone FROM students ORDER BY id').pluck().all();
  return db.transaction(() => {
    for (const phone of phones) engine.queueSms(phone, text);
    return { queued: phones.length };
  })();
}
