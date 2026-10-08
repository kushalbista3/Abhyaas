// The only way to the local model (CLAUDE.md rules 1 and 4): Gemma 4 via
// Ollama on this laptop, OLLAMA_HOST + OLLAMA_MODEL. chat() never throws: on
// a timeout, an error or an empty reply it returns null, and the caller uses
// a fixed GSM-7 reply. Logs show task, latency and outcome only, never the
// prompt or the student's text.
import { Ollama } from 'ollama';
import { config } from '../config.js';

export const SMS_TIMEOUT_MS = 8000;
const PREWARM_TIMEOUT_MS = 120_000;

export function createLlm({ host = config.ollamaHost, model = config.ollamaModel, log = console.log } = {}) {
  // messages: [{ role, content }]. format: 'json' or a JSON schema object.
  async function chat(messages, { format, timeoutMs = SMS_TIMEOUT_MS, task = 'chat', options = {} } = {}) {
    const started = Date.now();
    const abort = new AbortController();
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        abort.abort();
        resolve('timeout');
      }, timeoutMs);
    });
    // Ollama's non-streamed requests carry no signal, so add ours to every fetch.
    const client = new Ollama({ host, fetch: (url, init) => fetch(url, { ...init, signal: abort.signal }) });
    let outcome = 'error';
    try {
      // think: false. Gemma 4 thinks by default, which takes ~10s, too slow for SMS.
      const request = {
        model, messages, format, stream: false, think: false, keep_alive: '30m',
        options: { temperature: 0, ...options },
      };
      const res = await Promise.race([client.chat(request), timeout]);
      if (res === 'timeout') {
        outcome = 'timeout';
        return null;
      }
      const text = String(res?.message?.content ?? '').trim();
      outcome = text ? 'ok' : 'empty';
      return text || null;
    } catch {
      if (abort.signal.aborted) outcome = 'timeout';
      return null;
    } finally {
      clearTimeout(timer);
      abort.abort();
      log(`LLM ${task} ${Date.now() - started}ms ${outcome}`);
    }
  }

  // One tiny real request so the model is loaded before the first SMS.
  async function prewarm() {
    const started = Date.now();
    const text = await chat([{ role: 'user', content: 'Reply OK' }], {
      task: 'prewarm',
      timeoutMs: PREWARM_TIMEOUT_MS,
      options: { num_predict: 1 },
    });
    return { ok: text !== null, ms: Date.now() - started };
  }

  return { chat, prewarm, model };
}

// The model's JSON reply as an object, or null if it is not valid JSON.
export function parseJson(text) {
  if (!text) return null;
  const s = String(text).replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}
