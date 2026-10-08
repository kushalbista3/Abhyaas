// The student SMS loop: one incoming SMS in, one reply out.
// Grading is plain code (CLAUDE.md rule 2); every reply goes through
// smsSafe() and the outbox (rule 3); errors fall back to a canned reply (rule 4).
// The local model (llm) only maps free-text replies to a letter and answers
// maths concept questions. Its calls run between DB transactions, since a
// better-sqlite3 transaction can't await.
import { SMS_LIMIT, firstFitting, fitsOneSms, gsmLength, smsSafe, unsafeChars } from './gsm7.js';
import { askModel, computeReply, isComputeRequest, isScienceQuestion, topicOf } from './llm/ask.js';
import { localLetter, modelLetter } from './llm/parse-reply.js';
import {
  DAILY_QUIZ_CAP,
  firstTries,
  pickQuestion,
  quizCountToday,
  sqlTime,
  streak,
  weakestTopic,
} from './practice.js';
import { SUBJECTS, SUBJECT_NAMES, TOPIC_CODES, TOPICS_MESSAGE, formatQuestionSms, maskPhone, normalizePhone } from './sms.js';

// English and romanised Nepali (ganit = maths, bigyan/vigyan = science).
const SUBJECT_ALIASES = {
  MATH: 'MATH', MATHS: 'MATH', GANIT: 'MATH',
  SCI: 'SCI', SCIENCE: 'SCI', BIGYAN: 'SCI', VIGYAN: 'SCI',
};
const TOPIC_SUBJECT = Object.fromEntries(SUBJECTS.flatMap((s) => TOPIC_CODES[s].map((code) => [code, s])));
const otherSubject = (s) => SUBJECTS.find((x) => x !== s);

const HELP_BODY =
  'QUIZ=question, TOPICS=topic list, SUBJECT=Maths/Science, ASK <question>=ask teacher, SCORE=progress. Reply A/B/C/D to answer.';

export const REPLIES = {
  notJoined: 'Welcome to Abhyaas SEE practice! To start, send JOIN and your name, e.g. JOIN Sita',
  joinUsage: 'Send JOIN and your name, e.g. JOIN Sita',
  joinLetters: 'Please send your name in English letters, e.g. JOIN Sita',
  error: 'Sorry, something went wrong. Please try again or send HELP.',
  noPending: 'No question waiting. Send QUIZ for a new one.',
  cap: `You have done ${DAILY_QUIZ_CAP} questions today. Great work! Come back tomorrow.`,
  hint: 'Not quite. Check each step of your working and try again. Reply A/B/C/D',
  askUsage: 'Send ASK and your question, e.g. ASK what is a prime factor?',
  askTeacher: 'Your question was sent to your teacher.',
  askScience: 'Your question was sent to your teacher. Try QUIZ SCI meanwhile.',
  whichOption: (id) => `Reply A/B/C/D to answer Q${id}.`,
  unknownSubject: 'Unknown subject. Send SUBJECT MATH or SUBJECT SCI.',
  unknown: 'Sorry, I did not understand. Send HELP for commands.',
};

// A teacher's text that can't go out as one GSM-7 SMS (shown back as a 400).
export class SmsTextError extends Error {}

export const helpMessage = (subject) => `Abhyaas ${SUBJECT_NAMES[subject]}: ${HELP_BODY}`;

const welcomeMessage = (name) =>
  firstFitting(`Welcome ${name}! ${HELP_BODY}`, `Welcome ${name.split(' ')[0]}! ${HELP_BODY}`, `Welcome! ${HELP_BODY}`);

