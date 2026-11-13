// The way out when StreamSnag finds nothing on a page, or the wrong thing: "Scan again", then "Ask your AI
// to find it". What is pure about it lives here, so the tests read it too: the words on the buttons and the
// lines, what the sheet says before anything is sent, which addresses an AI answer may point at, what
// counts as a real caption file, and which video a rule's title names.
import { hostOf, isHttpUrl, isPrivateHost, registrableDomain, siteKey } from './util.js';
import { parseCues, imageCues, hasWords } from './transcript.js';
import { weakName } from './naming.js';

// ---------------------------------------------------------------- words

export const SCAN_AGAIN = 'Scan again';
export const ASK_AI = 'Ask your AI to find it';
export const SET_UP_AI = 'Set up an AI account and it can look for the video';
export const WRONG_VIDEO = 'Not the right video?';
/** The same two lines under a sound recording: it is never called a video. */
export const wrongWords = (audio = false) => (audio ? 'Not the right recording?' : WRONG_VIDEO);
export const setUpAiWords = (audio = false) => (audio ? 'Set up an AI account and it can look for the recording' : SET_UP_AI);
/** Said where the action is offered: whose account it uses, and that nothing goes out on that click. */
export const ASK_AI_NOTE = 'Uses your own AI account, at your own cost. You see what would be sent first.';

/**
 * "StreamSnag will find videos on example.edu this way from now on." (followed by Undo). `what`: 'name' when
 * all that was kept is where the lecture's name is (the video itself was found the ordinary way).
 */
export const rememberedLine = (site, what = 'find') => `StreamSnag will ${what === 'name' ? 'name' : 'find'} videos on ${site} this way from now on.`;
/** After Undo. */
export const forgottenLine = (site) => `Undone. StreamSnag will not do this by itself on ${site}.`;
/** Found, but no way of finding it again could be kept. */
export const ONCE_ONLY = 'This was found for this page only. On another page of this site, ask again.';

/**
 * What the popup says after the AI has answered: { title, lines }. `found`: videos its answer led to that
 * were checked and are real; `fresh`: how many of those were not listed before it was asked (left out:
 * all of them); `named`: the name its rule gave the lecture; `refused`: addresses it named that
 * StreamSnag would not ask for.
 */
export function findOutcome({ found = 0, fresh = found, captions = 0, named = '', refused = 0 } = {}) {
  const lines = [];
  if (named) lines.push(`It is called “${named}”.`);
  if (captions) lines.push(captions === 1 ? 'Its caption file is listed too.' : `${captions} caption files are listed too.`);
  if (refused) lines.push(`${refused === 1 ? 'One address it named was' : `${refused} addresses it named were`} left out: not part of this page, or on your own network.`);
  if (fresh > 0) return { title: fresh === 1 ? 'Your AI found the video. It is in the list now.' : `Your AI found ${fresh} videos. They are in the list now.`, lines };
  // Nothing new: what it pointed at was listed already. Said as it is, never as a find.
  if (found > 0) return { title: found === 1 ? 'Your AI pointed at the video that is already listed.' : `Your AI pointed at the ${found} videos that are already listed.`, lines };
  if (named) return { title: 'Your AI found no other video here, but it found what this one is called.', lines };
  return { title: 'Your AI did not find a video on this page.', lines };
}

// What an AI writes for the person is its own wording. It is shown on the first screen only when it is
// short and in plain words; otherwise it stays one click away, under "Details".
// @site-edition
const TECH_WORDS = /\b(recipes?|rules?|selectors?|regex(?:es)?|regular expressions?|HLS|DASH|MPD|m3u8|manifests?|playlists? files?|yt-dlp|ffmpeg|APIs?|iframes?|JSON(?:-LD)?|fetch(?:es|ed)?|endpoints?|hosts?|cross-origin|network log|DRM|blob|URLs?|HTML|scripts?)\b/i;
// @store-edition
// const TECH_WORDS = /\b(recipes?|rules?|selectors?|regex(?:es)?|regular expressions?|HLS|DASH|MPD|m3u8|manifests?|playlists? files?|ffmpeg|APIs?|iframes?|JSON(?:-LD)?|fetch(?:es|ed)?|endpoints?|hosts?|cross-origin|network log|DRM|blob|URLs?|HTML|scripts?)\b/i;
// @end-site-edition

/** The AI's advice as it may be shown on the first screen: '' when it is long or speaks of the machinery. */
export function plainAdvice(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t && t.length <= 320 && !TECH_WORDS.test(t) && !/https?:\/\//i.test(t) ? t : '';
}

