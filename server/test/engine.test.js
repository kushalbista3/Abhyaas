import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { seed } from '../src/seed.js';
import { createSmsEngine, helpMessage, REPLIES } from '../src/engine.js';
import { createApp } from '../src/app.js';
import { fitsOneSms } from '../src/gsm7.js';
import { DAILY_QUIZ_CAP, sqlTime, weakestTopic } from '../src/practice.js';
import { TOPICS_MESSAGE } from '../src/sms.js';

const PHONE = '9811111111';
const DAY = 24 * 60 * 60 * 1000;

// Fresh in-memory DB, a fake clock (local noon) and a send() helper.
function setup({ bank = false } = {}) {
  const db = openDb(':memory:');
  if (bank) seed(db);
  const clock = { t: new Date(2026, 9, 8, 12, 0, 0) };
  const engine = createSmsEngine(db, { now: () => new Date(clock.t) });
  const send = (body, phone = PHONE) => engine.handleIncomingSms(phone, body);
  const studentId = (phone = PHONE) => db.prepare('SELECT id FROM students WHERE phone = ?').get(phone)?.id;
  return { db, clock, engine, send, studentId };
}

let qn = 0;
function addQ(db, { subject = 'MATH', topic = 'HCF', correct = 'A', status = 'approved', solution } = {}) {
  qn++;
  return db
    .prepare(`INSERT INTO questions (subject, topic, stem, option_a, option_b, option_c, option_d, correct_option,
      solution, misconceptions, source, status) VALUES (?, ?, ?, 'w', 'x', 'y', 'z', ?, ?, '{}', 'seed', ?)`)
    .run(subject, topic, `${topic} stem ${qn}`, correct, solution ?? `SOLUTION-${qn} =1`, status).lastInsertRowid;
}

