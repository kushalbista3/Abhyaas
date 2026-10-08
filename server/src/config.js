import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

// GEMINI_API_KEY is read only by the teacher photo-import code; never log it.
export const config = {
  // PORT=0 lets the OS pick a free port (tests); unset or empty means 3001.
  port: process.env.PORT?.trim() ? Number(process.env.PORT) : 3001,
  dbPath: path.resolve(ROOT, process.env.DB_PATH || 'server/data/abhyaas.db'),
  // Committed snapshots of teacher approvals (reviews.json, explanations.json).
  snapshotDir: path.resolve(ROOT, process.env.SNAPSHOT_DIR || 'server/data'),
  // Approved photo imports (may be copyrighted): gitignored, never committed.
  importsFile: path.resolve(ROOT, 'server/data/imported-questions.local.json'),
  ollamaModel: process.env.OLLAMA_MODEL || 'gemma4:e4b',
  ollamaHost: (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
  geminiModel: process.env.GEMINI_MODEL || '',
  dailyPushTime: process.env.DAILY_PUSH_TIME || '',
};
