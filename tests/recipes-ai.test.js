import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRecipe, runRecipe, fetchAllowed, unescapeJsString, selectorsFor, selectorKey } from '../extension/lib/recipes.js';
import { extractJson, normalizeFindResult, buildFindPrompt, normalizeSummary, summaryToMarkdown } from '../extension/lib/ai.js';

const page = {
  url: 'https://www.videosite.com/watch/12345',
  html: '<div data-video="https://cdn.videosite.com/v/12345/master.m3u8"></div>',
  scripts: ['var cfg = {"file":"https:\\/\\/cdn.videosite.com\\/mp4\\/12345_720.mp4?x=1\\u0026y=2"};'],
  network: ['https://cdn.videosite.com/ads/pre.mp4', 'https://api.videosite.com/track'],
  selectorHits: { 'video source@@src': ['/media/12345.webm'] },
};

test('recipe runs selector, regex (with JSON unescape) and same-site fetch rules', async () => {
  const recipe = normalizeRecipe({
    site: 'www.videosite.com',
    rules: [
      { type: 'selector', selector: 'video source', attr: 'src' },
      { type: 'regex', source: 'scripts', pattern: '"file":"([^"]+)"', group: 1 },
      { type: 'regex', source: 'html', pattern: 'data-video="([^"]+)"', group: 1 },
      { type: 'fetch', from: '/watch/(\\d+)', url: '{origin}/api/video/{1}', pattern: '"dash":"([^"]+)"', group: 1 },
    ],
  });
  assert.equal(recipe.site, 'videosite.com');
  const fetched = [];
  const res = await runRecipe(recipe, page, async (u) => {
    fetched.push(u);
    return '{"dash":"https://cdn.videosite.com/d/12345.mpd"}';
  });
  assert.deepEqual(fetched, ['https://www.videosite.com/api/video/12345']);
  assert.deepEqual(res.urls.sort(), [
    'https://cdn.videosite.com/d/12345.mpd',
    'https://cdn.videosite.com/mp4/12345_720.mp4?x=1&y=2',
    'https://cdn.videosite.com/v/12345/master.m3u8',
    'https://www.videosite.com/media/12345.webm',
  ]);
});

test('fetch rules to another site are blocked and never called', async () => {
  const recipe = normalizeRecipe({ site: 'videosite.com', rules: [{ type: 'fetch', url: 'https://evil.example/steal', pattern: '(.*)' }] });
  let called = false;
  const res = await runRecipe(recipe, page, async () => { called = true; return ''; });
  assert.equal(called, false);
  assert.equal(res.urls.length, 0);
  assert.match(res.log[0], /blocked/);
});

test('fetchAllowed: same registrable domain allowed, others not', () => {
  assert.equal(fetchAllowed('https://api.videosite.com/x', 'https://www.videosite.com/watch'), true);
  assert.equal(fetchAllowed('https://videosite.com.evil.io/x', 'https://www.videosite.com/watch'), false);
  assert.equal(fetchAllowed('javascript:alert(1)', 'https://www.videosite.com/'), false);
});

test('normalizeRecipe rejects bad input with a readable error', () => {
  assert.throws(() => normalizeRecipe({ site: 'a.com', rules: [] }), /at least one rule/);
  assert.throws(() => normalizeRecipe({ site: 'a.com', rules: [{ type: 'eval', code: 'x' }] }), /unknown type/);
  assert.throws(() => normalizeRecipe({ site: 'a.com', rules: [{ type: 'regex', pattern: '([' }] }), /invalid or missing "pattern"/);
  assert.throws(() => normalizeRecipe({ rules: [{ type: 'selector', selector: 'video' }] }), /needs a "site"/);
});

test('selectorsFor lists selector rules with stable keys', () => {
  const r = normalizeRecipe({ site: 'a.com', rules: [{ type: 'selector', selector: 'video', attr: 'src' }, { type: 'regex', pattern: 'x(y)' }] });
  const sels = selectorsFor(r);
  assert.deepEqual(sels, [{ selector: 'video', attr: 'src' }]);
  assert.equal(selectorKey(sels[0]), 'video@@src');
});