// A past serving of question qid with its first try right or wrong, at time `at`.
function history(db, studentId, qid, correct, at) {
  const when = sqlTime(at);
  const sid = db
    .prepare("INSERT INTO sessions (student_id, current_question_id, state, started_at) VALUES (?, ?, 'ended', ?)")
    .run(studentId, qid, when).lastInsertRowid;
  const { correct_option: right } = db.prepare('SELECT correct_option FROM questions WHERE id = ?').get(qid);
  const chosen = correct ? right : right === 'A' ? 'B' : 'A';
  db.prepare('INSERT INTO attempts (student_id, question_id, session_id, chosen_option, is_correct, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(studentId, qid, sid, chosen, correct ? 1 : 0, when);
}

// Make question qid the one waiting for this student's answer.
function pose(db, studentId, qid) {
  db.prepare("UPDATE sessions SET state = 'ended' WHERE student_id = ?").run(studentId);
  db.prepare('INSERT INTO sessions (student_id, current_question_id) VALUES (?, ?)').run(studentId, qid);
}

const servedId = (reply) => Number(reply.match(/^Q(\d+) /)?.[1]) || null;
const question = (db, id) => db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
const rightLetter = (db, id) => question(db, id).correct_option;
const wrongLetter = (db, id) => (rightLetter(db, id) === 'A' ? 'B' : 'A');

test('unknown numbers are asked to JOIN; JOIN registers and welcomes', async () => {
  const { db, send, studentId } = setup();
  for (const m of ['HELP', 'QUIZ', 'A', 'SCORE', 'hello']) assert.equal(await send(m), REPLIES.notJoined);
  assert.equal(await send('JOIN'), REPLIES.joinUsage);
  assert.equal(await send('JOIN अभ्यास'), REPLIES.joinLetters);
  assert.equal(studentId(), undefined);

  const welcome = await send('join  Sita   Gurung');
  assert.match(welcome, /^Welcome Sita Gurung!/);
  assert.deepEqual(db.prepare('SELECT name, class, current_subject FROM students').get(), {
    name: 'Sita Gurung', class: '10', current_subject: 'MATH',
  });
  assert.match(await send('JOIN Other'), /already joined as Sita Gurung/);
  // +977 and local forms are the same student.
  assert.equal(await send('HELP', '+977 981-1111111'), helpMessage('MATH'));
});

test('welcome and HELP list every command in one SMS', async () => {
  const { send } = setup();
  const welcome = await send('JOIN Sita');
  for (const reply of [welcome, await send('HELP'), helpMessage('SCI')]) {
    assert.ok(fitsOneSms(reply), reply);
    for (const cmd of ['QUIZ', 'TOPICS', 'SUBJECT', 'ASK <question>', 'SCORE']) assert.ok(reply.includes(cmd), `${cmd} in ${reply}`);
  }
});

test('grading is by code: correct letter, case and punctuation tolerated', async () => {
  const { db, send, studentId } = setup();
  const id = addQ(db, { correct: 'C' });
  await send('JOIN Sita');
  assert.equal(await send('C'), 'No question waiting. Send QUIZ for a new one.');
  assert.equal(servedId(await send('QUIZ')), id);
  assert.match(await send(' c) '), /^Correct! Maths streak: 1\./);
  assert.deepEqual(db.prepare('SELECT chosen_option, is_correct FROM attempts').all(), [{ chosen_option: 'C', is_correct: 1 }]);
  assert.equal(await send('C'), REPLIES.noPending, 'the question is closed');

  pose(db, studentId(), id);
  await send('b.');
  assert.deepEqual(db.prepare('SELECT chosen_option, is_correct FROM attempts ORDER BY id DESC').get(), { chosen_option: 'B', is_correct: 0 });
});

test('first wrong answer never reveals the solution (every approved seed question, every wrong letter)', async () => {
  const { db, send, studentId } = setup({ bank: true });
  db.prepare("UPDATE questions SET status = 'approved'").run();
  await send('JOIN Sita');
  const sid = studentId();
  for (const q of db.prepare('SELECT * FROM questions').all()) {
    for (const letter of ['A', 'B', 'C', 'D'].filter((l) => l !== q.correct_option)) {
      pose(db, sid, q.id);
      const reply = await send(letter);
      assert.equal(reply, REPLIES.hint, `Q${q.id} ${letter}`);
      assert.ok(!reply.includes(q.solution));
    }
  }
});

test('first wrong answer uses only an approved explanation for that option', async () => {
  const { db, send, studentId } = setup();
  const id = addQ(db, { correct: 'A' });
  const addExp = (option, text, status) =>
    db.prepare("INSERT INTO explanations (question_id, option, text, status, model) VALUES (?, ?, ?, ?, 'gemma')").run(id, option, text, status);
  addExp('B', 'You added instead of multiplying.', 'approved');
  addExp('C', 'DRAFT text not checked by a teacher.', 'draft');
  addExp('D', `Leaks it: ${question(db, id).solution}`, 'approved');
  await send('JOIN Sita');
  const sid = studentId();

  pose(db, sid, id);
  assert.equal(await send('B'), 'Not quite. You added instead of multiplying. Try again: reply A/B/C/D');
  pose(db, sid, id);
  assert.equal(await send('C'), REPLIES.hint, 'draft explanation is never sent');
  pose(db, sid, id);
  assert.equal(await send('D'), REPLIES.hint, 'an explanation containing the solution is never sent');
});

test('second wrong answer reveals the answer with the solution and moves on', async () => {
  const { db, send, studentId } = setup({ bank: true });
  await send('JOIN Sita');
  const sid = studentId();
  for (const q of db.prepare("SELECT * FROM questions WHERE status = 'approved'").all()) {
    pose(db, sid, q.id);
    await send(wrongLetter(db, q.id));
    const reply = await send(wrongLetter(db, q.id));
    assert.ok(reply.includes(`Answer: ${q.correct_option}`), reply);
    assert.ok(reply.includes(q.solution), reply);
    assert.ok(fitsOneSms(reply), reply);
    assert.equal(await send('A'), REPLIES.noPending, 'session ended');
  }

  // Right on the second try: no streak, and the streak is broken.
  pose(db, sid, 1);
  await send(wrongLetter(db, 1));
  assert.match(await send(rightLetter(db, 1)), /^Correct on your 2nd try!/);
  assert.match(await send('SCORE'), /^Maths: \d+\/\d+ \(\d+%\) streak 0\./);
});

test('subjects: SUBJECT, TOPICS, QUIZ <subject>, QUIZ <code>, per-subject SCORE and streak', async () => {
  const { db, send } = setup({ bank: true });
  db.prepare("UPDATE questions SET status = 'approved'").run();
  await send('JOIN Sita');
  const subjectOf = (reply) => question(db, servedId(reply)).subject;

  assert.match(await send('SUBJECT'), /^Your subject is Maths\. Send SUBJECT SCI/);
  assert.equal(await send('TOPICS'), TOPICS_MESSAGE.MATH);
  assert.equal(await send('SUBJECT history'), REPLIES.unknownSubject);
  assert.match(await send('subject science'), /^Subject is now Science\./);
  assert.equal(await send('TOPICS'), TOPICS_MESSAGE.SCI);
  assert.match(await send('HELP'), /^Abhyaas Science:/);

  let reply = await send('QUIZ');
  assert.equal(subjectOf(reply), 'SCI');
  assert.match(await send(rightLetter(db, servedId(reply))), /^Correct! Science streak: 1\./);

  reply = await send('QUIZ MATH');
  assert.equal(subjectOf(reply), 'MATH');
  assert.match(await send('SUBJECT'), /Your subject is Maths/);
  assert.match(await send(wrongLetter(db, servedId(reply))), /^Not quite/);

  // A topic code from the other subject switches subject; a bare code works too.
  reply = await send('QUIZ PHY');
  assert.equal(question(db, servedId(reply)).topic, 'PHY');
  assert.match(await send(rightLetter(db, servedId(reply))), /Science streak: 2\./);
  reply = await send('pct');
  assert.equal(question(db, servedId(reply)).topic, 'PCT');
  assert.match(await send(rightLetter(db, servedId(reply))), /Maths streak: 1\./);

  assert.equal(await send('SCORE'), 'Maths: 1/2 (50%) streak 1. Science: 2/2 (100%) streak 2. Today 4/20.');
});

test('a bare subject word switches subject (English or romanised Nepali)', async () => {
  const { db, send } = setup();
  await send('JOIN Sita');
  const current = () => db.prepare('SELECT current_subject FROM students').get().current_subject;
  const toScience = 'Subject is now Science. Send QUIZ for a question or TOPICS for topics.';
  const toMaths = 'Subject is now Maths. Send QUIZ for a question or TOPICS for topics.';
  assert.ok(fitsOneSms(toScience) && fitsOneSms(toMaths));

  for (const [word, reply, subject] of [
    ['SCI', toScience, 'SCI'], ['GANIT', toMaths, 'MATH'], ['science', toScience, 'SCI'], ['maths', toMaths, 'MATH'],
    ['Bigyan', toScience, 'SCI'], ['Math', toMaths, 'MATH'], [' VIGYAN ', toScience, 'SCI'], ['ganit', toMaths, 'MATH'],
  ]) {
    assert.equal(await send(word), reply, word);
    assert.equal(current(), subject, word);
  }
  // The new words also work after SUBJECT and QUIZ.
  assert.equal(await send('SUBJECT bigyan'), toScience);
  await send('QUIZ ganit');
  assert.equal(current(), 'MATH');
  // Only the bare word: anything after it is not a switch.
  assert.equal(await send('SCI please'), REPLIES.unknown);
  assert.equal(current(), 'MATH');
  // Unregistered numbers still only get the JOIN prompt.
  assert.equal(await send('SCI', '9800000099'), REPLIES.notJoined);
});

test('SCORE shows both subjects in one SMS', async () => {
  const { db, send, studentId } = setup();
  const [h1] = [addQ(db, { topic: 'HCF', correct: 'A' }), addQ(db, { topic: 'HCF', correct: 'A' })];
  const sci = addQ(db, { subject: 'SCI', topic: 'PHY', correct: 'B' });
  await send('JOIN Sita');
  assert.equal(await send('SCORE'), 'Maths: 0/0. Science: 0/0. Today 0/20.');

  assert.equal(servedId(await send('QUIZ')), h1);
  await send('A');
  await send('QUIZ');
  await send('B');
  await send('B');
  // HCF has 2 first tries at 50%, so it is the weakest maths topic.
  assert.equal(await send('SCORE'), 'Maths: 1/2 (50%) streak 0. Science: 0/0. Today 2/20. Practise HCF.');

  // Same order whichever subject is current; the tip follows the current subject.
  await send('SCI');
  assert.equal(servedId(await send('QUIZ')), sci);
  await send('B');
  assert.equal(await send('SCORE'), 'Maths: 1/2 (50%) streak 0. Science: 1/1 (100%) streak 1. Today 3/20.');

  // Four-digit counts still fit one SMS.
  const sid = studentId();
  const long = new Date(2026, 0, 1);
  db.transaction(() => {
    for (let i = 0; i < 1200; i++) {
      history(db, sid, h1, true, long); // 4-digit streak too
      history(db, sid, sci, i % 10 !== 0, long);
    }
  })();
  const reply = await send('SCORE');
  assert.match(reply, /^Maths: \d{4}\/\d{4} \(\d+%\) streak \d{4}\. Science: \d{4}\/\d{4} \(\d+%\) streak \d+\. Today 3\/20\. Practise PHY\.$/);
  assert.ok(fitsOneSms(reply), reply);
});

test('unknown topic gets the fixed reply plus that subject\'s list', async () => {
  const { db, send } = setup();
  addQ(db);
  await send('JOIN Sita');
  assert.equal(await send('QUIZ TRIG'), `Unknown topic. ${TOPICS_MESSAGE.MATH}`);
  await send('SUBJECT SCI');
  assert.equal(await send('quiz xyz'), `Unknown topic. ${TOPICS_MESSAGE.SCI}`);
  assert.equal(await send('SUBJECT'), 'Your subject is Science. Send SUBJECT MATH to switch to Maths.', 'subject unchanged');
});

test('weakest topic: first tries only, at least 2 tries, 100% is never weakest', () => {
  const tries = (topic, ...results) => results.map((is_correct) => ({ topic, is_correct }));
  assert.equal(weakestTopic([], 'MATH'), null);
  assert.equal(weakestTopic(tries('HCF', 1, 1, 1), 'MATH'), null, '100% is never weakest');
  assert.equal(weakestTopic(tries('ALG', 0), 'MATH'), null, 'one try is not enough');
  assert.equal(weakestTopic([...tries('HCF', 1, 1), ...tries('PCT', 1, 0), ...tries('ALG', 0)], 'MATH'), 'PCT');
  assert.equal(weakestTopic([...tries('PCT', 1, 0, 1, 0), ...tries('ALG', 1, 0)], 'MATH'), 'PCT', 'tie: more tries');
  assert.equal(weakestTopic([...tries('PCT', 1, 0, 1), ...tries('ALG', 1, 0)], 'MATH'), 'ALG');
});

test('adaptive QUIZ order: due review in weakest, any due review, new in weakest, next new', async () => {
  const { db, clock, send, studentId } = setup();
  const [h1, h2, h3] = [addQ(db, { topic: 'HCF' }), addQ(db, { topic: 'HCF' }), addQ(db, { topic: 'HCF' })];
  const [p1, p2, p3, p4] = [1, 2, 3, 4].map(() => addQ(db, { topic: 'PCT', correct: 'B' }));
  const [a1] = [addQ(db, { topic: 'ALG', correct: 'C' }), addQ(db, { topic: 'ALG', correct: 'C' })];
  addQ(db, { topic: 'GEO', correct: 'D' });
  await send('JOIN Sita');
  const sid = studentId();
  const ago = (days) => new Date(clock.t.getTime() - days * DAY);
  history(db, sid, h1, true, ago(5)); // HCF 2/2: 100%, never weakest
  history(db, sid, h2, true, ago(5));
  history(db, sid, p2, true, ago(5)); // PCT 1/3: weakest
  history(db, sid, p1, false, ago(3)); //   due
  history(db, sid, p3, false, ago(1)); //   wrong but not due yet
  history(db, sid, a1, false, ago(4)); // ALG 0/1: too few tries; oldest due review

  const quiz = async () => servedId(await send('QUIZ'));
  assert.equal(await quiz(), p1, '1. due review in the weakest topic beats an older due review');
  await send('B');
  assert.equal(await quiz(), a1, '2. any due review; p3 is not due yet');
  await send('C'); // ALG 1/2 = 50% ties PCT 2/4; PCT has more tries so stays weakest
  assert.equal(await quiz(), p4, '3. new question in the weakest topic');
  await send('A');
  await send('A'); // PCT 2/5
  assert.equal(await quiz(), h3, '4. next new question (lowest id)');
  await send('A');

  clock.t = new Date(clock.t.getTime() + 2 * DAY);
  assert.equal(await quiz(), p3, 'after 2 days p3 is due (oldest due in weakest)');
  await send('B');
  assert.equal(await quiz(), p4, 'then p4, wrong exactly 2 days ago');
});

test('plain QUIZ re-sends a waiting question without counting it', async () => {
  const { db, send, studentId } = setup();
  addQ(db);
  addQ(db);
  await send('JOIN Sita');
  const first = await send('QUIZ');
  assert.equal(await send('QUIZ'), first);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE student_id = ?').get(studentId()).n, 1);
  // An explicit QUIZ <code> skips to a different question.
  assert.notEqual(servedId(await send('QUIZ HCF')), servedId(first));
});

test(`daily cap: ${DAILY_QUIZ_CAP} QUIZ requests per local day; pushes don't count`, async () => {
  const { db, clock, engine, send, studentId } = setup({ bank: true });
  await send('JOIN Sita');
  const sid = studentId();
  let pushed;
  for (let i = 0; i < 3; i++) pushed = engine.pushQuestion(sid);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE status = 'queued'").get().n, 3);
  await send(rightLetter(db, servedId(pushed)));

  for (let i = 0; i < DAILY_QUIZ_CAP; i++) {
    const reply = await send('QUIZ');
    assert.ok(servedId(reply), `request ${i + 1}: ${reply}`);
    assert.equal(await send('QUIZ'), reply, 're-send is free');
    await send(rightLetter(db, servedId(reply)));
  }
  assert.equal(await send('QUIZ'), REPLIES.cap);
  assert.equal(await send('QUIZ PCT'), REPLIES.cap);
  assert.match(await send('SCORE'), new RegExp(`Today ${DAILY_QUIZ_CAP}/${DAILY_QUIZ_CAP}\\.`));

  clock.t = new Date(2026, 9, 8, 23, 59, 0);
  assert.equal(await send('QUIZ'), REPLIES.cap, 'still the same local day');
  clock.t = new Date(2026, 9, 9, 0, 1, 0);
  assert.ok(servedId(await send('QUIZ')), 'a new local day');
});

test('unapproved questions are never sent', async () => {
  const { db, clock, send } = setup({ bank: true });
  const hidden = addQ(db, { topic: 'HCF', status: 'needs-review' });
  await send('JOIN Sita');

  // Two days of full practice: past the 14 new maths questions into reviews and repeats.
  const served = new Set();
  for (let i = 0; i < 2 * DAILY_QUIZ_CAP; i++) {
    if (i === DAILY_QUIZ_CAP) clock.t = new Date(clock.t.getTime() + DAY);
    const id = servedId(await send(i % 3 ? 'QUIZ' : 'QUIZ HCF'));
    served.add(id);
    await send(wrongLetter(db, id));
    await send(wrongLetter(db, id));
  }
  assert.ok(!served.has(hidden));
  for (const id of served) assert.equal(question(db, id).status, 'approved');

  // All science still needs review.
  clock.t = new Date(clock.t.getTime() + DAY);
  await send('SUBJECT SCI');
  for (const m of ['QUIZ', 'QUIZ SCI', 'QUIZ PHY', 'BIO']) assert.equal(servedId(await send(m)), null, m);
  assert.match(await send('QUIZ'), /^No approved Science questions yet/);
  assert.match(await send('QUIZ PHY'), /^No approved PHY questions yet/);

  const phy = db.prepare("SELECT id FROM questions WHERE source_ref = 'seed:PHY-1'").get().id;
  db.prepare("UPDATE questions SET status = 'approved' WHERE id = ?").run(phy);
  assert.equal(servedId(await send('QUIZ')), phy);
  for (const row of db.prepare("SELECT body FROM messages WHERE direction = 'out'").all()) {
    const id = servedId(row.body);
    if (id) assert.equal(question(db, id).status, 'approved', row.body);
  }
});

test('ASK is logged as a doubt in the current subject', async () => {
  const { db, send } = setup();
  await send('JOIN Sita');
  assert.equal(await send('ASK'), REPLIES.askUsage);
  await send('SUBJECT SCI');
  assert.equal(await send('ask Why is the sky blue?'), REPLIES.askScience);
  assert.deepEqual(db.prepare('SELECT subject, text, status FROM doubts').get(), {
    subject: 'SCI', text: 'Why is the sky blue?', status: 'open',
  });
});

test('every message is logged and every reply fits one GSM-7 SMS', async () => {
  const { db, send, studentId } = setup({ bank: true });
  const long = 'x'.repeat(150);
  const id = addQ(db, { correct: 'A', solution: `${'y'.repeat(150)} =1` });
  db.prepare("INSERT INTO explanations (question_id, option, text, status, model) VALUES (?, 'B', ?, 'approved', 'teacher')").run(id, `${long} “smart” – {x}`);

  const script = [
    'hi', `JOIN ${'Verylongname '.repeat(20)}`, 'HELP', 'TOPICS', 'SUBJECT', 'QUIZ', 'QUIZ', 'B', 'B',
    'SUBJECT SCI', 'QUIZ', 'QUIZ ZZZ', 'SUBJECT MATH', `ASK ${long} अभ्यास 👍`, 'SCORE', 'nonsense', '',
  ];
  for (const m of script) await send(m);
  pose(db, studentId(), id);
  const firstWrong = await send('B');
  assert.match(firstWrong, /^x+\.\.\. Try again: reply A\/B\/C\/D$/, 'a long explanation is cut, "Try again" kept');
  for (const m of ['C', 'QUIZ', 'A', 'SCORE']) await send(m);

  const total = script.length + 5;
  const counts = Object.fromEntries(db.prepare('SELECT direction, COUNT(*) AS n FROM messages GROUP BY direction').all().map((r) => [r.direction, r.n]));
  assert.deepEqual(counts, { in: total, out: total });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE status = 'sent'").get().n, total);
  for (const { body } of db.prepare("SELECT body FROM messages WHERE direction = 'out' UNION ALL SELECT body FROM outbox").all()) {
    assert.ok(fitsOneSms(body), body);
  }
});

test('a crash inside the handler still gets a canned reply', async () => {
  const { db, send } = setup();
  await send('JOIN Sita');
  db.exec('DROP TABLE doubts');
  const errors = [];
  const orig = console.error;
  console.error = (m) => errors.push(m);
  try {
    assert.equal(await send('ASK why?'), REPLIES.error);
  } finally {
    console.error = orig;
  }
  assert.ok(errors.length && errors.every((m) => !m.includes(PHONE)), 'phone is masked in logs');
});

test('POST /api/sms/incoming returns {reply}; simulator routes mask phones', async () => {
  const { db, engine } = setup({ bank: true });
  const server = createApp(db, engine).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (payload) =>
    fetch(`${base}/api/sms/incoming`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  try {
    let res = await post({ phone: PHONE, body: 'JOIN Sita' });
    assert.equal(res.status, 200);
    assert.match((await res.json()).reply, /^Welcome Sita!/);
    res = await post({ body: 'HELP' });
    assert.equal(res.status, 400);

    const students = await (await fetch(`${base}/api/sim/students`)).json();
    assert.ok(students.some((s) => s.name === 'Sita' && s.masked === '98******11'));
    const thread = await (await fetch(`${base}/api/sim/thread?phone=${PHONE}`)).json();
    assert.deepEqual(thread.map((m) => m.direction), ['in', 'out']);
  } finally {
    server.close();
  }
});