// Letters, spaces and . ' - only; "  sita   gurung " -> "sita gurung".
const cleanName = (raw) => raw.replace(/[^A-Za-z .'-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30).trim();

// llm: createLlm() from ./llm/client.js, or null (tests, no model): every
// model step then takes its canned fallback.
export function createSmsEngine(db, { now = () => new Date(), llm = null } = {}) {
  const q = {
    studentByPhone: db.prepare('SELECT * FROM students WHERE phone = ?'),
    studentById: db.prepare('SELECT * FROM students WHERE id = ?'),
    insertStudent: db.prepare("INSERT INTO students (phone, name, class, created_at) VALUES (?, ?, '10', ?)"),
    setSubject: db.prepare('UPDATE students SET current_subject = ? WHERE id = ?'),
    question: db.prepare('SELECT * FROM questions WHERE id = ?'),
    pending: db.prepare(`
      SELECT s.id, s.current_question_id AS question_id, q.subject
      FROM sessions s JOIN questions q ON q.id = s.current_question_id
      WHERE s.student_id = ? AND s.state = 'active' ORDER BY s.id DESC LIMIT 1`),
    startSession: db.prepare(
      'INSERT INTO sessions (student_id, topic, current_question_id, origin, started_at) VALUES (?, ?, ?, ?, ?)',
    ),
    endSessions: db.prepare("UPDATE sessions SET state = 'ended', ended_at = ? WHERE student_id = ? AND state = 'active'"),
    attemptCount: db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE session_id = ?'),
    insertAttempt: db.prepare(`INSERT INTO attempts (student_id, question_id, session_id, chosen_option, is_correct, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`),
    explanation: db.prepare(`SELECT text FROM explanations
      WHERE question_id = ? AND option = ? AND status = 'approved' ORDER BY id DESC LIMIT 1`),
    insertDoubt: db.prepare('INSERT INTO doubts (student_id, subject, text, status, reply, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    lastMathTopic: db.prepare(`SELECT q.topic FROM sessions s JOIN questions q ON q.id = s.current_question_id
      WHERE s.student_id = ? AND q.subject = 'MATH' ORDER BY s.id DESC LIMIT 1`),
    logMessage: db.prepare('INSERT INTO messages (student_id, phone, direction, body, created_at) VALUES (?, ?, ?, ?, ?)'),
    queue: db.prepare('INSERT INTO outbox (phone, body, status, created_at, sent_at) VALUES (?, ?, ?, ?, ?)'),
  };

  const setSubject = (student, subject) => {
    q.setSubject.run(subject, student.id);
    student.current_subject = subject;
  };

  // Picks and records the next question, ending any pending one. null if none.
  function serve(student, subject, { topic = null, origin, t }) {
    const pending = q.pending.get(student.id);
    const question = pickQuestion(db, student.id, subject, { topic, now: t, excludeId: pending?.question_id });
    if (!question) return null;
    q.endSessions.run(sqlTime(t), student.id);
    q.startSession.run(student.id, question.topic, question.id, origin, sqlTime(t));
    return question;
  }

  function join(phone, arg, t) {
    if (!arg) return REPLIES.joinUsage;
    const name = cleanName(arg);
    if (!name) return REPLIES.joinLetters;
    q.insertStudent.run(phone, name, sqlTime(t));
    return welcomeMessage(name);
  }

  function subjectCommand(student, arg) {
    const current = student.current_subject;
    if (!arg) {
      const other = otherSubject(current);
      return `Your subject is ${SUBJECT_NAMES[current]}. Send SUBJECT ${other} to switch to ${SUBJECT_NAMES[other]}.`;
    }
    const subject = SUBJECT_ALIASES[arg.toUpperCase()];
    if (!subject) return REPLIES.unknownSubject;
    setSubject(student, subject);
    return `Subject is now ${SUBJECT_NAMES[subject]}. Send QUIZ for a question or TOPICS for topics.`;
  }

  // QUIZ, QUIZ MATH|SCI, QUIZ <code> and a bare <code>.
  function quiz(student, arg, t) {
    let subject = student.current_subject;
    let topic = null;
    if (arg) {
      if (SUBJECT_ALIASES[arg]) subject = SUBJECT_ALIASES[arg];
      else if (TOPIC_SUBJECT[arg]) [topic, subject] = [arg, TOPIC_SUBJECT[arg]];
      else return `Unknown topic. ${TOPICS_MESSAGE[subject]}`;
      if (subject !== student.current_subject) setSubject(student, subject);
    }

    // Plain QUIZ with a question still waiting re-sends it (e.g. a lost SMS).
    const pending = q.pending.get(student.id);
    if (!arg && pending?.subject === subject) return formatQuestionSms(q.question.get(pending.question_id));

    if (quizCountToday(db, student.id, t) >= DAILY_QUIZ_CAP) return REPLIES.cap;
    const question = serve(student, subject, { topic, origin: 'quiz', t });
    if (question) return formatQuestionSms(question);
    if (topic) return `No approved ${topic} questions yet. Send TOPICS for other topics or QUIZ for any.`;
    const other = otherSubject(subject);
    return `No approved ${SUBJECT_NAMES[subject]} questions yet. Your teacher is reviewing them. Send SUBJECT ${other} for ${SUBJECT_NAMES[other]}.`;
  }

  function answer(student, letter, t) {
    const pending = q.pending.get(student.id);
    if (!pending) return REPLIES.noPending;
    const question = q.question.get(pending.question_id);
    const earlier = q.attemptCount.get(pending.id).n;
    const correct = letter === question.correct_option;
    q.insertAttempt.run(student.id, question.id, pending.id, letter, correct ? 1 : 0, sqlTime(t));
    const { solution } = question;
    const next = 'Send QUIZ for next.';

    if (correct) {
      q.endSessions.run(sqlTime(t), student.id);
      const head =
        earlier === 0
          ? `Correct! ${SUBJECT_NAMES[question.subject]} streak: ${streak(firstTries(db, student.id, question.subject))}.`
          : 'Correct on your 2nd try!';
      return firstFitting(`${head} ${solution} ${next}`, `${head} ${solution}`, `${head} ${next}`);
    }

    if (earlier === 0) {
      // First wrong try: the approved explanation for this option, or a
      // generic hint. Never the solution or the right answer.
      const raw = q.explanation.get(question.id, letter)?.text;
      if (!raw || raw.includes(solution)) return REPLIES.hint;
      const text = smsSafe(raw, Infinity);
      const tail = 'Try again: reply A/B/C/D';
      return firstFitting(
        `Not quite. ${text} ${tail}`,
        `${text} ${tail}`,
        `${smsSafe(text, SMS_LIMIT - 1 - gsmLength(tail))} ${tail}`,
      );
    }

    // Second wrong try: reveal the answer and move on.
    q.endSessions.run(sqlTime(t), student.id);
    const right = question.correct_option;
    const option = question[`option_${right.toLowerCase()}`];
    return firstFitting(
      `Not quite. Answer: ${right}) ${option}. ${solution} ${next}`,
      `Answer: ${right}) ${option}. ${solution} ${next}`,
      `Answer: ${right}) ${option}. ${solution}`,
      `Answer: ${right}. ${solution}`,
    );
  }

  // Both subjects in one SMS: "Maths: 1/2 (50%) streak 1. Science: 0/0. Today 2/20."
  // First tries only. The current subject's weakest topic is added if it fits.
  function score(student, t) {
    let weak = null;
    const parts = SUBJECTS.map((subject) => {
      const tries = firstTries(db, student.id, subject);
      const name = SUBJECT_NAMES[subject];
      if (subject === student.current_subject) weak = weakestTopic(tries, subject);
      if (!tries.length) return `${name}: 0/0.`;
      const right = tries.filter((x) => x.is_correct).length;
      const pct = Math.round((100 * right) / tries.length);
      return `${name}: ${right}/${tries.length} (${pct}%) streak ${streak(tries)}.`;
    });
    const core = `${parts.join(' ')} Today ${quizCountToday(db, student.id, t)}/${DAILY_QUIZ_CAP}.`;
    return weak ? firstFitting(`${core} Practise ${weak}.`, core) : core;
  }

  // Every ASK is saved as a doubt for the teacher. Science never reaches the
  // model (rule 8), nor do maths sums; a maths concept question returns a
  // model step that finish() runs.
  function ask(student, text, t) {
    if (!text) return REPLIES.askUsage;
    if (student.current_subject === 'SCI' || isScienceQuestion(text)) {
      q.insertDoubt.run(student.id, 'SCI', text, 'open', null, sqlTime(t));
      return REPLIES.askScience;
    }
    if (isComputeRequest(text)) {
      q.insertDoubt.run(student.id, 'MATH', text, 'open', null, sqlTime(t));
      return computeReply(topicOf(text) ?? q.lastMathTopic.get(student.id)?.topic);
    }
    return { ask: { studentId: student.id, text } };
  }

  // The model half of a reply, outside any transaction, then back in one.
  async function finish(step, t) {
    if (step.ask) {
      const { studentId, text } = step.ask;
      const reply = await askModel(llm, text);
      // Answered doubts keep the model's reply so the teacher can see it.
      q.insertDoubt.run(studentId, 'MATH', text, reply ? 'answered' : 'open', reply, sqlTime(t));
      return reply ?? REPLIES.askTeacher;
    }
    const { studentId, sessionId, question, text } = step.parse;
    const letter = await modelLetter(llm, question, text);
    return db.transaction(() => {
      // Another SMS (e.g. QUIZ) may have changed the question meanwhile.
      const pending = q.pending.get(studentId);
      if (!pending) return REPLIES.noPending;
      if (pending.id !== sessionId || !letter) return REPLIES.whichOption(pending.question_id);
      return answer(q.studentById.get(studentId), letter, t);
    })();
  }

  function route(phone, body, t) {
    const words = body.trim().split(/\s+/).filter(Boolean);
    const command = (words[0] ?? '').toUpperCase();
    const arg = words.slice(1).join(' ');

    const student = q.studentByPhone.get(phone);
    if (!student) return command === 'JOIN' ? join(phone, arg, t) : REPLIES.notJoined;

    const letter = body.trim().toUpperCase().match(/^([A-D])[.)]?$/)?.[1];
    if (letter) return answer(student, letter, t);

    switch (command) {
      case 'JOIN':
        return `You are already joined as ${student.name}. Send HELP for commands.`;
      case 'HELP':
        return helpMessage(student.current_subject);
      case 'SUBJECT':
        return subjectCommand(student, arg);
      case 'TOPICS':
        return TOPICS_MESSAGE[student.current_subject];
      case 'QUIZ':
        return quiz(student, arg.toUpperCase(), t);
      case 'SCORE':
        return score(student, t);
      case 'ASK':
        return ask(student, arg, t);
    }
    // TOPICS says "Reply a code", so a bare topic code is QUIZ <code>.
    if (TOPIC_SUBJECT[command] && !arg) return quiz(student, command, t);
    // A bare subject word ("SCI", "ganit") is SUBJECT <word>.
    if (SUBJECT_ALIASES[command] && !arg) return subjectCommand(student, command);

    // Free text with a question waiting: "b ho", "mero answer c", "2034", else the model.
    const pending = q.pending.get(student.id);
    if (!pending) return REPLIES.unknown;
    const question = q.question.get(pending.question_id);
    const meant = localLetter(body, question);
    if (meant) return answer(student, meant, t);
    return { parse: { studentId: student.id, sessionId: pending.id, question, text: body.trim() } };
  }

  // Logs to messages and outbox. status 'sent' when the reply goes back in
  // the HTTP response; 'queued' for pushes the gateway picks up later.
  function send(phone, body, status, t) {
    if (!fitsOneSms(body)) throw new Error('reply does not fit one SMS');
    const studentId = q.studentByPhone.get(phone)?.id ?? null;
    return db.transaction(() => {
      q.logMessage.run(studentId, phone, 'out', body, sqlTime(t));
      return Number(q.queue.run(phone, body, status, sqlTime(t), status === 'sent' ? sqlTime(t) : null).lastInsertRowid);
    })();
  }

  const report = (phone, err) => console.error(`SMS ${maskPhone(phone)}: ${err.message}`);

  // One incoming SMS -> { reply, outboxId }. outboxId is the reply's outbox
  // row (null if logging it failed), so the gateway can report delivery.
  async function receive(rawPhone, rawBody) {
    const t = now();
    const phone = normalizePhone(rawPhone);
    const body = String(rawBody ?? '');
    if (!phone) return { reply: REPLIES.error, outboxId: null };
    try {
      q.logMessage.run(q.studentByPhone.get(phone)?.id ?? null, phone, 'in', body, sqlTime(t));
    } catch (err) {
      report(phone, err);
    }
    let reply;
    try {
      // A string, or a model step to finish outside the transaction.
      const result = db.transaction(() => route(phone, body, t))();
      reply = typeof result === 'string' ? result : await finish(result, t);
    } catch (err) {
      report(phone, err);
      reply = REPLIES.error;
    }
    reply = smsSafe(reply);
    let outboxId = null;
    try {
      outboxId = send(phone, reply, 'sent', t);
    } catch (err) {
      report(phone, err);
    }
    return { reply, outboxId };
  }

  const handleIncomingSms = async (phone, body) => (await receive(phone, body)).reply;

  // A question the server sends unasked (e.g. a daily push). It is queued in
  // the outbox and does not count toward the daily QUIZ cap. With a topic the
  // question comes from that topic (and its subject); otherwise the student's
  // subject in the usual QUIZ order. null if there is no approved question.
  function pushQuestion(studentId, { topic = null } = {}) {
    const t = now();
    const student = q.studentById.get(studentId);
    if (!student) return null;
    const subject = topic ? TOPIC_SUBJECT[topic] : student.current_subject;
    if (!subject) throw new Error(`unknown topic ${topic}`);
    const question = db.transaction(() => serve(student, subject, { topic, origin: 'push', t }))();
    if (!question) return null;
    const body = smsSafe(formatQuestionSms(question));
    send(student.phone, body, 'queued', t);
    return body;
  }

  // A teacher's own SMS (doubt reply, broadcast), queued for the gateway.
  // Look-alikes (smart quotes) are swapped, but it is never cut or stripped:
  // text that is empty, not GSM-7 or over 160 throws, so the teacher can fix it.
  function queueSms(phone, text) {
    const bad = unsafeChars(text);
    if (bad.length) throw new SmsTextError(`has characters an SMS can't send: ${bad.join(' ')}`);
    const body = smsSafe(text, Infinity);
    if (!body) throw new SmsTextError('message is empty');
    if (!fitsOneSms(body)) throw new SmsTextError(`message is ${gsmLength(body)} chars, max ${SMS_LIMIT}`);
    return send(phone, body, 'queued', now());
  }

  return { receive, handleIncomingSms, pushQuestion, queueSms };
}
