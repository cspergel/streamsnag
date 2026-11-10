// Many media CDNs reject requests that don't carry the original page as Referer/Origin.
// We add session-scoped declarativeNetRequest rules that set those headers only for requests the
// extension itself makes (tabId -1) to the media hosts of an active download.
import { hash32, hostOf, isPrivateHost } from './util.js';

const RULE_BASE = 10000;

function ruleIdFor(host) {
  return RULE_BASE + (hash32(host) % 1_000_000);
}

// ---------------------------------------------------------------- local-network guard
// A public page must not be able to make StreamSnag poke your router, NAS or localhost: not directly, not
// through a redirect, and not through a preview image. Chrome enforces this for every request the
// extension itself makes (one block rule), so no code path can forget to check. Hosts are let through
// one at a time: those used by a page that is itself local, and one you clicked Download on.
const GUARD_RULE = 9000;
const ALLOW_BASE = 2_000_000;
/**
 * Same hosts as isPrivateHost (util.js), as URL patterns; tests/security.test.js keeps the two in step.
 * One small pattern per address family: Chrome refuses a rule whose pattern compiles to more than 2 KB.
 */
export const PRIVATE_URL_PATTERNS = [
  'localhost',
  '[^/:@]*\\.(?:localhost|local|lan|internal|home|corp|intranet)',
  '(?:127|10|0)\\.[0-9.]+',
  '172\\.(?:1[6-9]|2[0-9]|3[01])\\.[0-9.]+',
  '192\\.168\\.[0-9.]+',
  '169\\.254\\.[0-9.]+',
  '100\\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\.[0-9.]+',
  '\\[(?:::1|f[cd][0-9a-f][0-9a-f]:[0-9a-f:.]*|fe80:[0-9a-f:.]*)\\]',
].map((host) => `^https?://(?:[^/@]*@)?${host}(?::[0-9]+)?(?:[/?#]|$)`);

export async function installLocalGuard() {
  if (!chrome.declarativeNetRequest) return;
  const addRules = PRIVATE_URL_PATTERNS.map((regexFilter, i) => ({
    id: GUARD_RULE + i,
    priority: 2,
    action: { type: 'block' },
    condition: { regexFilter, initiatorDomains: [chrome.runtime.id] },
  }));
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: addRules.map((r) => r.id), addRules });
}

const allowed = new Set();
/**
 * Let StreamSnag reach the local hosts among `urls`: when the page is itself local (a dev server, a NAS's
 * own web page), or when you asked for this download yourself (`clicked`).
 */
export async function allowLocal(urls, pageUrl, clicked = false) {
  if (!chrome.declarativeNetRequest) return;
  const pageIsLocal = !!pageUrl && isPrivateHost(hostOf(pageUrl));
  if (!clicked && !pageIsLocal) return;
  const hosts = [...new Set(urls.map(hostOf).filter((x) => x && isPrivateHost(x) && !allowed.has(x)))];
  if (!hosts.length) return;
  const addRules = hosts.map((host) => ({
    id: ALLOW_BASE + (hash32(host) % 1_000_000),
    priority: 3,
    action: { type: 'allow' },
    condition: { requestDomains: [host.replace(/^\[|\]$/g, '')], initiatorDomains: [chrome.runtime.id] },
  }));
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: addRules.map((r) => r.id), addRules });
  hosts.forEach((x) => allowed.add(x));
}

export async function applyRefererRules(urls, pageUrl, clicked = false) {
  await allowLocal(urls, pageUrl, clicked).catch(() => {});
  if (!pageUrl || !chrome.declarativeNetRequest) return;
  let origin;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return;
  }
  const hosts = [...new Set(urls.map(hostOf).filter(Boolean))];
  if (!hosts.length) return;
  const addRules = hosts.map((host) => ({
    id: ruleIdFor(host),
    priority: 5,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        // The page's address without its query (tokens, search terms): what CDNs check is the site and path.
        { header: 'referer', operation: 'set', value: pageUrl.split(/[?#]/)[0] },
        { header: 'origin', operation: 'set', value: origin },
      ],
    },
    condition: {
      requestDomains: [host],
      tabIds: [chrome.tabs.TAB_ID_NONE],
      // Never touch our own AI calls.
      excludedRequestDomains: ['anthropic.com'],
    },
  }));
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: addRules.map((r) => r.id),
    addRules,
  });
}
