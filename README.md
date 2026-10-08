# Abhyaas — SEE maths practice on any phone

Abhyaas (अभ्यास, "practice") sends Nepal SEE (Grade 10) maths multiple-choice questions by SMS to students on basic keypad phones. Everything runs offline on one laptop. Grading is plain code. A local Gemma model (via Ollama) helps phrase explanations.

## Setup

```sh
cp .env.example .env    # set OLLAMA_MODEL; GEMINI_* only for teacher photo import
npm install
npm run seed
npm run dev
```

`npm test` runs the test suite. `npm run demo:reset` wipes the local demo database.

## License

MIT
