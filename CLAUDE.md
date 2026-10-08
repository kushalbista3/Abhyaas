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
| `npm run seed` | validate and insert the seed questions and demo students (idempotent) |
| `npm run demo:reset` | delete the local DB and reseed |
| `npm run questions:review` | `list [--all]`, `approve <ids>`, `edit <id> [field=value ...]` (no fields opens `$EDITOR`) |

## Layout

```
server/src/config.js             loads .env; DB_PATH, PORT, OLLAMA_MODEL, GEMINI_MODEL
server/src/db.js                 openDb() + full schema (CREATE IF NOT EXISTS, CHECK constraints) + migrate()
server/src/gsm7.js               gsmLength(), fitsOneSms(), smsSafe(), firstFitting(), SMS_LIMIT
server/src/sms.js                SUBJECTS, TOPICS / TOPIC_CODES / TOPICS_MESSAGE per subject, formatQuestionSms(), maskPhone(), normalizePhone()
server/src/engine.js             createSmsEngine(db) -> handleIncomingSms(phone, body), pushQuestion(); commands, grading, logging
server/src/practice.js           adaptive QUIZ order, weakest topic, due reviews, streaks, daily cap
server/src/app.js                createApp(db, engine, {now, ollamaHost, ollamaModel}): /api/sms/incoming, /api/gateway/*, /api/health, /api/sim/*
server/src/lan.js                lanAddresses(), startupBanner(): LAN IPs + the LAPTOP_URL command printed on startup
server/src/expr.js               safe expression evaluator (no eval) for value comparison
server/src/validate-question.js  validateQuestion(), the ONLY gate for questions
server/src/seed-data.js          14 maths + 8 science original MCQs (2 per topic) + 3 fake demo students
server/src/review.js             teacher review CLI (list, approve, edit)
server/src/seed.js, demo-reset.js
server/data/                     abhyaas.db, *.local.json (all gitignored)
client/src/                      React app: App.jsx dashboard, Phone.jsx SMS simulator at /phone
gateway-phone/gateway.mjs        Android SMS gateway (Termux, no deps); state in .last-id, .pending.json (gitignored)
```

## Data model

`students` (+ current_subject MATH|SCI, default MATH), `questions` (subject `MATH`|`SCI`, status `needs-review`|`approved`, topic, stem, option_a-d, correct_option, solution, misconceptions JSON keyed by wrong letter, source `seed`|`photo-import`, source_ref), `explanations` (status `draft`|`approved`, model `gemma`|`teacher`), `sessions` (one per served question; origin `quiz`|`push`), `attempts` (first attempt per session = the "first try" used for stats), `messages`, `outbox` (`queued`|`sent`|`failed`), `doubts` (`open`|`answered`, subject). Enums, and which topics belong to which subject, are enforced with CHECK constraints. `openDb()` migrates older DBs in place.

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
- New seed questions must be original. Each wrong option must be a real student mistake, described in its misconception note. Keep the correct letters spread across A-D.

## SMS engine

- Commands: JOIN <name>, HELP, SUBJECT [MATH|SCI], TOPICS, QUIZ [MATH|SCI|<code>], a bare topic code, a bare subject word (MATH/MATHS/GANIT, SCI/SCIENCE/BIGYAN/VIGYAN), A-D, SCORE (both subjects), ASK <text>. Unknown numbers only get the JOIN prompt.
- Wrong first try: the approved explanation for that option, else a generic hint. Never the solution. Wrong second try: answer + solution, session ends.
- QUIZ order per subject: due review in weakest topic, any due review (first try wrong >= 2 days ago), new in weakest topic, next new, then least recently practised. Weakest = lowest first-try accuracy with >= 2 tries, never 100%.
- Daily cap: 20 QUIZ-served questions per local day (`origin = 'quiz'`); pushes don't count.
- Every reply goes through `smsSafe()` and is logged to `messages` and `outbox`. Tests pass a fake clock: `createSmsEngine(db, { now })`.

## SMS gateway

- `gateway-phone/gateway.mjs` polls `termux-sms-list`, POSTs `{phone, body, smsId}` to `/api/sms/incoming`, and sends the reply with `termux-sms-send`. The server caches replies by `phone|smsId`, so a retried POST is never graded twice. A failed reply send is resent by the gateway from `.pending.json`, never re-posted.
- Pushes: `GET /api/gateway/outbox` (queued), then `POST /api/gateway/outbox/:id/sent|failed`. The gateway marks an id `sending` on disk before sending and never sends it again.
- `POST /api/gateway/heartbeat` every 30s. `/api/health` gateway mode is `termux` within 90s of one, else `simulator`.
- Gateway logs mask phones and never print SMS text (an execFile error message contains the full command line, so don't log it).
- Tests run the real gateway against fake `termux-sms-*` scripts on PATH (`server/test/gateway.test.js`).

## Conventions

- Every outgoing SMS goes through the `outbox` table. Check `fitsOneSms()` before queuing.
- Run `npm test` before committing. Never commit `.env`, `*.db` or `*.local.json`.
