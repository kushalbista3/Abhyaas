import express from 'express';
import { config } from './config.js';
import { createSmsEngine } from './engine.js';
import { sqlTime } from './practice.js';
import { formatQuestionSms, maskPhone, normalizePhone } from './sms.js';

// The phone gateway counts as connected if a heartbeat (every 30s) arrived this recently.
export const GATEWAY_FRESH_MS = 90_000;
const OLLAMA_PROBE_MS = 1500;
const SEEN_SMS_MAX = 1000;

// Is Ollama up, and is the configured model pulled? A probe, not an LLM call.
async function probeOllama(host, model) {
  try {
    const r = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(OLLAMA_PROBE_MS) });
    if (!r.ok) return { reachable: false, model, modelInstalled: false };
    const names = ((await r.json()).models ?? []).flatMap((m) => [m.name, m.model]);
    const wanted = model.includes(':') ? [model] : [model, `${model}:latest`];
    return { reachable: true, model, modelInstalled: wanted.some((w) => names.includes(w)) };
  } catch {
    return { reachable: false, model, modelInstalled: false };
  }
}

export function createApp(
  db,
  engine = createSmsEngine(db),
  { now = Date.now, ollamaHost = config.ollamaHost, ollamaModel = config.ollamaModel } = {},
) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  let gatewaySeenAt = null;
  // phone|smsId -> pending or settled { reply, outboxId }. If the gateway
  // retries a POST whose response it lost, it gets the same reply back and
  // the answer is not graded twice. Oldest entries are dropped first.
  const seenSms = new Map();

  const outbox = {
    queued: db.prepare("SELECT id, phone, body FROM outbox WHERE status = 'queued' ORDER BY id LIMIT 20"),
    sent: db.prepare("UPDATE outbox SET status = 'sent', sent_at = ? WHERE id = ?"),
    failed: db.prepare("UPDATE outbox SET status = 'failed' WHERE id = ?"),
  };

  app.get('/api/health', async (req, res) => {
    let questions = null;
    try {
      questions = db.prepare('SELECT COUNT(*) AS n FROM questions').get().n;
    } catch (err) {
      console.error(`Health: database error: ${err.message}`);
    }
    const ago = gatewaySeenAt === null ? null : Math.max(0, now() - gatewaySeenAt);
    res.json({
      ok: questions !== null,
      db: questions !== null ? 'ok' : 'error',
      questions,
      ollama: await probeOllama(ollamaHost, ollamaModel),
      gateway: {
        mode: ago !== null && ago <= GATEWAY_FRESH_MS ? 'termux' : 'simulator',
        secondsSinceLastSeen: ago === null ? null : Math.round(ago / 1000),
      },
    });
  });

  app.get('/api/questions', (req, res) => {
    const rows = db.prepare('SELECT * FROM questions ORDER BY id').all();
    res.json(rows.map((q) => ({ ...q, misconceptions: JSON.parse(q.misconceptions), sms: formatQuestionSms(q) })));
  });

  // The SMS gateway phone (and the /phone simulator) posts each incoming SMS
  // here. The gateway also sends smsId (its inbox _id) so a retry is not re-graded.
  app.post('/api/sms/incoming', async (req, res) => {
    const { phone, body, smsId } = req.body ?? {};
    const normalized = normalizePhone(phone);
    if (!normalized) return res.status(400).json({ error: 'phone is required' });
    if (smsId === undefined || smsId === null || smsId === '') return res.json(await engine.receive(phone, body));

    const key = `${normalized}|${smsId}`;
    let result = seenSms.get(key);
    if (!result) {
      result = engine.receive(phone, body);
      seenSms.set(key, result);
      if (seenSms.size > SEEN_SMS_MAX) seenSms.delete(seenSms.keys().next().value);
    }
    res.json(await result);
  });

  // The Android gateway (gateway-phone/gateway.mjs).
  app.post('/api/gateway/heartbeat', (req, res) => {
    gatewaySeenAt = now();
    res.json({ ok: true });
  });

  app.get('/api/gateway/outbox', (req, res) => {
    res.json(outbox.queued.all());
  });

  for (const status of ['sent', 'failed']) {
    app.post(`/api/gateway/outbox/:id/${status}`, (req, res) => {
      const id = Number(req.params.id);
      const args = status === 'sent' ? [sqlTime(new Date(now())), id] : [id];
      const { changes } = Number.isInteger(id) ? outbox[status].run(...args) : { changes: 0 };
      if (!changes) return res.status(404).json({ error: 'no such outbox message' });
      res.json({ ok: true });
    });
  }

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
