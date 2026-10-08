import express from 'express';
import { createSmsEngine } from './engine.js';
import { formatQuestionSms, maskPhone, normalizePhone } from './sms.js';

export function createApp(db, engine = createSmsEngine(db)) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, questions: db.prepare('SELECT COUNT(*) AS n FROM questions').get().n });
  });

  app.get('/api/questions', (req, res) => {
    const rows = db.prepare('SELECT * FROM questions ORDER BY id').all();
    res.json(rows.map((q) => ({ ...q, misconceptions: JSON.parse(q.misconceptions), sms: formatQuestionSms(q) })));
  });

  // The SMS gateway phone (and the /phone simulator) posts each incoming SMS here.
  app.post('/api/sms/incoming', async (req, res) => {
    const { phone, body } = req.body ?? {};
    if (!normalizePhone(phone)) return res.status(400).json({ error: 'phone is required' });
    res.json({ reply: await engine.handleIncomingSms(phone, body) });
  });

  // Simulator only. The UI shows name + masked number; phone is the value it posts.
  app.get('/api/sim/students', (req, res) => {
    const rows = db.prepare('SELECT name, phone FROM students ORDER BY id').all();
    res.json(rows.map((s) => ({ ...s, masked: maskPhone(s.phone) })));
  });

  app.get('/api/sim/thread', (req, res) => {
    const rows = db
      .prepare('SELECT id, direction, body, created_at FROM messages WHERE phone = ? ORDER BY id DESC LIMIT 100')
      .all(normalizePhone(req.query.phone));
    res.json(rows.reverse());
  });

  return app;
}
