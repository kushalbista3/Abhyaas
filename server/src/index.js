import express from 'express';
import { config } from './config.js';
import { openDb } from './db.js';
import { formatQuestionSms } from './sms.js';

const db = openDb(config.dbPath);
const app = express();
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ ok: true, questions: db.prepare('SELECT COUNT(*) AS n FROM questions').get().n });
});

app.get('/api/questions', (req, res) => {
  const rows = db.prepare('SELECT * FROM questions ORDER BY id').all();
  res.json(rows.map((q) => ({ ...q, misconceptions: JSON.parse(q.misconceptions), sms: formatQuestionSms(q) })));
});

// 0.0.0.0 so the SMS gateway phone on the same LAN can reach this laptop.
app.listen(config.port, '0.0.0.0', () => {
  console.log(`Abhyaas server on http://0.0.0.0:${config.port}`);
});
