// The ChatGPT routes: OpenAI API request/response shaping, and the locked-down Codex CLI call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenAiRequest, readOpenAiResponse, jsonOnlySystem, OPENAI_URL, OPENAI_DEFAULT_MODEL } from '../extension/lib/openai.js';
import { buildCodexArgs, codexError } from '../native-host/host.js';

const prompt = { system: 'Be brief.', user: 'Page: https://example.com', schema: { type: 'object', properties: { ok: { type: 'boolean' } } }, maxTokens: 900 };

test('OpenAI request: goes only to api.openai.com, carries the key as a bearer token, and asks for nothing to be stored', () => {
  const { url, init } = buildOpenAiRequest({ openaiKey: '  sk-test-123  ', openaiModel: 'gpt-6-luna' }, prompt);
  assert.equal(url, 'https://api.openai.com/v1/responses');
  assert.equal(url, OPENAI_URL);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.authorization, 'Bearer sk-test-123');
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'gpt-6-luna');
  assert.equal(body.store, false);
  assert.equal(body.max_output_tokens, 900);
  assert.deepEqual(body.input.map((m) => m.role), ['system', 'user']);
  assert.equal(body.input[1].content, 'Page: https://example.com');
  assert.ok(body.input[0].content.startsWith('Be brief.'));
  assert.ok(body.input[0].content.includes(JSON.stringify(prompt.schema)), 'the JSON shape is part of the instructions');
  assert.equal(body.input[0].content, jsonOnlySystem(prompt.system, prompt.schema));
});

test('OpenAI request: no key is a clear error, an empty model falls back to the default, a strange model is refused', () => {
  assert.throws(() => buildOpenAiRequest({ openaiKey: '' }, prompt), /No OpenAI API key/);
  assert.throws(() => buildOpenAiRequest({ openaiKey: '   ' }, prompt), /No OpenAI API key/);
  assert.equal(JSON.parse(buildOpenAiRequest({ openaiKey: 'k', openaiModel: '' }, prompt).init.body).model, OPENAI_DEFAULT_MODEL);
  assert.equal(JSON.parse(buildOpenAiRequest({ openaiKey: 'k' }, { ...prompt, maxTokens: undefined }).init.body).max_output_tokens, 16000);
  for (const bad of ['gpt 6', 'x"y', '-m', 'a/b', 'a\nb']) assert.throws(() => buildOpenAiRequest({ openaiKey: 'k', openaiModel: bad }, prompt), /Invalid model/, bad);
});

const reply = (content, extra = {}) => ({ status: 'completed', output: [{ type: 'reasoning', summary: [] }, { type: 'message', role: 'assistant', content }], ...extra });

test('OpenAI response: the text of the message is returned, joined across parts', () => {
  assert.equal(readOpenAiResponse(200, reply([{ type: 'output_text', text: '{"ok":true}' }])), '{"ok":true}');
  assert.equal(readOpenAiResponse(200, reply([{ type: 'output_text', text: '{"a":' }, { type: 'output_text', text: '1}' }])), '{"a":1}');
});

test('OpenAI response: errors, refusals, cut-off and empty answers each say what went wrong', () => {
  assert.throws(() => readOpenAiResponse(401, { error: { message: 'Incorrect API key provided: sk-secret' } }), (e) => /did not accept the API key/.test(e.message) && !/sk-secret/.test(e.message));
  assert.throws(() => readOpenAiResponse(429, { error: { message: 'You exceeded your current quota' } }), /rate-limiting or out of credit: You exceeded/);
  assert.throws(() => readOpenAiResponse(400, { error: { message: 'The model `nope` does not exist' } }), /OpenAI error: The model `nope` does not exist/);
  assert.throws(() => readOpenAiResponse(500, null), /OpenAI error: HTTP 500/);
  assert.throws(() => readOpenAiResponse(200, { error: { message: 'boom' } }), /OpenAI error: boom/);
  assert.throws(() => readOpenAiResponse(200, reply([{ type: 'refusal', refusal: 'I can\'t help with that.' }])), /ChatGPT declined this request: I can't help/);
  assert.throws(() => readOpenAiResponse(200, reply([{ type: 'output_text', text: '{"a":' }], { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })), /cut off/);
  assert.throws(() => readOpenAiResponse(200, reply([])), /empty answer/);
  assert.throws(() => readOpenAiResponse(200, { status: 'completed' }), /empty answer/);
  assert.throws(() => readOpenAiResponse(200, reply([{ type: 'output_text', text: '   ' }])), /empty answer/);
});

test('Codex CLI call: no shell, no browser, read-only, ignores the user\'s own Codex setup, prompt on stdin', () => {
  const a = buildCodexArgs({ model: '', outFile: '/tmp/answer.txt' });
  assert.equal(a[0], 'exec');
  assert.equal(a.at(-1), '-');
  for (const flag of ['--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules']) assert.ok(a.includes(flag), flag);
  assert.equal(a[a.indexOf('-s') + 1], 'read-only');
  assert.equal(a[a.indexOf('-o') + 1], '/tmp/answer.txt');
  const disabled = a.map((x, i) => (x === '--disable' ? a[i + 1] : null)).filter(Boolean);
  for (const f of ['shell_tool', 'browser_use', 'computer_use', 'apps', 'plugins', 'multi_agent']) assert.ok(disabled.includes(f), `${f} is switched off`);
  assert.equal(a.includes('-m'), false);
  assert.equal(a.some((x) => /dangerously|workspace-write|danger-full-access/.test(x)), false);

  const m = buildCodexArgs({ model: 'gpt-6-astra', outFile: 'o.txt' });
  assert.equal(m[m.indexOf('-m') + 1], 'gpt-6-astra');
  assert.equal(m.at(-1), '-');
  for (const bad of ['--dangerously-bypass-approvals-and-sandbox', '-c', 'a b', 'x;y', 'a"b']) assert.throws(() => buildCodexArgs({ model: bad, outFile: 'o' }), /Invalid model/, bad);
});

test('Codex CLI errors are turned into something a person can act on', () => {
  const old = 'ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-6-astra\' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."}}';
  assert.match(codexError(old), /requires a newer version of Codex.*npm i -g @openai\/codex@latest/);
  const plan = 'ERROR: {"error":{"message":"The \'gpt-5\' model is not supported when using Codex with a ChatGPT account.","code":"model_not_found"}}';
  assert.match(codexError(plan), /not supported when using Codex.*set a model your plan includes/);
  assert.match(codexError('Error: Not logged in. Run codex login'), /codex login/);
  assert.match(codexError('something odd\nlast line here'), /Codex CLI error: last line here/);
  assert.match(codexError(''), /Codex CLI error: unknown/);
});
