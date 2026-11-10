// Sends a prompt to Claude either with the user's Anthropic API key (official SDK, bundled into
// vendor/anthropic-sdk.js) or through the local helper that runs the Claude Code CLI on the user's
// Claude subscription.
import { Anthropic } from '../vendor/anthropic-sdk.js';
import { extractJson } from './ai.js';
import { buildOpenAiRequest, readOpenAiResponse, jsonOnlySystem } from './openai.js';

export const HELPER_NAME = 'com.streamsnag.helper';
import { DEFAULT_MODEL } from './settings.js';

export { DEFAULT_MODEL };
// Models that accept the server-side refusal fallback ("fallbacks": "default").
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);

/** One request/response round-trip with the native helper over a dedicated port. */
export function helperRequest(message, { onProgress, onPort, timeoutMs = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = chrome.runtime.connectNative(HELPER_NAME);
    } catch (e) {
      reject(new Error(`Local helper not available: ${e.message}`));
      return;
    }
    onPort?.(port); // lets the caller cancel: disconnecting makes the helper stop what it started
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      port.disconnect();
      reject(new Error('Local helper timed out'));
    }, timeoutMs);
    let settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { port.disconnect(); } catch { /* already closed */ }
      fn(v);
    };
    port.onMessage.addListener((msg) => {
      if (msg?.id !== id) return;
      if (msg.type === 'progress') onProgress?.(msg);
      else if (msg.type === 'error') done(reject, new Error(msg.error || 'Helper error'));
      else if (msg.type === 'result') done(resolve, msg);
    });
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message;
      done(reject, new Error(
        err && /not found|forbidden|specified native/i.test(err)
          ? 'Local helper is not installed. Run "npm run install-helper" in the project folder (see README).'
          : `Local helper disconnected${err ? `: ${err}` : ''}`,
      ));
    });
    port.postMessage({ ...message, id });
  });
}

async function viaApi(settings, { system, user, schema, maxTokens }) {
  if (!settings.apiKey) throw new Error('No Anthropic API key set. Add one in StreamSnag settings.');
  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
  const model = settings.model || DEFAULT_MODEL;
  const params = {
    model,
    max_tokens: maxTokens || 16000,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: {
      effort: settings.effort || 'medium',
      format: { type: 'json_schema', schema },
    },
  };
  let response;
  if (FALLBACK_MODELS.has(model)) {
    // Server-side fallback re-runs a safety-declined request on a suitable model instead of failing.
    response = await client.beta.messages.create({
      ...params,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
  } else {
    response = await client.messages.create(params);
  }
  if (response.stop_reason === 'refusal') {
    throw new Error(`Claude declined this request${response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : ''}`);
  }
  if (response.stop_reason === 'max_tokens') throw new Error('AI response was cut off (max tokens).');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { data: extractJson(text), usage: response.usage, via: `API · ${model}` };
}

async function viaSubscription(settings, { system, user, schema }) {
  const fullSystem = `${system}\n\nReturn ONLY a JSON object that matches this JSON Schema (no prose, no code fences):\n${JSON.stringify(schema)}`;
  const res = await helperRequest(
    { type: 'claude', system: fullSystem, prompt: user, model: settings.subscriptionModel || '' },
    { timeoutMs: 240000 },
  );
  return { data: extractJson(res.text), usage: res.usage || null, via: 'Claude subscription (local)' };
}

async function viaOpenAi(settings, prompt) {
  const { url, init } = buildOpenAiRequest(settings, prompt);
  const res = await fetch(url, init);
  const body = await res.json().catch(() => null);
  const text = readOpenAiResponse(res.status, body);
  return { data: extractJson(text), usage: body?.usage || null, via: `OpenAI API · ${body?.model || settings.openaiModel}` };
}

/** Your ChatGPT plan, through the Codex CLI on this computer (the helper runs it with its tools switched off). */
async function viaChatGpt(settings, { system, user, schema }) {
  const res = await helperRequest(
    { type: 'codex', prompt: `${jsonOnlySystem(system, schema)}\n\n${user}`, model: settings.chatgptModel || '' },
    { timeoutMs: 240000 },
  );
  return { data: extractJson(res.text), usage: null, via: 'ChatGPT subscription (local)' };
}

/**
 * @param settings {aiProvider:'api'|'subscription'|'openai'|'chatgpt'|'off', apiKey, model, effort, subscriptionModel, openaiKey, openaiModel, chatgptModel}
 * @param prompt   {system, user, schema, maxTokens?}
 */
export async function callAI(settings, prompt) {
  if (settings.aiProvider === 'api') return viaApi(settings, prompt);
  if (settings.aiProvider === 'subscription') return viaSubscription(settings, prompt);
  if (settings.aiProvider === 'openai') return viaOpenAi(settings, prompt);
  if (settings.aiProvider === 'chatgpt') return viaChatGpt(settings, prompt);
  throw new Error('AI is turned off. Choose a provider in StreamSnag settings.');
}
