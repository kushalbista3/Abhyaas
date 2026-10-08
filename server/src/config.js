import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

// GEMINI_API_KEY is read only by the teacher photo-import code; never log it.
export const config = {
  port: Number(process.env.PORT) || 3000,
  dbPath: path.resolve(ROOT, process.env.DB_PATH || 'server/data/abhyaas.db'),
  ollamaModel: process.env.OLLAMA_MODEL || 'gemma4:e4b',
  geminiModel: process.env.GEMINI_MODEL || '',
  dailyPushTime: process.env.DAILY_PUSH_TIME || '',
};
