// Site recipes: small declarative extraction scripts (usually written by the AI, editable by you)
// that find media URLs on a site where plain network sniffing is not enough.
//
// A recipe is pure data, never code, so it can be saved, shared and reviewed safely:
// {
//   "site": "example.com",
//   "description": "Player config is embedded as JSON in a <script>",
//   "rules": [
//     { "type": "selector", "selector": "video[data-src]", "attr": "data-src" },
//     { "type": "regex", "source": "scripts", "pattern": "\"hls\":\"([^\"]+)\"", "group": 1, "unescape": true },
//     { "type": "fetch", "from": "/video/(\\d+)", "url": "https://example.com/api/video/{1}",
//       "pattern": "\"url\":\"([^\"]+\\.m3u8[^\"]*)\"", "group": 1, "unescape": true }
//   ],
//   "title":    [ { "type": "selector", "selector": "h1.lecture-title", "attr": "text" } ],
//   "captions": [ { "type": "regex", "source": "scripts", "pattern": "\"captions\":\"([^\"]+\\.vtt)\"" } ]
// }
// Sources for regex rules: "html" (page HTML), "scripts" (inline script text), "url" (page URL),
// "network" (URLs of requests the page made, one per line).
// "title" and "captions" are optional and written with the same three kinds of rule: where the lecture's own
// name is on the page (the first usable piece of text counts), and where its caption file is (an address).
import { isHttpUrl, resolveUrl, hostOf, siteKey, registrableDomain } from './util.js';

const RULE_TYPES = new Set(['selector', 'regex', 'fetch']);
const SOURCES = new Set(['html', 'scripts', 'url', 'network']);
const MAX_MATCHES = 50;
/** The most rules a part may have: the video's, and the two optional parts. */
const MAX_RULES = { rules: 20, title: 6, captions: 6 };
/** The longest name a title rule may give. */
export const MAX_TITLE = 200;
/** The most caption files one run of a rule lists. */
export const MAX_CAPTIONS = 6;

/** Undo JSON/JS string escaping that commonly wraps URLs inside page scripts. */
export function unescapeJsString(s) {
  return String(s)
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');
}

/**
 * The only way a pattern from a rule becomes a regular expression: a string of at most 500 characters,
 * without nested quantifiers, with flags from "gimsu" only. null when it is refused.
 */
export function safeRegex(pattern, flags) {
  if (typeof pattern !== 'string' || !pattern || pattern.length > 500) return null;
  // Nested quantifiers like (a+)+ or (\w*)* can freeze the browser on a long page: refuse them.
  if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/.test(pattern)) return null;
  const f = String(flags || 'g').replace(/[^gimsu]/g, '');
  try {
    return new RegExp(pattern, f.includes('g') ? f : `${f}g`);
  } catch {
    return null;
  }
}

/** One part's rules, checked and tidied. `what`: how an error names the rule ("Rule", "Title rule", "Captions rule"). */
function normalizeRules(list, what, max) {
  return list.slice(0, max).map((r, i) => {
    const type = String(r?.type || '').toLowerCase();
    if (!RULE_TYPES.has(type)) throw new Error(`${what} ${i + 1}: unknown type "${r?.type}"`);
    const group = Number.isInteger(r.group) && r.group >= 0 ? r.group : 1;
    const unescape = r.unescape !== false;
    if (type === 'selector') {
      if (!r.selector) throw new Error(`${what} ${i + 1}: selector rule needs "selector"`);
      return { type, selector: String(r.selector), attr: String(r.attr || 'src') };
    }
    if (!safeRegex(r.pattern, r.flags)) throw new Error(`${what} ${i + 1}: invalid or missing "pattern"`);
    if (type === 'regex') {
      const source = SOURCES.has(r.source) ? r.source : 'html';
      return { type, source, pattern: r.pattern, flags: r.flags || '', group, unescape };
    }
    if (!r.url) throw new Error(`${what} ${i + 1}: fetch rule needs "url"`);
    return { type, from: String(r.from || ''), url: String(r.url), pattern: r.pattern, flags: r.flags || '', group, unescape };
  });
}

/**
 * Validate + normalise a recipe (from the AI or the editor). Throws a readable error.
 * A recipe says where the video is (`rules`); it may also say where the lecture's title and its caption
 * file are (`title`, `captions`: the same kinds of rule). A recipe that says nothing at all is refused.
 */
