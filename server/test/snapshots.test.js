import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { seed } from '../src/seed.js';
import { approve, editQuestion } from '../src/review.js';
import { explanationSnapshot, loadSnapshots, reviewSnapshot } from '../src/snapshots.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const idOf = (db, ref) => db.prepare('SELECT id FROM questions WHERE source_ref = ?').get(ref).id;

test('review snapshot holds only what differs from seed-data.js', () => {
  const db = openDb(':memory:');
  seed(db);
  assert.deepEqual(reviewSnapshot(db), {});
  const phy = idOf(db, 'seed:PHY-1');
  const bio = idOf(db, 'seed:BIO-2');
  approve(db, [phy]);
  assert.ok(editQuestion(db, bio, { solution: 'Pulmonary veins carry oxygen-rich blood to the heart.' }).ok);
  assert.deepEqual(reviewSnapshot(db), {
    'seed:PHY-1': { status: 'approved' },
    'seed:BIO-2': { solution: 'Pulmonary veins carry oxygen-rich blood to the heart.' },
  });
});

test('seed applies review and explanation snapshots, and stays idempotent', () => {
  const db = openDb(':memory:');
  const snapshots = {
    reviews: { 'seed:PHY-1': { status: 'approved', solution: 'Mass does not change: still 60 kg.' } },
    explanations: [{ source_ref: 'seed:PCT-1', option: 'C', text: 'You stopped after the discount.', model: 'teacher' }],
  };
  assert.deepEqual(seed(db, snapshots), { questions: 22, students: 3, explanations: 1, imported: 0 });
  const row = db.prepare("SELECT status, solution FROM questions WHERE source_ref = 'seed:PHY-1'").get();
  assert.deepEqual(row, { status: 'approved', solution: 'Mass does not change: still 60 kg.' });
  assert.deepEqual(explanationSnapshot(db), snapshots.explanations);
  assert.deepEqual(seed(db, snapshots), { questions: 0, students: 0, explanations: 0, imported: 0 });
});

test('seed refuses a snapshot edit that fails validation', () => {
  const db = openDb(':memory:');
  const err = console.error;
  console.error = () => {};
  try {
    assert.throws(() => seed(db, { reviews: { 'seed:INT-1': { solution: 'A=12000' } } }), /failed validation/);
  } finally {
    console.error = err;
  }
});

test('approve and edit survive demo:reset (CLI, real files)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abhyaas-snap-'));
  const env = { ...process.env, DB_PATH: path.join(dir, 'test.db'), SNAPSHOT_DIR: dir };
  const run = (script, ...args) => execFileSync(process.execPath, [path.join(SRC, script), ...args], { env, encoding: 'utf8' });
  try {
    run('seed.js');
    run('review.js', 'approve', '15,20');
    run('review.js', 'edit', '20', 'solution=Pulmonary veins carry oxygen-rich blood to the heart.');
    run('review.js', 'approve', '20');
    assert.deepEqual(loadSnapshots(dir).reviews['seed:PHY-1'], { status: 'approved' });

    run('demo-reset.js');
    const db = new Database(env.DB_PATH, { readonly: true });
    const status = (id) => db.prepare('SELECT status, solution FROM questions WHERE id = ?').get(id);
    assert.equal(status(15).status, 'approved');
    assert.deepEqual(status(20), { status: 'approved', solution: 'Pulmonary veins carry oxygen-rich blood to the heart.' });
    assert.equal(status(16).status, 'needs-review');
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
