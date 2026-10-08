# Abhyaas (अभ्यास)

SEE (Nepal Grade 10) maths and science MCQ practice over SMS for students on keypad phones with no internet. A teacher's laptop runs everything. Students text answers. The server grades them and replies by SMS.

## Hard rules (never break these)

1. **Student runtime is fully offline on one laptop.** Only local Gemma 4 via Ollama, with the model from env `OLLAMA_MODEL`. No cloud calls anywhere in the student SMS path.
2. **Grading is deterministic code.** Compare the reply letter with `questions.correct_option`. The LLM never decides correctness. It may only phrase explanations, using the stored correct answer and misconception.
3. **Every SMS is ≤160 GSM-7 chars.** Extension chars `^ { } [ ] ~ | € \` count as 2. No Devanagari, no emoji, no smart quotes. Always measure with `gsmLength()` in `server/src/gsm7.js`, never with `.length`.
4. **LLM failures fall back to safe canned replies.** Wrap every Ollama call with a timeout and a try/catch that returns a fixed GSM-7 reply. The SMS loop must never crash or go silent.
5. **Store only phone, name and class** for students (plus `current_subject`, a MATH|SCI preference, not personal data). Mask phone numbers on every screen and in logs with `maskPhone()` (`98******01`).
6. **Only teacher-side photo import uses the cloud** (Gemini API via `@google/genai`, model from env `GEMINI_MODEL`). Never log, print or return `GEMINI_API_KEY`.
7. **Imported questions may be copyrighted.** Keep them only in gitignored `server/data/*.local.json` (and the gitignored DB). Never commit them. Only the original questions in `seed-data.js` live in git.
8. **Science facts can't be checked by code.** Science questions and explanations reach students only after a teacher approves them (`status = 'approved'`, via `npm run questions:review`). The model never answers science from its own knowledge: it may only rephrase the approved solution and misconception notes. Anything else gets a canned reply and is logged as a doubt.

## Stack

- `/server`: Node (ESM) + Express 5. Listens on `0.0.0.0` so the SMS gateway phone on the LAN can reach it. Uses SQLite through `better-sqlite3`, the `ollama` client, `@google/genai` and `dotenv` (reads the root `.env`).
- `/client`: React + Vite + recharts (teacher dashboard). Vite proxies `/api` to the server.
- No auth and no Docker. Tests use `node:test` (no test framework dependency).

## Commands (from repo root)

| Command | What it does |
|---|---|
| `npm run dev` | server (`node --watch`) + client (`vite --host`) via concurrently |
| `npm test` | server tests (`node:test`, files in `server/test/`) |
| `npm run seed` | validate and insert the seed questions and demo students, then apply the committed snapshots (idempotent) |
| `npm run demo:reset` | delete the local DB, reseed (teacher approvals come back from the snapshots), then 5 days of demo practice + 2 open doubts |
| `npm run questions:review` | `list [--all]`, `approve <ids>`, `edit <id> [field=value ...]` (no fields opens `$EDITOR`); writes `reviews.json` |
| `npm run explain:generate` | local Gemma drafts explanations for wrong options of approved questions (`--redo` replaces drafts) |
| `npm run explain:review` | `list`, `approve <ids>`, `reject <ids>`, `edit <id or 11B> "<text>"`; writes `explanations.json` |

## Layout

```
server/src/config.js             loads .env; DB_PATH, PORT, OLLAMA_HOST, OLLAMA_MODEL, GEMINI_MODEL, SNAPSHOT_DIR
server/src/db.js                 openDb() + full schema (CREATE IF NOT EXISTS, CHECK constraints) + migrate()
server/src/gsm7.js               gsmLength(), fitsOneSms(), smsSafe(), firstFitting(), SMS_LIMIT
server/src/sms.js                SUBJECTS, TOPICS / TOPIC_CODES / TOPICS_MESSAGE per subject, formatQuestionSms(), maskPhone(), normalizePhone()
server/src/engine.js             createSmsEngine(db, {now, llm}) -> handleIncomingSms(phone, body), pushQuestion(); commands, grading, logging
server/src/practice.js           adaptive QUIZ order, weakest topic, due reviews, streaks, daily cap
server/src/stats.js              dashboard queries per subject: overview, topic accuracy, misconceptions, students
server/src/teacher.js            doubts inbox, replyToDoubt(), broadcast(): all via engine.queueSms()
server/src/daily-push.js         createDailyPush(): DAILY_PUSH_TIME scheduler, topic override, sendNow()
server/src/demo-activity.js      seedDemoActivity(): 5 days of demo SMS through the real engine (demo:reset only)
server/src/app.js                createApp(db, engine, {now, ollamaHost, ollamaModel, push}): /api/sms/incoming, /api/gateway/*, /api/health, /api/sim/*, dashboard routes
server/src/lan.js                lanAddresses(), startupBanner(): LAN IPs + the LAPTOP_URL command printed on startup
server/src/expr.js               safe expression evaluator (no eval) for value comparison
server/src/validate-question.js  validateQuestion(), the ONLY gate for questions
server/src/seed-data.js          14 maths + 8 science original MCQs (2 per topic) + 3 fake demo students
server/src/review.js             teacher review CLI (list, approve, edit)
server/src/snapshots.js          committed teacher decisions: reviews.json (seed question edits/approvals), explanations.json
server/src/llm/client.js         createLlm(): the only Ollama caller; 8s SMS timeout, returns null on failure, logs latency, prewarm()
server/src/llm/parse-reply.js    free text -> A-D: regex, then option values in code, then the model (or UNKNOWN)
server/src/llm/ask.js            ASK: compute detection + per-topic method hints, science guard, maths concept answers
server/src/validate-explanation.js  validateExplanation(), the ONLY gate for explanations
server/src/explain-review.js     teacher explanation review CLI (list, approve, reject, edit)
server/scripts/generateExplanations.js  model drafts for wrong options (3 tries each, validated)
server/src/seed.js, demo-reset.js
server/data/                     abhyaas.db, *.local.json (gitignored); reviews.json, explanations.json (committed, seed questions only)
client/src/                      React app: App.jsx dashboard at /, SmsBox.jsx (live GSM-7 counter, imports server/src/gsm7.js), Phone.jsx SMS simulator at /phone
gateway-phone/gateway.mjs        Android SMS gateway (Termux, no deps); state in .last-id, .pending.json (gitignored)
```

## Data model

`students` (+ current_subject MATH|SCI, default MATH), `questions` (subject `MATH`|`SCI`, status `needs-review`|`approved`, topic, stem, option_a-d, correct_option, solution, misconceptions JSON keyed by wrong letter, source `seed`|`photo-import`, source_ref), `explanations` (status `draft`|`approved`, model `gemma`|`teacher`), `sessions` (one per served question; origin `quiz`|`push`), `attempts` (first attempt per session = the "first try" used for stats), `messages`, `outbox` (`queued`|`sent`|`failed`), `doubts` (`open`|`answered`, subject; `reply` = Gemma's answer, `teacher_reply` = the teacher's), `settings` (key/value: `push_topic`, `last_daily_push`). Enums, and which topics belong to which subject, are enforced with CHECK constraints. `openDb()` migrates older DBs in place.

## Questions

- Every question goes through `validateQuestion(q)`: the seed, the photo import, and any teacher edit. Don't write a second validator. Extend this one.
- It checks:
  - The subject is MATH or SCI, and the topic belongs to it: MATH = HCF, PCT, INT, ALG, GEO, SET, PROB; SCI = PHY, CHEM, BIO, EARTH.
  - There are 4 non-empty, different options. Maths compares **values**: `2/4`=`1/2`, `Rs 1,200`=`1200`, and `x^2-1`=`(x-1)(x+1)` all count as equal. Science compares text (case and spacing ignored), because a value check reads words as algebra (`Ohm`=`Mho`).
  - `correct_option` is A-D.
  - The full question SMS is ≤160. It is measured with worst-case id `Q9999`.
  - The solution is ≤160. For maths, its text after the last `=` must equal the correct option's value. For science, it is a short explanation that a teacher checks.
  - Each wrong option has a misconception note.
- SMS question format: `Q{id} {TOPIC}\n{stem}\nA) ..\nB) ..\nC) ..\nD) ..\nReply A/B/C/D`.
- Write maths in plain GSM-7: `x^2`, `*`, `/`, `pi`, `22/7`. Never use `²`, `×`, `÷`, `√` or `π`.
- Each subject's TOPICS message must fit one SMS.
- New questions start as `needs-review`. Only approved questions go to students.
- Approvals and edits of seed questions are also written to `server/data/reviews.json`, and approved explanations to `explanations.json`, so `demo:reset` keeps them. Commit those files after a review.
- Explanations (<=120 chars, shown as "Not quite. <text> Try again: reply A/B/C/D") must pass `validateExplanation()`: GSM-7, no correct letter or value, no "add X to Y" instructions, maths numbers from the question only, no new science terms. A teacher's edit only warns on those two checks; Gemma drafts must pass all of them.
- New seed questions must be original. Each wrong option must be a real student mistake, described in its misconception note. Keep the correct letters spread across A-D.

## SMS engine

- Commands: JOIN <name>, HELP, SUBJECT [MATH|SCI], TOPICS, QUIZ [MATH|SCI|<code>], a bare topic code, a bare subject word (MATH/MATHS/GANIT, SCI/SCIENCE/BIGYAN/VIGYAN), A-D, SCORE (both subjects), ASK <text>. Unknown numbers only get the JOIN prompt.
- Free text with a question waiting goes through parseReply: regex ("b ho", "mero answer c"), then the typed value against the options, then the model maps it to A-D or UNKNOWN ("Reply A/B/C/D to answer Q12."). The letter is graded by the same code as a plain "B". Model calls run between DB transactions; if the pending question changed meanwhile, nothing is graded.
- ASK: science (SCI subject or science words) never reaches the model: canned reply + SCI doubt. Maths sums (equations, operators, "solve", 2+ numbers) get a hand-written method hint + "Sent to your teacher too." and an open doubt. Maths concept questions go to the model (<=150 chars); its answer is saved as an answered doubt, and a failure sends "Your question was sent to your teacher." with an open doubt.
- Wrong first try: the approved explanation for that option, else a generic hint. Never the solution. Wrong second try: answer + solution, session ends.
- QUIZ order per subject: due review in weakest topic, any due review (first try wrong >= 2 days ago), new in weakest topic, next new, then least recently practised. Weakest = lowest first-try accuracy with >= 2 tries, never 100%.
- Daily cap: 20 QUIZ-served questions per local day (`origin = 'quiz'`); pushes don't count.
- Every reply goes through `smsSafe()` and is logged to `messages` and `outbox`. Tests pass a fake clock and a fake model: `createSmsEngine(db, { now, llm: { chat: async () => '...' } })`. Never call the real model in tests.

## Teacher dashboard

- `/` (App.jsx), plain CSS, projector sizes, Maths/Science switch. Stats are first tries only (`stats.js`); student rows carry names, never phones; the message log masks phones.
- Doubts inbox: open doubts plus Gemma-answered ones from the last 7 days without a teacher reply. A reply is queued in the outbox and sets `status = 'answered'`, `teacher_reply`.
- Doubt replies and broadcasts go through `engine.queueSms()`: look-alikes swapped, but text that is empty, not GSM-7 or over 160 is refused (400), never cut.
- Daily push: once per local day at or after `DAILY_PUSH_TIME` (late start still pushes that day), one `pushQuestion()` per student from their weakest topic in their current subject, or the teacher's topic override. "Send now" runs the same push and doesn't change the schedule.

## SMS gateway

- `gateway-phone/gateway.mjs` polls `termux-sms-list`, POSTs `{phone, body, smsId}` to `/api/sms/incoming`, and sends the reply with `termux-sms-send`. The server caches replies by `phone|smsId`, so a retried POST is never graded twice. A failed reply send is resent by the gateway from `.pending.json`, never re-posted.
- Pushes: `GET /api/gateway/outbox` (queued), then `POST /api/gateway/outbox/:id/sent|failed`. The gateway marks an id `sending` on disk before sending and never sends it again.
- `POST /api/gateway/heartbeat` every 30s. `/api/health` gateway mode is `termux` within 90s of one, else `simulator`.
- Gateway logs mask phones and never print SMS text (an execFile error message contains the full command line, so don't log it).
- Tests run the real gateway against fake `termux-sms-*` scripts on PATH (`server/test/gateway.test.js`).

## Conventions

- Every outgoing SMS goes through the `outbox` table. Check `fitsOneSms()` before queuing.
- Run `npm test` before committing. Never commit `.env`, `*.db` or `*.local.json`.
