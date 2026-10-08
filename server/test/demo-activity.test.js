import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { DEMO_DAYS, seedDemoActivity } from '../src/demo-activity.js';
import { fitsOneSms } from '../src/gsm7.js';
import { localDay } from '../src/practice.js';
import { seed } from '../src/seed.js';
import { loadSnapshots } from '../src/snapshots.js';
import { dashboard } from '../src/stats.js';
import { listDoubts } from '../src/teacher.js';

const SNAPSHOTS = fileURLToPath(new URL('../data/', import.meta.url));
const NOW = new Date(2026, 9, 8, 12, 0, 0);

async function demo() {
  const db = openDb(':memory:');
  seed(db, loadSnapshots(SNAPSHOTS));
  const result = await seedDemoActivity(db, { now: NOW });
  return { db, result };
}

test('demo: PCT is clearly the weakest maths topic and PCT-1 option A the top misconception', async () => {
  const { db, result } = await demo();
  assert.ok(result.attempts > 50, `${result.attempts} attempts`);
  const { topics, misconceptions, students } = dashboard(db, 'MATH', NOW);

  assert.equal(topics[0].topic, 'PCT');
  assert.ok(topics[0].pct <= 20, `PCT at ${topics[0].pct}%`);
  assert.ok(topics[1].pct - topics[0].pct >= 40, 'a clear gap to the next topic');

  const [top] = misconceptions;
  const ref = db.prepare('SELECT source_ref FROM questions WHERE id = ?').get(top.id).source_ref;
  assert.equal(ref, 'seed:PCT-1');
  assert.equal(top.id, 3);
  assert.equal(top.wrongOption, 'A');
  assert.ok(top.explanation, 'its approved explanation is shown');
  for (const m of misconceptions.slice(1)) assert.ok(m.wrongCount < top.wrongCount, `Q${m.id} ${m.wrongOption}`);

  assert.deepEqual(students.map((s) => s.weakest), ['PCT', 'PCT', 'PCT']);
  assert.ok(dashboard(db, 'SCI', NOW).overview.firstTries > 0, 'some science practice too');
});

test('demo: 2 open doubts (maths, science), 5 past days, nothing pending, every SMS fits', async () => {
  const { db, result } = await demo();
  assert.equal(result.doubts, 2);
  assert.deepEqual(listDoubts(db, NOW).map((d) => [d.subject, d.status]).sort(), [['MATH', 'open'], ['SCI', 'open']]);

  const days = db.prepare('SELECT created_at FROM attempts').all().map((r) => new Date(`${r.created_at.replace(' ', 'T')}Z`).toDateString());
  assert.equal(new Set(days).size, DEMO_DAYS);
  const [todayStart] = localDay(NOW);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE created_at >= ?').get(todayStart).n, 0, 'nothing today');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE state = 'active'").get().n, 0, 'no question left waiting');

  const out = db.prepare('SELECT body, status FROM outbox').all();
  assert.ok(out.length > 0);
  for (const o of out) assert.ok(fitsOneSms(o.body), o.body);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE direction = 'out'").get().n, out.length);

  assert.deepEqual(await seedDemoActivity(db, { now: NOW }), { attempts: 0, doubts: 0, messages: 0 }, 'runs once');
});
