// The only cloud call (CLAUDE.md rule 6): teacher photo import, through
// @google/genai with GEMINI_MODEL. The photo is sent from memory and never
// stored. The key is never logged, printed or returned: it is scrubbed from
// every error message, and logs show model, latency and status only.
import { GoogleGenAI } from '@google/genai';
import { config } from './config.js';

export function createGemini({
  apiKey = process.env.GEMINI_API_KEY,
  model = config.geminiModel,
  client,
  log = console.log,
} = {}) {
  if (!apiKey || !model) return null;
  const ai = client ?? new GoogleGenAI({ apiKey });
  const scrub = (text) => String(text ?? '').split(apiKey).join('***');

  // The instruction goes in the user turn, and JSON is asked for in words:
  // Gemma models on the Gemini API support neither system prompts nor JSON mode.
  async function generate({ image, mimeType, instruction }) {
    const started = Date.now();
    try {
      const res = await ai.models.generateContent({
        model,
        contents: [
          { role: 'user', parts: [{ inlineData: { mimeType, data: Buffer.from(image).toString('base64') } }, { text: instruction }] },
        ],
        config: { temperature: 0 },
      });
      log(`Photo import ${model} ${Date.now() - started}ms ok`);
      return res.text;
    } catch (err) {
      const status = Number(err?.status ?? err?.code) || null;
      log(`Photo import ${model} ${Date.now() - started}ms error ${status ?? ''}`.trim());
      const safe = new Error(scrub(err?.message));
      safe.status = status;
      throw safe;
    }
  }

  return { generate, model };
}
