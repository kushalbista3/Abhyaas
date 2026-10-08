import fs from 'node:fs';
import { config } from './config.js';
import { openDb } from './db.js';
import { seed } from './seed.js';

// Wipes the local demo DB (students, attempts, messages...) and reseeds.
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.dbPath + suffix, { force: true });
const db = openDb(config.dbPath);
const { questions, students } = seed(db);
console.log(`Demo reset: ${questions} questions, ${students} students.`);
db.close();
