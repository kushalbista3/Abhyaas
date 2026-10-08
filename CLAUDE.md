# Abhyaas (अभ्यास)

SEE (Nepal Grade 10) maths MCQ practice over SMS for students on keypad phones with no internet. A teacher's laptop runs everything. Students text answers. The server grades them and replies by SMS.

## Hard rules (never break these)

1. **Student runtime is fully offline on one laptop.** Only local Gemma 4 via Ollama, with the model from env `OLLAMA_MODEL`. No cloud calls anywhere in the student SMS path.
2. **Grading is deterministic code.** Compare the reply letter with `questions.correct_option`. The LLM never decides correctness. It may only phrase explanations, using the stored correct answer and misconception.
3. **Every SMS is ≤160 GSM-7 chars.** Extension chars `^ { } [ ] ~ | € \` count as 2. No Devanagari, no emoji, no smart quotes. Always measure with `gsmLength()` in `server/src/gsm7.js`, never with `.length`.
4. **LLM failures fall back to safe canned replies.** Wrap every Ollama call with a timeout and a try/catch that returns a fixed GSM-7 reply. The SMS loop must never crash or go silent.
5. **Store only phone, name and class** for students. Mask phone numbers on every screen and in logs with `maskPhone()` (`98******01`).
6. **Only teacher-side photo import uses the cloud** (Gemini API via `@google/genai`, model from env `GEMINI_MODEL`). Never log, print or return `GEMINI_API_KEY`.
7. **Imported questions may be copyrighted.** Keep them only in gitignored `server/data/*.local.json` (and the gitignored DB). Never commit them. Only the original questions in `seed-data.js` live in git.

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

## Layout

```
server/src/config.js             loads .env; DB_PATH, PORT, OLLAMA_MODEL, GEMINI_MODEL
server/src/db.js                 openDb() + full schema (CREATE IF NOT EXISTS, CHECK constraints)
server/src/gsm7.js               gsmLength(), fitsOneSms(), SMS_LIMIT
server/src/sms.js                TOPICS, TOPICS_MESSAGE, formatQuestionSms(), maskPhone()
server/src/expr.js               safe expression evaluator (no eval) for value comparison
server/src/validate-question.js  validateQuestion(), the ONLY gate for questions
server/src/seed-data.js          14 original MCQs (2 per topic) + 3 fake demo students
server/src/seed.js, demo-reset.js
server/data/                     abhyaas.db, *.local.json (all gitignored)
client/src/                      React app
```

## Data model

`students`, `questions` (topic, stem, option_a-d, correct_option, solution, misconceptions JSON keyed by wrong letter, source `seed`|`photo-import`, source_ref), `explanations` (status `draft`|`approved`, model `gemma`|`teacher`), `sessions`, `attempts`, `messages`, `outbox` (`queued`|`sent`|`failed`), `doubts` (`open`|`answered`). Enums are enforced with CHECK constraints.

## Questions

- Every question goes through `validateQuestion(q)`: the seed, the photo import, and any teacher edit. Don't write a second validator. Extend this one.
- It checks:
  - The topic is one of HCF, PCT, INT, ALG, GEO, SET, PROB.
  - There are 4 non-empty options with **different values**. `2/4`=`1/2`, `Rs 1,200`=`1200`, and `x^2-1`=`(x-1)(x+1)` all count as equal.
  - `correct_option` is A-D.
  - The full question SMS is ≤160. It is measured with worst-case id `Q9999`.
  - The solution is ≤160 and its text after the last `=` equals the correct option's value.
  - Each wrong option has a misconception note.
- SMS question format: `Q{id} {TOPIC}\n{stem}\nA) ..\nB) ..\nC) ..\nD) ..\nReply A/B/C/D`.
- Write maths in plain GSM-7: `x^2`, `*`, `/`, `pi`, `22/7`. Never use `²`, `×`, `÷`, `√` or `π`.
- New seed questions must be original. Each wrong option must be a real student mistake, described in its misconception note. Keep the correct letters spread across A-D.

## Conventions

- Every outgoing SMS goes through the `outbox` table. Check `fitsOneSms()` before queuing.
- Run `npm test` before committing. Never commit `.env`, `*.db` or `*.local.json`.
