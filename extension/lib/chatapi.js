// AI providers that speak the common "chat completions" format with the user's own key:
// DeepSeek (very cheap) and OpenRouter (one key, the user picks any model). Plain HTTP, no SDK.
// Pure request/response shaping lives here so it can be tested without a network.
import { jsonOnlySystem } from './openai.js';

export const CHAT_PROVIDERS = Object.freeze({
  deepseek: Object.freeze({
    name: 'DeepSeek',
    url: 'https://api.deepseek.com/chat/completions',
    keySetting: 'deepseekKey',
    modelSetting: 'deepseekModel',
    defaultModel: 'deepseek-flash',
    // JSON mode, and no "thinking": these are extraction and writing jobs, and thinking is billed as output.
    extra: Object.freeze({ response_format: Object.freeze({ type: 'json_object' }), thinking: Object.freeze({ type: 'disabled' }) }),
  }),
  openrouter: Object.freeze({
    name: 'OpenRouter',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    keySetting: 'openrouterKey',
    modelSetting: 'openrouterModel',
    defaultModel: '', // the user picks: that is the point of OpenRouter
    headers: Object.freeze({ 'X-Title': 'StreamSnag' }), // shows up as the app name in the user's OpenRouter activity
    extra: Object.freeze({}),
  }),
});

const MODEL_OK = /^[a-z0-9][a-z0-9.\-_]*(?:\/[a-z0-9][a-z0-9.\-_]*)?(?::[a-z0-9][a-z0-9.\-_]*)?$/i; // "model", "vendor/model", "vendor/model:free"

/** The fetch() arguments for one request. `model` overrides the one in Settings (study packs route some steps to a cheaper model). */
export function buildChatRequest(provider, settings, { system, user, schema, maxTokens }, { model: override = '' } = {}) {
  const p = Object.hasOwn(CHAT_PROVIDERS, provider) ? CHAT_PROVIDERS[provider] : null;
  if (!p) throw new Error('Unknown AI provider');
  const key = String(settings[p.keySetting] || '').trim();
  if (!key) throw new Error(`No ${p.name} API key set. Add one in StreamSnag settings.`);
  const model = String(override || settings[p.modelSetting] || '').trim() || p.defaultModel;
  if (!model) throw new Error(`Choose a model for ${p.name} in StreamSnag settings.`);
  if (model.length > 120 || !MODEL_OK.test(model)) throw new Error('Invalid model name');
  return {
    url: p.url,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...(p.headers || {}) },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: jsonOnlySystem(system, schema) },
          { role: 'user', content: user },
        ],
        max_tokens: maxTokens || 16000,
        ...p.extra,
      }),
    },
  };
}

/** The answer text from a chat-completions reply, or a clear error (bad key, no credit, rate limit, declined, cut off, empty). */
export function readChatResponse(provider, status, body) {
  const name = CHAT_PROVIDERS[provider]?.name || 'The AI provider';
  if (status < 200 || status >= 300 || body?.error) {
    const raw = body?.error?.message ?? body?.error ?? '';
    const msg = String(typeof raw === 'string' ? raw : JSON.stringify(raw)).slice(0, 300) || `HTTP ${status}`;
    const code = Number(body?.error?.code) || status;
    if (code === 401 || status === 401) throw new Error(`${name} did not accept the API key. Check it in StreamSnag settings.`);
    if (code === 402 || status === 402) throw new Error(`Your ${name} account is out of credit. Add credit there, or choose another AI provider.`);
    if (code === 429 || status === 429) throw new Error(`${name} is rate-limiting requests for now. Wait a little and try again. (${msg.slice(0, 160)})`);
    throw new Error(`${name} error: ${msg}`);
  }
  const choice = Array.isArray(body?.choices) ? body.choices[0] : null;
  const content = choice?.message?.content;
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter((part) => typeof part?.text === 'string').map((part) => part.text).join('') : '';
  if (choice?.finish_reason === 'length') throw new Error('AI response was cut off (max tokens).');
  if (choice?.finish_reason === 'content_filter') throw new Error(`${name} declined this request (content filter).`);
  if (choice?.message?.refusal) throw new Error(`${name} declined this request: ${String(choice.message.refusal).slice(0, 200)}`);
  if (!text.trim()) throw new Error(`${name} returned an empty answer.`);
  return text;
}

/** Tokens and (when the provider reports it) cost of one reply, for the usage shown after a study pack. */
export function chatUsage(body) {
  const u = body?.usage || {};
  const num = (v) => (Number.isFinite(v) ? v : 0);
  return { inputTokens: num(u.prompt_tokens), outputTokens: num(u.completion_tokens), cachedTokens: num(u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens), cost: Number.isFinite(u.cost) ? u.cost : null };
}
