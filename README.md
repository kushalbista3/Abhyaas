# Abhyaas — SEE maths and science practice on any phone

Abhyaas (अभ्यास, "practice") sends Nepal SEE (Grade 10) maths and science multiple-choice questions by SMS to students on basic keypad phones. Everything runs offline on one laptop. Grading is plain code. Science questions reach students only after a teacher approves them (`npm run questions:review`). A local Gemma model (via Ollama) helps phrase explanations.

## Setup

```sh
cp .env.example .env    # set OLLAMA_MODEL; GEMINI_* only for teacher photo import
npm install
npm run seed
npm run dev
```

Open http://localhost:5173 for the teacher dashboard (class stats, weak topics, misconceptions, doubts inbox, broadcast, daily push, live message log) and http://localhost:5173/phone for the SMS simulator (a keypad-phone thread for a projector). Set `DAILY_PUSH_TIME=HH:MM` in `.env` to send every student one question a day from their weakest topic.

For real SMS, an Android phone running Termux is the gateway: see [gateway-phone/README.md](gateway-phone/README.md). On startup the server prints its LAN address and the exact command to run on the phone. `GET /api/health` reports the database, Ollama (reachable, model installed) and whether the gateway phone is connected.

`npm test` runs the test suite. `npm run demo:reset` wipes the local demo database and fills it with 5 days of demo practice by 3 students (PCT is their weak topic) and 2 open doubts.

## License

MIT