// ---------------------------------------------------------------- before anything is sent

const KINDS = { subscription: 'plan', chatgpt: 'plan', gemini: 'free' };
const SHORT = { subscription: 'Claude', chatgpt: 'ChatGPT', api: 'Anthropic', openai: 'OpenAI', gemini: 'Google', deepseek: 'DeepSeek', openrouter: 'OpenRouter' };

/** The cost line, in the words the study tools' sheet uses: always that AI use is the user's own. */
export function findCost(provider) {
  const rest = 'AI use is billed by your own provider and is never part of StreamSnag\'s price.';
  const short = SHORT[provider];
  if (!short) return { lead: 'Charged by your AI provider.', rest };
  if (KINDS[provider] === 'plan') return { lead: `Counts toward your ${short} plan's limits.`, rest };
  if (KINDS[provider] === 'free') return { lead: 'Free within Google\'s daily allowance, then charged to your Google account.', rest };
  return { lead: `Charged to your ${short} account.`, rest };
}

const size = (chars) => (chars < 1500 ? 'Under 2 KB of text' : `About ${Math.round(chars / 1000)} KB of text`);
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What the sheet says before "Ask your AI to find it" sends anything: { looks, sends, detail, to, usage,
 * cost, then, text }. `prompt`: what would be sent ({ system, user }); `counts`: { network, snippets,
 * players }; `provider`: the account chosen in Settings and `providerLabel` its name there; `site`: the
 * page's site. `text` is exactly what would be sent, for "See exactly what is sent".
 */
export function findConfirm({ prompt, counts = {}, provider = '', providerLabel = '', site = '' } = {}) {
  const user = String(prompt?.user || '');
  const parts = [
    counts.network ? count(counts.network, 'address the page has loaded', 'addresses the page has loaded') : '',
    counts.snippets ? count(counts.snippets, 'piece of the page\'s code that mentions video', 'pieces of the page\'s code that mention video') : '',
    counts.players ? count(counts.players, 'player on the page', 'players on the page') : '',
  ].filter(Boolean);
  return {
    looks: 'The video on this page, and where its title and captions are',
    sends: 'This page\'s address and title, and the parts of its code that mention video',
    detail: `${size(user.length)}${parts.length ? `: ${parts.join(', ')}` : ''}. No passwords, cookies or files. If the page shows your name, that can be in it.`,
    to: providerLabel || 'your AI provider',
    usage: 'One request',
    cost: findCost(provider),
    then: site ? `If it finds the video, StreamSnag remembers how for ${site} and says so. You can undo that.` : '',
    text: user,
  };
}

/**
 * What the sheet says before "Summarize" sends anything: the same lines as findConfirm, plus the sheet's
 * own title. `prompt`: what would be sent ({ user }); `condensed`: the lecture is too long to send whole,
 * so evenly spaced parts of its captions go instead. `text` is exactly what would be sent.
 */
export function summaryConfirm({ prompt, provider = '', providerLabel = '', condensed = false } = {}) {
  const user = String(prompt?.user || '');
  return {
    title: 'Before your AI reads this lecture\'s captions',
    looks: 'A short summary of this lecture, with its key points',
    sends: 'The lecture\'s title and the text of its captions',
    detail: `${size(user.length)}${condensed ? ': a long lecture, so evenly spaced parts of its captions, not all of them' : ''}. Nothing else of the page. No passwords, cookies or files.`,
    to: providerLabel || 'your AI provider',
    usage: 'One request',
    cost: findCost(provider),
    then: 'The summary is shown here. Nothing is saved unless you press "Save .md".',
    text: user,
  };
}

/** The line that stands, before the question is asked, where the server's answer will be. */
export const WHY_LATER = 'HTTP STATUS and RESPONSE HEADERS: read from the file\'s server once you press "Ask your AI", and added here.';

/**
 * What the sheet says before "Ask AI why" sends anything about a failed download. Nothing has been asked
 * of the file's server at this point, so its answer (status and headers) is not in `prompt` yet: the
 * sheet says that it will be read and sent, and `text` is everything else that would be sent, ending in
 * the line that says so. `prompt`: what is known now ({ user }).
 */
