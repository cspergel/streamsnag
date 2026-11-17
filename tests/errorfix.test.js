// Errors that carry the button that fixes them (planning/ERROR-FIX-BUTTONS.md), Claude's own failures in
// plain words, and one retry after a pause when an AI provider is busy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixFor, plainProblem, claudeCliProblem } from '../extension/lib/wording.js';
import { callAI, busyError, BUSY_PAUSE_MS, HELPER_MISSING } from '../extension/lib/ai-transport.js';

test('each kind of problem names the one button that fixes it, and nothing where no button would help', () => {
  const cases = [
    [HELPER_MISSING, 'helper'],
    ['Saved in Downloads: moving to your chosen folder needs the local helper.', 'helper'],
    ['Picture and sound were saved as two files. Set up the local helper (in Settings) to join them.', 'helper'],
    ['Transcription is not set up yet. Open Settings, go to Local helper and click "Set up transcription".', 'helper'],
    ['Local helper timed out', 'checkHelper'],
    ['Local helper disconnected: Native host has exited.', 'checkHelper'],
    ['Listing a playlist needs ffmpeg. Install it with "winget install Gyan.FFmpeg", then try again.', 'checkHelper'],
    ['FILE_ACCESS_DENIED', 'folder'],
    ['The file could not be written to your Downloads folder. Check the folder, then try again.', 'folder'],
    ['There is not enough room on the disk. Free some space, then try again.', 'folder'],
    ['Couldn\'t move to D:\\Lectures (EACCES: permission denied); left in Downloads.', 'folder'],
    ['DeepSeek did not accept the API key. Check it in StreamSnag settings.', 'ai'],
    ['Your OpenRouter account is out of credit. Add credit there, or choose another AI provider.', 'ai'],
    ['The Codex CLI is not signed in. Run "codex login" once and choose "Sign in with ChatGPT".', 'ai'],
    ['Claude Code CLI not found. Install it with "npm i -g @anthropic-ai/claude-code" and run "claude" once to sign in.', 'ai'],
    ['AI is turned off. Choose a provider in StreamSnag settings.', 'ai'],
    ['That media item is gone — reload the page.', 'rescan'],
    ['The link may have expired. Reload the page and press play.', 'rescan'],
    // Nothing to press: it cannot be saved, or "Retry" beside it already is the fix.
    ['This one is protected by the site, so it can\'t be saved.', ''],
    ['The link expired or the site refused it. Reload the page, press play, and try again.', ''],
    ['StreamSnag couldn\'t read this one. Reload the page, press play, then try again.', ''],
    ['The connection dropped. Check your internet, then try again.', ''],
    ['', ''],
  ];
  const wrong = cases.filter(([text, kind]) => fixFor(text) !== kind).map(([text, kind]) => `${text} → ${fixFor(text)} (want ${kind || 'none'})`);
  assert.deepEqual(wrong, []);
  // plainProblem carries it, worked out from what was really reported (a code becomes a sentence; the fix stays).
  const p = plainProblem('FILE_NO_SPACE');
  assert.match(p.text, /room on the disk/);
  assert.equal(p.fix, 'folder');
  assert.equal(plainProblem('Not an HLS playlist (missing #EXTM3U)').fix, '');
});

test('Claude\'s own failures (the subscription route) are said in words a student can act on, never "Claude CLI error"', () => {
  const signIn = claudeCliProblem('Claude CLI error: Invalid API key · Please run /login');
  assert.match(signIn, /not signed in, or its sign-in has expired.*run "claude" once and sign in/);
  assert.match(claudeCliProblem('Claude CLI error: OAuth token has expired. Please obtain a new token or refresh your existing token.'), /sign-in has expired/);
  assert.match(claudeCliProblem('Claude CLI error: Claude AI usage limit reached|1794700000'), /usage limit for now/);
  assert.match(claudeCliProblem('Claude CLI error: Credit balance is too low'), /out of credit/);
  assert.match(claudeCliProblem('Claude CLI error: API Error: 529 {"type":"overloaded_error"}'), /busy right now/);
  const other = claudeCliProblem('Claude CLI error: something new\nwith its last line');
  assert.match(other, /could not answer \(with its last line\)/);
  for (const t of [signIn, other]) assert.doesNotMatch(t, /Claude CLI error/);
  // And each says which button helps: sign-in, limit and credit go to AI settings; "busy" waits.
  assert.equal(fixFor(signIn), 'ai');
  assert.equal(fixFor(claudeCliProblem('usage limit reached')), 'ai');
  assert.equal(fixFor(claudeCliProblem('overloaded')), '');
});

