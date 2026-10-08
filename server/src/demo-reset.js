import fs from 'node:fs';
import { config } from './config.js';
import { openDb } from './db.js';
import { seed } from './seed.js';
import { loadSnapshots } from './snapshots.js';

// Wipes the local demo DB (students, attempts, messages...) and reseeds.
// Teacher approvals and approved explanations come back from the snapshots.
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.dbPath + suffix, { force: true });
const db = openDb(config.dbPath);
const { questions, students, explanations } = seed(db, loadSnapshots(config.snapshotDir));
console.log(`Demo reset: ${questions} questions, ${students} students, ${explanations} explanations.`);
db.close();