export function normalizeRecipe(input, fallbackSite = '') {
  if (!input || typeof input !== 'object') throw new Error('Recipe must be an object');
  const site = siteKey(String(input.site || fallbackSite || '').trim());
  if (!site) throw new Error('Recipe needs a "site" (e.g. example.com)');
  const part = (key) => (Array.isArray(input[key]) ? input[key] : []);
  if (!part('rules').length && !part('title').length && !part('captions').length) throw new Error('Recipe needs at least one rule');
  const rules = normalizeRules(part('rules'), 'Rule', MAX_RULES.rules);
  const title = normalizeRules(part('title'), 'Title rule', MAX_RULES.title);
  const captions = normalizeRules(part('captions'), 'Captions rule', MAX_RULES.captions);
  return {
    site, description: String(input.description || '').slice(0, 300), rules,
    ...(title.length ? { title } : {}), ...(captions.length ? { captions } : {}),
  };
}

function regexMatches(re, text, group, unescape) {
  const out = [];
  if (!text) return out;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) && out.length < MAX_MATCHES) {
    const v = m[group] ?? m[0];
    if (v) out.push(unescape ? unescapeJsString(v) : v);
    if (m[0] === '') re.lastIndex++;
  }
  return out;
}

const allRules = (recipe) => [...(recipe?.rules || []), ...(recipe?.title || []), ...(recipe?.captions || [])];

/** Selectors a recipe needs evaluated in the page (content script does this): the video's, the title's and the captions'. */
export function selectorsFor(recipe) {
  const seen = new Set();
  return allRules(recipe).filter((r) => r.type === 'selector').map((r) => ({ selector: r.selector, attr: r.attr }))
    .filter((s) => !seen.has(selectorKey(s)) && seen.add(selectorKey(s)));
}

export const selectorKey = (s) => `${s.selector}@@${s.attr}`;

/** Does any part of a recipe ask the site for another address (a "fetch" rule)? */
export function hasFetchRule(recipe) {
  return allRules(recipe).some((r) => r.type === 'fetch');
}

/** Fetch rules may only call the same site the page is on (no sending your cookies elsewhere). */
export function fetchAllowed(targetUrl, pageUrl) {
  if (!isHttpUrl(targetUrl)) return false;
  const a = siteKey(hostOf(targetUrl));
  const b = siteKey(hostOf(pageUrl));
  if (!a || !b) return false;
  // Same owner only: "learn.example.com" may fetch "api.example.com", but "a.github.io" may not fetch "b.github.io".
  return a === b || registrableDomain(a) === registrableDomain(b);
}

/** What a list of rules gives on a page: the raw pieces of text of each rule, in the rules' order ([[…], […]]). */
async function runRules(rules, snapshot, fetchText, log, what = 'rule') {
  const each = rules.map(() => []);
  const sources = {
    html: snapshot.html || '',
    scripts: (snapshot.scripts || []).join('\n'),
    url: snapshot.url || '',
    network: (snapshot.network || []).join('\n'),
  };
  for (const [i, rule] of rules.entries()) {
    try {
      if (rule.type === 'selector') {
        const hits = snapshot.selectorHits?.[selectorKey(rule)] || [];
        each[i].push(...hits);
        log.push(`${what} ${i + 1} (selector): ${hits.length} hit(s)`);
      } else if (rule.type === 'regex') {
        const hits = regexMatches(safeRegex(rule.pattern, rule.flags), sources[rule.source], rule.group, rule.unescape);
        each[i].push(...hits);
        log.push(`${what} ${i + 1} (regex/${rule.source}): ${hits.length} hit(s)`);
      } else if (rule.type === 'fetch') {
        let caps = [];
        if (rule.from) {
          const re = safeRegex(rule.from, '');
          const m = re ? (re.lastIndex = 0, re.exec(snapshot.url || '')) : null;
          if (!m) {
            log.push(`${what} ${i + 1} (fetch): "from" did not match the page URL`);
            continue;
          }
          caps = m;
        }
        const origin = (() => { try { return new URL(snapshot.url).origin; } catch { return ''; } })();
        const target = resolveUrl(
          rule.url.replace(/\{(\d+)\}/g, (_, n) => encodeURIComponent(caps[Number(n)] ?? '')).replace(/\{origin\}/g, origin),
          snapshot.url,
        );
        if (!fetchAllowed(target, snapshot.url)) {
          log.push(`${what} ${i + 1} (fetch): blocked — ${target} is not on the page's site`);
          continue;
        }
        // (No `fetchText`: this run may not ask the site for anything, so the rule is left out.)
        if (typeof fetchText !== 'function') {
          log.push(`${what} ${i + 1} (fetch): not asked on this run`);
          continue;
        }
        const body = await fetchText(target);
        const hits = regexMatches(safeRegex(rule.pattern, rule.flags), body, rule.group, rule.unescape);
        each[i].push(...hits);
        log.push(`${what} ${i + 1} (fetch ${target}): ${hits.length} hit(s)`);
      }
    } catch (e) {
      log.push(`${what} ${i + 1} failed: ${e.message}`);
    }
  }
  return each;
}

