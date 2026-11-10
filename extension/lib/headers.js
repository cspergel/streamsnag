// Many media CDNs reject requests that don't carry the original page as Referer/Origin.
// We add session-scoped declarativeNetRequest rules that set those headers only for requests the
// extension itself makes (tabId -1) to the media hosts of an active download.
import { hash32, hostOf } from './util.js';

const RULE_BASE = 10000;

function ruleIdFor(host) {
  return RULE_BASE + (hash32(host) % 1_000_000);
}

export async function applyRefererRules(urls, pageUrl) {
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
    priority: 1,
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