// ---- callAI against a stubbed network: what is really sent, and how often.
function stubChrome(native) {
  globalThis.chrome = { runtime: { getPlatformInfo: () => {}, connectNative: native, lastError: null } };
}
function stubFetch(replies) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const [status, body] = replies[Math.min(calls.length - 1, replies.length - 1)];
    return { status, json: async () => body };
  };
  return calls;
}
const ok = { choices: [{ message: { content: '{"answer":"yes"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } };
const deepseek = { aiProvider: 'deepseek', deepseekKey: 'sk-test', deepseekModel: 'deepseek-flash' };
const prompt = { system: 'Answer.', user: 'Is it?', schema: { type: 'object', properties: { answer: { type: 'string' } } } };

test('a busy AI provider (429, 5xx) is asked once more after a pause; a refusal is not asked again', async () => {
  stubChrome(() => { throw new Error('no helper'); });
  const waits = [];
  const wait = async (ms) => { waits.push(ms); };

  let calls = stubFetch([[429, { error: { message: 'Rate limit reached', code: 429 } }], [200, ok]]);
  const res = await callAI(deepseek, prompt, { wait });
  assert.deepEqual(res.data, { answer: 'yes' });
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [BUSY_PAUSE_MS]);

  // Busy twice: the second failure is the one shown, and there is no third request.
  waits.length = 0;
  calls = stubFetch([[503, { error: { message: 'Service unavailable' } }]]);
  await assert.rejects(callAI(deepseek, prompt, { wait }), /DeepSeek error: Service unavailable/);
  assert.equal(calls.length, 2);

  // A refused key or no credit: one request, at once, no pause.
  waits.length = 0;
  calls = stubFetch([[401, { error: { message: 'bad key' } }]]);
  await assert.rejects(callAI(deepseek, prompt, { wait }), /did not accept the API key/);
  assert.equal(calls.length, 1);
  calls = stubFetch([[402, { error: { message: 'Insufficient Balance' } }]]);
  await assert.rejects(callAI(deepseek, prompt, { wait }), /out of credit/);
  assert.equal(calls.length, 1);
  assert.deepEqual(waits, []);

  // What counts as busy.
  assert.equal(busyError(Object.assign(new Error('x'), { status: 429 })), true);
  assert.equal(busyError(Object.assign(new Error('x'), { status: 500 })), true);
  assert.equal(busyError(Object.assign(new Error('x'), { status: 499 })), false);
  assert.equal(busyError(new Error('Claude is busy right now. Try again in a minute.')), true);
  assert.equal(busyError(new Error('Your Claude plan has reached its usage limit for now.')), false);
});

test('the Claude subscription route turns the helper\'s "Claude CLI error" into plain words before anyone sees it', async () => {
  const listeners = { msg: [], gone: [] };
  stubChrome(() => ({
    onMessage: { addListener: (f) => listeners.msg.push(f) },
    onDisconnect: { addListener: (f) => listeners.gone.push(f) },
    disconnect: () => {},
    postMessage: (m) => queueMicrotask(() => listeners.msg.forEach((f) => f({ id: m.id, type: 'error', error: 'Claude CLI error: Invalid API key · Please run /login' }))),
  }));
  const e = await callAI({ aiProvider: 'subscription' }, prompt, { wait: async () => {} }).catch((x) => x);
  assert.match(e.message, /^Claude on this computer is not signed in/);
  assert.equal(e.raw, 'Claude CLI error: Invalid API key · Please run /login');
  assert.equal(plainProblem(e.message).fix, 'ai');
});