/** A piece of a page as a name: no markup, single spaces, at most MAX_TITLE characters. */
export function tidyTitle(text) {
  return String(text ?? '').replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' }[e]))
    .replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE).trim();
}

/**
 * Run a recipe against a page snapshot.
 * @param recipe normalised recipe
 * @param snapshot {url, html, scripts: string[], network: string[], selectorHits: {[key]: string[]}}
 * @param fetchText async (url) => string  (used by fetch rules; without it they are left out)
 * @returns {Promise<{urls: string[], title: string, captions: string[], log: string[], by: object}>}
 *   `urls`: where the video is; `title`: the lecture's name ('' when the recipe names none, or found none);
 *   `captions`: addresses of its caption files. Everything here is text from the page: the caller decides
 *   what may be asked for and what is listed. `by`: what each single rule gave ({ rules: [[addresses]…],
 *   title: [[names]…], captions: [[addresses]…] }), so a rule that gave nothing can be told from one that worked.
 */
export async function runRecipe(recipe, snapshot, fetchText) {
  const log = [];
  const addresses = (values) => {
    const found = new Set();
    for (const v of values) {
      const abs = resolveUrl(String(v).trim(), snapshot.url);
      if (abs && isHttpUrl(abs)) found.add(abs);
    }
    return [...found];
  };
  const named = (t) => t.length >= 3 && /\p{L}/u.test(t);
  const by = {
    rules: (await runRules(recipe.rules || [], snapshot, fetchText, log, 'rule')).map(addresses),
    title: (await runRules(recipe.title || [], snapshot, fetchText, log, 'title rule')).map((list) => list.map(tidyTitle).filter(named)),
    captions: (await runRules(recipe.captions || [], snapshot, fetchText, log, 'captions rule')).map(addresses),
  };
  const urls = [...new Set(by.rules.flat())];
  const title = by.title.flat()[0] || '';
  const captions = [...new Set(by.captions.flat())].slice(0, MAX_CAPTIONS);
  return { urls, title, captions, log, by };
}

/**
 * A recipe without the rules that proved nothing on the page it was tried on: what is kept for a site is
 * only what worked there. `by`: what each rule gave (runRecipe); `real`: the addresses that answered as real
 * videos; `captions`: those that hold captions; `title`: the name that was used ('' when none was).
 * A part with nothing left is left out; null when nothing is left at all.
 */
export function provenRecipe(recipe, by, { real = [], captions = [], title = '' } = {}) {
  const [videos, subs] = [new Set(real), new Set(captions)];
  const keep = (rules, gave, ok) => (rules || []).filter((_, i) => (gave?.[i] || []).some(ok));
  const rules = keep(recipe.rules, by?.rules, (u) => videos.has(u));
  // (Of the title's rules, the first that gave the name that was used: the others were never needed.)
  const firstTitle = title ? (recipe.title || []).findIndex((_, i) => (by?.title?.[i] || []).includes(title)) : -1;
  const titleRules = firstTitle >= 0 ? [recipe.title[firstTitle]] : [];
  const captionRules = keep(recipe.captions, by?.captions, (u) => subs.has(u));
  if (!rules.length && !titleRules.length && !captionRules.length) return null;
  return {
    site: recipe.site, description: recipe.description || '', rules,
    ...(titleRules.length ? { title: titleRules } : {}), ...(captionRules.length ? { captions: captionRules } : {}),
  };
}

/**
 * The rule for a page: your own for its site (or for the site it is part of) wins; else a built-in one.
 * `own`: the saved recipes by site; `builtins`: the shipped list. A built-in one comes back marked
 * `builtin: true`, and is never written into `own`.
 */
export function recipeFor(own, url, builtins = []) {
  const key = url ? siteKey(url) : '';
  if (!key) return null;
  const parent = registrableDomain(key);
  const mine = own && (Object.hasOwn(own, key) ? own[key] : Object.hasOwn(own, parent) ? own[parent] : null);
  if (mine) return mine;
  const built = builtins.find((r) => r.site === key) || builtins.find((r) => r.site === parent);
  return built ? { ...built, builtin: true } : null;
}

/**
 * A recipe in plain words, for the list in Settings: "Finds the video, the lecture's title and its captions
 * in the page." (and that it asks the site for one more address, when it does).
 */
export function recipeWords(recipe) {
  const finds = [recipe?.rules?.length ? 'the video' : '', recipe?.title?.length ? 'the lecture\'s title' : '', recipe?.captions?.length ? 'its captions' : ''].filter(Boolean);
  const list = finds.length > 1 ? `${finds.slice(0, -1).join(', ')} and ${finds.at(-1)}` : finds[0] || 'nothing';
  return `Finds ${list} in the page${hasFetchRule(recipe) ? ', and asks the site itself for one more address to do it' : ''}.`;
}
