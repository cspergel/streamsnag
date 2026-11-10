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
//   ]
// }
// Sources for regex rules: "html" (page HTML), "scripts" (inline script text), "url" (page URL),
// "network" (URLs of requests the page made, one per line).
import { isHttpUrl, resolveUrl, hostOf, siteKey, registrableDomain } from './util.js';

const RULE_TYPES = new Set(['selector', 'regex', 'fetch']);
const SOURCES = new Set(['html', 'scripts', 'url', 'network']);
const MAX_MATCHES = 50;

/** Undo JSON/JS string escaping that commonly wraps URLs inside page scripts. */
export function unescapeJsString(s) {
  return String(s)
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');
}

function safeRegex(pattern, flags) {
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

/** Validate + normalise a recipe (from the AI or the editor). Throws a readable error. */
export function normalizeRecipe(input, fallbackSite = '') {
  if (!input || typeof input !== 'object') throw new Error('Recipe must be an object');
  const site = siteKey(String(input.site || fallbackSite || '').trim());
  if (!site) throw new Error('Recipe needs a "site" (e.g. example.com)');
  if (!Array.isArray(input.rules) || !input.rules.length) throw new Error('Recipe needs at least one rule');
  const rules = input.rules.slice(0, 20).map((r, i) => {
    const type = String(r?.type || '').toLowerCase();
    if (!RULE_TYPES.has(type)) throw new Error(`Rule ${i + 1}: unknown type "${r?.type}"`);
    const group = Number.isInteger(r.group) && r.group >= 0 ? r.group : 1;
    const unescape = r.unescape !== false;
    if (type === 'selector') {
      if (!r.selector) throw new Error(`Rule ${i + 1}: selector rule needs "selector"`);
      return { type, selector: String(r.selector), attr: String(r.attr || 'src') };
    }
    if (!safeRegex(r.pattern, r.flags)) throw new Error(`Rule ${i + 1}: invalid or missing "pattern"`);
    if (type === 'regex') {
      const source = SOURCES.has(r.source) ? r.source : 'html';
      return { type, source, pattern: r.pattern, flags: r.flags || '', group, unescape };
    }
    if (!r.url) throw new Error(`Rule ${i + 1}: fetch rule needs "url"`);
    return { type, from: String(r.from || ''), url: String(r.url), pattern: r.pattern, flags: r.flags || '', group, unescape };
  });
  return { site, description: String(input.description || '').slice(0, 300), rules };
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

/** Selectors a recipe needs evaluated in the page (content script does this). */
export function selectorsFor(recipe) {
  return (recipe?.rules || []).filter((r) => r.type === 'selector').map((r) => ({ selector: r.selector, attr: r.attr }));
}

export const selectorKey = (s) => `${s.selector}@@${s.attr}`;

/** Fetch rules may only call the same site the page is on (no sending your cookies elsewhere). */
export function fetchAllowed(targetUrl, pageUrl) {
  if (!isHttpUrl(targetUrl)) return false;
  const a = siteKey(hostOf(targetUrl));
  const b = siteKey(hostOf(pageUrl));
  if (!a || !b) return false;
  // Same owner only: "learn.example.com" may fetch "api.example.com", but "a.github.io" may not fetch "b.github.io".
  return a === b || registrableDomain(a) === registrableDomain(b);
}

/**
 * Run a recipe against a page snapshot.
 * @param recipe normalised recipe
 * @param snapshot {url, html, scripts: string[], network: string[], selectorHits: {[key]: string[]}}
 * @param fetchText async (url) => string  (used by fetch rules)
 * @returns {Promise<{urls: string[], log: string[]}>}
 */
export async function runRecipe(recipe, snapshot, fetchText) {
  const found = new Set();
  const log = [];
  const add = (v) => {
    const abs = resolveUrl(String(v).trim(), snapshot.url);
    if (abs && isHttpUrl(abs)) found.add(abs);
  };
  const sources = {
    html: snapshot.html || '',
    scripts: (snapshot.scripts || []).join('\n'),
    url: snapshot.url || '',
    network: (snapshot.network || []).join('\n'),
  };

  for (const [i, rule] of recipe.rules.entries()) {
    try {
      if (rule.type === 'selector') {
        const hits = snapshot.selectorHits?.[selectorKey(rule)] || [];
        hits.forEach(add);
        log.push(`rule ${i + 1} (selector): ${hits.length} hit(s)`);
      } else if (rule.type === 'regex') {
        const hits = regexMatches(safeRegex(rule.pattern, rule.flags), sources[rule.source], rule.group, rule.unescape);
        hits.forEach(add);
        log.push(`rule ${i + 1} (regex/${rule.source}): ${hits.length} hit(s)`);
      } else if (rule.type === 'fetch') {
        let caps = [];
        if (rule.from) {
          const re = safeRegex(rule.from, '');
          const m = re ? (re.lastIndex = 0, re.exec(snapshot.url || '')) : null;
          if (!m) {
            log.push(`rule ${i + 1} (fetch): "from" did not match the page URL`);
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
          log.push(`rule ${i + 1} (fetch): blocked — ${target} is not on the page's site`);
          continue;
        }
        const body = await fetchText(target);
        const hits = regexMatches(safeRegex(rule.pattern, rule.flags), body, rule.group, rule.unescape);
        hits.forEach(add);
        log.push(`rule ${i + 1} (fetch ${target}): ${hits.length} hit(s)`);
      }
    } catch (e) {
      log.push(`rule ${i + 1} failed: ${e.message}`);
    }
  }
  return { urls: [...found], log };
}