test('unescapeJsString', () => {
  assert.equal(unescapeJsString('https:\\/\\/a.com\\/x?a=1\\u0026b=2'), 'https://a.com/x?a=1&b=2');
});

test('extractJson handles fenced and prose-wrapped JSON, and fails on none', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here you go: {"a":{"b":"}"}} thanks'), { a: { b: '}' } });
  assert.throws(() => extractJson('no json here'), /no JSON/);
  assert.throws(() => extractJson('{"a": '), /incomplete/);
});

test('normalizeFindResult drops non-http candidates, dedupes, builds a recipe from flat rules', () => {
  const raw = {
    summary: 'Found HLS',
    candidates: [
      { url: 'https://cdn.a.com/m.m3u8', kind: 'hls', label: '1080p', confidence: 'high' },
      { url: 'https://cdn.a.com/m.m3u8', kind: 'hls', label: 'dup', confidence: 'high' },
      { url: 'javascript:alert(1)', kind: 'direct', label: 'bad', confidence: 'low' },
      { url: 'https://player.b.com/embed/1', kind: 'weird', label: '', confidence: 'nope' },
    ],
    recipe_rules: [{ type: 'regex', selector: '', attr: '', source: 'scripts', from: '', url: '', pattern: '"hls":"([^"]+)"', group: 1 }],
    recipe_description: 'player json',
    advice: '',
  };
  const r = normalizeFindResult(raw, 'https://www.a.com/v/1');
  assert.equal(r.candidates.length, 2);
  assert.equal(r.candidates[1].kind, 'direct'); // unknown kind coerced
  assert.equal(r.candidates[1].confidence, 'low');
  assert.equal(r.recipe.site, 'a.com');
  assert.equal(r.recipe.rules[0].source, 'scripts');
  assert.equal(r.recipeError, '');
});

test('normalizeFindResult reports an unusable recipe instead of throwing', () => {
  const r = normalizeFindResult({ candidates: [], recipe_rules: [{ type: 'regex', pattern: '(' }] }, 'https://a.com/');
  assert.equal(r.recipe, null);
  assert.match(r.recipeError, /pattern/);
});

test('buildFindPrompt includes page facts and stays under the size cap', () => {
  const p = buildFindPrompt({
    pageUrl: 'https://a.com/v', pageTitle: 'My Video',
    network: Array.from({ length: 1000 }, (_, i) => ({ url: `https://a.com/req/${i}?${'x'.repeat(300)}`, status: 200, contentType: 'application/json' })),
    dom: { videos: [{ src: 'blob:https://a.com/1' }] },
    snippets: ['"hls":"https://cdn/x.m3u8"'],
  });
  assert.match(p.user, /PAGE URL: https:\/\/a\.com\/v/);
  assert.match(p.user, /blob:https:\/\/a\.com\/1/); // DOM evidence survives a huge network log
  assert.match(p.user, /cdn\/x\.m3u8/); // so do script snippets
  assert.match(p.user, /req\/999\?/); // newest network entries are the ones kept
  assert.doesNotMatch(p.user, /req\/0\?/); // oldest dropped
  assert.ok(p.user.length <= 60000, `prompt was ${p.user.length} chars`);
  assert.ok(p.schema.properties.candidates);
});

test('summary normalisation and markdown', () => {
  const s = normalizeSummary({ title: 'T', summary: 'S', key_points: [{ timestamp: '1:00', point: 'P' }, { point: '' }] });
  assert.equal(s.keyPoints.length, 1);
  const md = summaryToMarkdown(s, 'https://a.com');
  assert.match(md, /^# T/);
  assert.match(md, /- \*\*1:00\*\* P/);
  assert.match(md, /Source: https:\/\/a\.com/);
});
