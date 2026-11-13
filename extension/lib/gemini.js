// Google Gemini through the Gemini API with the user's own key (Google AI Studio keys include a free
// allowance, which makes this the no-cost way to use the AI features). Plain HTTP, no SDK. Pure
// request/response shaping lives here so it can be tested without a network.
import { jsonOnlySystem } from './openai.js';

export const GEMINI_HOST = 'https://generativelanguage.googleapis.com';
export const GEMINI_DEFAULT_MODEL = 'gemini-3.6-flash';

/** The fetch() arguments for one request. The key travels in a header, never in the address. */
export function buildGeminiRequest(settings, { system, user, schema, maxTokens }) {
  const key = String(settings.geminiKey || '').trim();
  if (!key) throw new Error('No Gemini API key set. Add one in StreamSnag settings.');
  const model = String(settings.geminiModel || '').trim() || GEMINI_DEFAULT_MODEL;
  if (!/^[a-z0-9][a-z0-9.\-_]*$/i.test(model)) throw new Error('Invalid model name');
  return {
    url: `${GEMINI_HOST}/v1beta/models/${model}:generateContent`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: jsonOnlySystem(system, schema) }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { responseMimeType: 'application/json', maxOutputTokens: maxTokens || 16000 },
      }),
    },
  };
}

/** The answer text from a generateContent reply, or a clear error (API error, blocked, cut off, empty). */
export function readGeminiResponse(status, body) {
  if (status < 200 || status >= 300 || body?.error) {
    const msg = String(body?.error?.message || `HTTP ${status}`).slice(0, 300);
    const code = body?.error?.status || '';
    if (status === 429 || code === 'RESOURCE_EXHAUSTED') {
      return fail(`Gemini's free allowance or rate limit is used up for now. Wait a little and try again, or choose another AI provider. (${msg.slice(0, 160)})`);
    }
    if (status === 400 && /api key not valid/i.test(msg)) return fail('Google did not accept the API key. Check it in StreamSnag settings.');
    if (status === 401 || status === 403) return fail('Google did not accept the API key. Check it in StreamSnag settings.');
    return fail(`Gemini error: ${msg}`);
  }
  const blocked = body?.promptFeedback?.blockReason;
  if (blocked) return fail(`Gemini declined this request (${String(blocked).toLowerCase().replace(/_/g, ' ')}).`);
  const first = Array.isArray(body?.candidates) ? body.candidates[0] : null;
  const text = (Array.isArray(first?.content?.parts) ? first.content.parts : [])
    .filter((p) => typeof p?.text === 'string' && !p.thought).map((p) => p.text).join('');
  if (first?.finishReason === 'MAX_TOKENS') return fail('AI response was cut off (max tokens).');
  if (!text.trim()) {
    const why = first?.finishReason && first.finishReason !== 'STOP' ? ` (${String(first.finishReason).toLowerCase().replace(/_/g, ' ')})` : '';
    return fail(`Gemini returned an empty answer${why}.`);
  }
  return text;
}

function fail(message) {
  throw new Error(message);
}
