# Abhyaas — SEE maths and science practice on any phone

Abhyaas (अभ्यास, "practice") sends Nepal SEE (Grade 10) maths and science multiple-choice questions by SMS to students on basic keypad phones. Everything runs offline on one laptop. Grading is plain code. Science questions reach students only after a teacher approves them (`npm run questions:review`). A local Gemma model (via Ollama) helps phrase explanations.

## Setup

```sh
cp .env.example .env    # set OLLAMA_MODEL; GEMINI_* only for teacher photo import
npm install
npm run seed
npm run dev
```

Open http://localhost:5173/phone for the SMS simulator (a keypad-phone thread for a projector). The SMS gateway phone posts each incoming SMS to `POST /api/sms/incoming` with `{phone, body}` and sends back the `reply`.

`npm test` runs the test suite. `npm run demo:reset` wipes the local demo database.

## License

MIT
