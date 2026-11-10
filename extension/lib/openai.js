// OpenAI (ChatGPT's models) through the Responses API with the user's own API key. Plain HTTP, no SDK.
// Pure request/response shaping lives here so it can be tested without a network.

export const OPENAI_URL = 'https://api.openai.com/v1/responses';
export const OPENAI_DEFAULT_MODEL = 'gpt-6-astra';

/** One prompt as text: our instructions, then the JSON shape we need back. Shared by both ChatGPT routes. */
export function jsonOnlySystem(system, schema) {
  return `${system}\n\nReturn ONLY a JSON object that matches this JSON Schema (no prose, no code fences):\n${JSON.stringify(schema)}`;
}

/** The fetch() arguments for one request. */
export function buildOpenAiRequest(settings, { system, user, schema, maxTokens }) {
  const key = String(settings.openaiKey || '').trim();
  if (!key) throw new Error('No OpenAI API key set. Add one in StreamSnag settings.');
  const model = String(settings.openaiModel || '').trim() || OPENAI_DEFAULT_MODEL;
  if (!/^[a-z0-9][a-z0-9.\-_:]*$/i.test(model)) throw new Error('Invalid model name');
  return {
    url: OPENAI_URL,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        input: [
          { role: 'system', content: jsonOnlySystem(system, schema) },
          { role: 'user', content: user },
        ],
        max_output_tokens: maxTokens || 16000,
        store: false, // nothing about the page is kept on OpenAI's side for later retrieval
      }),
    },
  };
}

/** The answer text from a Responses API reply, or a clear error (API error, refusal, cut off, empty). */
export function readOpenAiResponse(status, body) {
  if (status < 200 || status >= 300 || body?.error) {
    const msg = body?.error?.message || `HTTP ${status}`;
    if (status === 401) throw new Error('OpenAI did not accept the API key. Check it in StreamSnag settings.');
    if (status === 429) throw new Error(`OpenAI is rate-limiting or out of credit: ${String(msg).slice(0, 200)}`);
    throw new Error(`OpenAI error: ${String(msg).slice(0, 300)}`);
  }
  const parts = (Array.isArray(body?.output) ? body.output : [])
    .filter((item) => item?.type === 'message')
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []));
  const refusal = parts.find((p) => p?.type === 'refusal');
  if (refusal) throw new Error(`ChatGPT declined this request${refusal.refusal ? `: ${String(refusal.refusal).slice(0, 200)}` : ''}`);
  const text = parts.filter((p) => p?.type === 'output_text' && typeof p.text === 'string').map((p) => p.text).join('');
  if (body?.status === 'incomplete' && body.incomplete_details?.reason === 'max_output_tokens') throw new Error('AI response was cut off (max tokens).');
  if (!text.trim()) throw new Error('OpenAI returned an empty answer.');
  return text;
}
