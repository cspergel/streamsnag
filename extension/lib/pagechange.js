// A page whose address changes without a load (a single-page app going from one video to the next):
// which of the listed videos belong to the page left behind, which of those are still there (a player
// that stays across pages), and when such a one has gone. Pure, shared by the service worker and the tests.

/** Without a click to go by: what was found this long before the address changed is taken to be the new page's. */
export const GRACE_MS = 4000;

/**
 * The moment the new page starts: what was found after it is the new page's. An app often starts loading
 * the next video just before it changes the address, so that is the click that led there (`clickAt`, the
 * last one in the page, when it was within the grace), or else four seconds back.
 */
export function graceStart(now, clickAt = 0) {
  const from = now - GRACE_MS;
  return clickAt > from && clickAt <= now ? clickAt : from;
}

/** The list at an address change: { stay } (found since `from`) and { left } (the page left behind's). */
export function splitAtChange(media, from) {
  const stay = [];
  const left = [];
  for (const m of media || []) (m.detectedAt > from ? stay : left).push(m);
  return { stay, left };
}

const keysOf = (m) => [m.key, ...(m.aliases || [])];

/**
 * A video of the page left behind is seen again (its player still has it, or it is still being loaded):
 * the item itself is taken out of `left` and returned, marked `carried`, under the name it had. One that
 * had no name yet takes its own page's title, never the new page's. null when `key` is none of them.
 * `by`: { frameId, src? }: the frame that has it (and, for a stream, the player's own source).
 */
export function comeBack(left, key, by = {}) {
  const at = (left || []).findIndex((m) => keysOf(m).includes(key));
  if (at < 0) return null;
  const [m] = left.splice(at, 1);
  m.carried = true;
  m.carriedBy = by.frameId || 0;
  if (by.src) m.carriedSrc = by.src;
  if (!m.title && !m.customName && m.pageTitle) Object.assign(m, { title: m.pageTitle, nameSource: 'title' });
  return m;
}

/**
 * The carried videos a frame no longer has, going by its report: `have` (the addresses its players and
 * links show now, as keys) and `blobs` (the sources of its players that play a stream). A file or a
 * caption file goes when the frame's report no longer lists it; a stream that was kept because a player
 * was still playing it (`carriedSrc`) goes when no player has that source. A stream that came back
 * because it was asked for again is not judged by the page's elements.
 */
export function leftBehind(media, frameId, have, blobs) {
  return (media || []).filter((m) => {
    if (!m.carried || (m.carriedBy || 0) !== frameId) return false;
    if (m.carriedSrc) return !blobs.has(m.carriedSrc);
    if (m.kind !== 'direct' && m.kind !== 'subtitle') return false;
    return !keysOf(m).some((k) => have.has(k));
  });
}
