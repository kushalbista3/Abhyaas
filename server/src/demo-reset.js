import fs from 'node:fs';
import { config } from './config.js';
import { openDb } from './db.js';
import { seedDemoActivity } from './demo-activity.js';
import { seed } from './seed.js';
import { loadImports, loadSnapshots } from './snapshots.js';

// Wipes the local demo DB (students, attempts, messages...) and reseeds.
// Teacher approvals and approved explanations come back from the snapshots,
// approved photo imports from the local imports file;
// then 5 days of demo practice and 2 open doubts for the dashboard.
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.dbPath + suffix, { force: true });
const db = openDb(config.dbPath);
const { questions, students, explanations, imported } = seed(db, {
  ...loadSnapshots(config.snapshotDir),
  imports: loadImports(config.importsFile),
});
const activity = await seedDemoActivity(db);
console.log(
  `Demo reset: ${questions} questions (+${imported} imported), ${students} students, ${explanations} explanations, ` +
    `${activity.attempts} demo answers, ${activity.doubts} open doubts.`,
);
db.close();
