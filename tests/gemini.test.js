// The Google Gemini route: request and response shaping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGeminiRequest, readGeminiResponse, GEMINI_DEFAULT_MODEL, GEMINI_HOST } from '../extension/lib/gemini.js';
import { jsonOnlySystem } from '../extension/lib/openai.js';

const prompt = { system: 'Be brief.', user: 'Page: https://example.com', schema: { type: 'object', properties: { ok: { type: 'boolean' } } }, maxTokens: 900 };

test('Gemini request: goes only to Google\'s API host, with the key in a header and never in the address', () => {
  const { url, init } = buildGeminiRequest({ geminiKey: '  AIza-test-123  ', geminiModel: 'gemini-3.5-flash-lite' }, prompt);
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
  assert.ok(url.startsWith(`${GEMINI_HOST}/`));
  assert.equal(url.includes('AIza'), false, 'the key is not part of the URL');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['x-goog-api-key'], 'AIza-test-123');
  const body = JSON.parse(init.body);
  assert.equal(body.systemInstruction.parts[0].text, jsonOnlySystem(prompt.system, prompt.schema));
  assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'Page: https://example.com' }] }]);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.equal(body.generationConfig.maxOutputTokens, 900);
});

test('Gemini request: no key is a clear error, an empty model uses the default, a strange model is refused', () => {
  assert.throws(() => buildGeminiRequest({ geminiKey: '' }, prompt), /No Gemini API key/);
  assert.throws(() => buildGeminiRequest({ geminiKey: '   ' }, prompt), /No Gemini API key/);
  assert.ok(buildGeminiRequest({ geminiKey: 'k', geminiModel: '' }, prompt).url.endsWith(`/models/${GEMINI_DEFAULT_MODEL}:generateContent`));
  assert.equal(JSON.parse(buildGeminiRequest({ geminiKey: 'k' }, { ...prompt, maxTokens: undefined }).init.body).generationConfig.maxOutputTokens, 16000);
  // A model name is part of the address, so nothing that could change the path or add a query is allowed.
  for (const bad of ['a/b', '../x', 'm?key=1', 'm:streamGenerateContent', 'a b', 'x#y', 'a%2Fb']) {
    assert.throws(() => buildGeminiRequest({ geminiKey: 'k', geminiModel: bad }, prompt), /Invalid model/, bad);
  }
});

const reply = (parts, extra = {}) => ({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', ...extra }] });

test('Gemini response: the answer text is returned, joined across parts, without the model\'s thinking', () => {
  assert.equal(readGeminiResponse(200, reply([{ text: '{"ok":true}' }])), '{"ok":true}');
  assert.equal(readGeminiResponse(200, reply([{ text: 'pondering', thought: true }, { text: '{"a":' }, { text: '1}' }])), '{"a":1}');
});

test('Gemini response: limits, bad keys, blocks, cut-off and empty answers each say what went wrong', () => {
  assert.throws(() => readGeminiResponse(429, { error: { code: 429, message: 'Quota exceeded for metric generate_content_free_tier_requests', status: 'RESOURCE_EXHAUSTED' } }),
    /free allowance or rate limit is used up.*Quota exceeded/);
  assert.throws(() => readGeminiResponse(200, { error: { message: 'slow down', status: 'RESOURCE_EXHAUSTED' } }), /free allowance or rate limit/);
  assert.throws(() => readGeminiResponse(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }), /did not accept the API key/);
  assert.throws(() => readGeminiResponse(403, { error: { message: 'Permission denied' } }), /did not accept the API key/);
  assert.throws(() => readGeminiResponse(404, { error: { message: 'models/nope is not found' } }), /Gemini error: models\/nope is not found/);
  assert.throws(() => readGeminiResponse(500, null), /Gemini error: HTTP 500/);
  assert.throws(() => readGeminiResponse(200, { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }), /declined this request \(prohibited content\)/);
  assert.throws(() => readGeminiResponse(200, reply([{ text: '{"a":' }], { finishReason: 'MAX_TOKENS' })), /cut off/);
  assert.throws(() => readGeminiResponse(200, reply([], { finishReason: 'SAFETY' })), /empty answer \(safety\)/);
  assert.throws(() => readGeminiResponse(200, reply([{ text: '   ' }])), /empty answer\.$/);
  assert.throws(() => readGeminiResponse(200, {}), /empty answer/);
  assert.throws(() => readGeminiResponse(200, reply([{ text: 'only thinking', thought: true }])), /empty answer/);
});
