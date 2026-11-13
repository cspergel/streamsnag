// DeepSeek and OpenRouter: request and response shaping for the chat-completions format.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChatRequest, readChatResponse, chatUsage, CHAT_PROVIDERS } from '../extension/lib/chatapi.js';
import { jsonOnlySystem } from '../extension/lib/openai.js';

const prompt = { system: 'Be brief.', user: 'Lecture text…', schema: { type: 'object', properties: { ok: { type: 'boolean' } } }, maxTokens: 900 };

test('DeepSeek request: its own host, bearer key, the cheap model by default, JSON mode and no thinking', () => {
  const { url, init } = buildChatRequest('deepseek', { deepseekKey: '  sk-test  ' }, prompt);
  assert.equal(url, 'https://api.deepseek.com/chat/completions');
  assert.equal(init.headers.authorization, 'Bearer sk-test');
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'deepseek-flash');
  assert.deepEqual(body.messages, [{ role: 'system', content: jsonOnlySystem(prompt.system, prompt.schema) }, { role: 'user', content: 'Lecture text…' }]);
  assert.equal(body.max_tokens, 900);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(JSON.parse(buildChatRequest('deepseek', { deepseekKey: 'k', deepseekModel: 'deepseek-v4-pro' }, prompt).init.body).model, 'deepseek-v4-pro');
  assert.equal(JSON.parse(buildChatRequest('deepseek', { deepseekKey: 'k', deepseekModel: 'deepseek-v4-pro' }, prompt, { model: 'deepseek-flash' }).init.body).model, 'deepseek-flash', 'a per-call model wins');
  assert.equal(JSON.parse(buildChatRequest('deepseek', { deepseekKey: 'k' }, { ...prompt, maxTokens: 0 }).init.body).max_tokens, 16000);
});

test('OpenRouter request: its own host, the model the user picked, and no model means a clear ask', () => {
  const { url, init } = buildChatRequest('openrouter', { openrouterKey: 'sk-or-1', openrouterModel: 'anthropic/claude-haiku-5.5' }, prompt);
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(init.headers.authorization, 'Bearer sk-or-1');
  assert.equal(init.headers['X-Title'], 'StreamSnag');
  assert.equal('HTTP-Referer' in init.headers || 'referer' in init.headers, false, 'no page address is sent as attribution');
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'anthropic/claude-haiku-5.5');
  assert.equal('thinking' in body, false);
  assert.throws(() => buildChatRequest('openrouter', { openrouterKey: 'k' }, prompt), /Choose a model for OpenRouter/);
  assert.equal(JSON.parse(buildChatRequest('openrouter', { openrouterKey: 'k', openrouterModel: 'meta/llama-4:free' }, prompt).init.body).model, 'meta/llama-4:free');
});

test('requests refuse a missing key, an unknown provider, and model names that are not model names', () => {
  assert.throws(() => buildChatRequest('deepseek', { deepseekKey: '   ' }, prompt), /No DeepSeek API key/);
  assert.throws(() => buildChatRequest('openrouter', {}, prompt), /No OpenRouter API key/);
  for (const p of ['nope', 'constructor', '__proto__', 'toString', '']) assert.throws(() => buildChatRequest(p, { deepseekKey: 'k' }, prompt), /Unknown AI provider/, p);
  for (const bad of ['a b', 'a/b/c', '../x', 'm?x=1', 'x"y', '/lead', 'trail/', 'a:b:c', 'x'.repeat(121)]) {
    assert.throws(() => buildChatRequest('openrouter', { openrouterKey: 'k', openrouterModel: bad }, prompt), /Invalid model name/, bad);
  }
  // Nothing in the provider table can be changed at run time (it holds the hosts keys are sent to).
  assert.throws(() => { CHAT_PROVIDERS.deepseek.url = 'https://evil.example'; }, TypeError);
});

const reply = (message, extra = {}) => ({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', ...message }, ...extra }], usage: { prompt_tokens: 1200, completion_tokens: 300, prompt_cache_hit_tokens: 200 } });

test('responses: the text comes back, as a string or as parts', () => {
  assert.equal(readChatResponse('deepseek', 200, reply({ content: '{"ok":true}' })), '{"ok":true}');
  assert.equal(readChatResponse('openrouter', 200, reply({ content: [{ type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }] })), '{"a":1}');
});

test('responses: bad key, no credit, rate limit, cut-off, refusal and empty answers each say what to do', () => {
  assert.throws(() => readChatResponse('deepseek', 401, { error: { message: 'Authentication Fails, Your api key: ****abcd is invalid' } }),
    (e) => /DeepSeek did not accept the API key/.test(e.message) && !/abcd/.test(e.message));
  assert.throws(() => readChatResponse('deepseek', 402, { error: { message: 'Insufficient Balance' } }), /DeepSeek account is out of credit/);
  assert.throws(() => readChatResponse('openrouter', 200, { error: { code: 402, message: 'Insufficient credits' } }), /OpenRouter account is out of credit/);
  assert.throws(() => readChatResponse('openrouter', 429, { error: { code: 429, message: 'Rate limit exceeded: free-models-per-day' } }), /OpenRouter is rate-limiting.*free-models-per-day/);
  assert.throws(() => readChatResponse('openrouter', 404, { error: { code: 404, message: 'No endpoints found for nope/model' } }), /OpenRouter error: No endpoints found/);
  assert.throws(() => readChatResponse('deepseek', 500, null), /DeepSeek error: HTTP 500/);
  assert.throws(() => readChatResponse('deepseek', 200, reply({ content: '{"a":' }, { finish_reason: 'length' })), /cut off/);
  assert.throws(() => readChatResponse('deepseek', 200, reply({ content: '' }, { finish_reason: 'content_filter' })), /declined this request \(content filter\)/);
  assert.throws(() => readChatResponse('openrouter', 200, reply({ content: null, refusal: 'I cannot help with that.' })), /OpenRouter declined this request: I cannot help/);
  assert.throws(() => readChatResponse('deepseek', 200, reply({ content: '  ' })), /DeepSeek returned an empty answer/);
  assert.throws(() => readChatResponse('deepseek', 200, {}), /empty answer/);
});

test('usage: tokens, cached tokens and the cost when the provider reports one', () => {
  assert.deepEqual(chatUsage(reply({ content: 'x' })), { inputTokens: 1200, outputTokens: 300, cachedTokens: 200, cost: null });
  assert.deepEqual(chatUsage({ usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0004, prompt_tokens_details: { cached_tokens: 3 } } }), { inputTokens: 10, outputTokens: 5, cachedTokens: 3, cost: 0.0004 });
  assert.deepEqual(chatUsage(null), { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: null });
});