export function whyConfirm({ prompt, provider = '', providerLabel = '' } = {}) {
  const user = String(prompt?.user || '');
  return {
    title: 'Before your AI looks at this failed download',
    looks: 'Why this download failed, and what to try next',
    sends: 'The error message, this page\'s address, the file\'s address and what the file\'s server answers',
    detail: `${size(user.length)}, plus the server's answer (its status and headers). The file's server has not been asked anything yet: it is asked once, when you agree. The file's address is sent whole and can hold a temporary access key. No passwords, cookies or files.`,
    to: providerLabel || 'your AI provider',
    usage: 'One request',
    cost: findCost(provider),
    then: 'The likely cause and what to try are shown under the failed download.',
    show: 'See what is sent',
    text: `${user}\n${WHY_LATER}`,
  };
}

// ---------------------------------------------------------------- which addresses an answer may point at

const HOST_IN_TEXT = /(?:https?:)?\\?\/\\?\/((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,23})(?![a-z0-9.-])/gi;
const MAX_HOSTS = 400;

/**
 * The servers a page itself names or has contacted: the hosts of the addresses in its markup, its inline
 * scripts and the requests it made. `snapshot`: { html, scripts, dom: { iframes, videos } }; `network`:
 * the addresses of its requests. A Set of host names in lower case.
 */
export function namedHosts(snapshot = {}, network = []) {
  const hosts = new Set();
  const add = (h) => { if (h && hosts.size < MAX_HOSTS) hosts.add(String(h).toLowerCase()); };
  for (const u of network || []) add(hostOf(typeof u === 'string' ? u : u?.url || ''));
  for (const u of snapshot.dom?.iframes || []) add(hostOf(u));
  const text = `${String(snapshot.html || '').slice(0, 600000)}\n${(snapshot.scripts || []).join('\n').slice(0, 1200000)}`;
  HOST_IN_TEXT.lastIndex = 0;
  for (let m = HOST_IN_TEXT.exec(text); m && hosts.size < MAX_HOSTS; m = HOST_IN_TEXT.exec(text)) add(m[1]);
  return hosts;
}

/**
 * May an address an AI answer names be asked for from this page? Only one that is part of the page: on the
 * page's own site, or on a server the page itself names or has contacted (`named`, see namedHosts; a server
 * of the same owner counts). And never one on the user's own network from a public page.
 * Returns '' when it may, else why not: 'not-web' | 'private' | 'unrelated'.
 */
export function refusedAddress(url, pageUrl, named = new Set()) {
  if (!isHttpUrl(url)) return 'not-web';
  const host = hostOf(url).toLowerCase();
  const pageHost = hostOf(pageUrl).toLowerCase();
  if (!host || !pageHost) return 'not-web';
  if (isPrivateHost(host) && !isPrivateHost(pageHost)) return 'private';
  const owner = registrableDomain(siteKey(host));
  if (siteKey(host) === siteKey(pageHost) || owner === registrableDomain(siteKey(pageHost))) return '';
  for (const h of named) if (h === host || registrableDomain(siteKey(h)) === owner) return '';
  return 'unrelated';
}

// ---------------------------------------------------------------- is it really what it says

/**
 * Is this the text of a caption file? It has cues with words in them, and it is not a thumbnail index
 * (a player's seek-bar pictures, every cue pointing at a picture).
 */
export function looksLikeCaptions(text) {
  const t = String(text ?? '');
  if (!t.trim() || /^\s*<(?:!doctype|html)/i.test(t)) return false;
  try {
    return parseCues(t).length > 0 && !imageCues(t) && hasWords(t);
  } catch {
    return false;
  }
}

/** A name a rule gave that can be used as a lecture's name ('' when it says nothing: a bare word, an address). */
export function ruleName(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t && !weakName(t) ? t : '';
}

/**
 * Which video a rule's title names: the one video the rule itself found; or, when the rule found none (it
 * only says where the title is), the page's one own video (not a file it only links to or lists, not a
 * playlist). null when that is several: a rule names one lecture, and never the trailer beside it.
 * `media`: the tab's items.
 */
export function titledByRule(media = []) {
  // (A video kept from the page left behind, `carried`, has the name it had there: a rule for this page does not speak of it.)
  const own = (media || []).filter((m) => m && m.kind !== 'subtitle' && !m.hidden && !m.dismissed && !m.playlist && !m.covered && !m.variantOf && !m.carried);
  const found = own.filter((m) => m.source === 'recipe' || m.byRule);
  if (found.length) return found.length === 1 ? found[0] : null;
  const played = own.filter((m) => !m.linked && !m.listed);
  return played.length === 1 ? played[0] : null;
}
