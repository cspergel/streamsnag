// The course strip: one small cell for every video on a busy page, so forty lectures read as one line of
// facts (saved, to get, worth a look, can't be saved) instead of a list to scroll. Pure: the popup hands it
// the list's own statuses and draws what comes back; the tests run it on its own.

/** A page gets the strip once it lists this many videos. Under that, the list itself is short enough. */
export const STRIP_MIN = 8;

/** The states a cell can be in, in the order the legend names them. */
export const STRIP_STATES = ['saved', 'busy', 'get', 'check', 'cant'];

/**
 * One video's cell. `status` is the list's own ('done' | 'active' | 'queued' | 'new' | 'failed' | 'missing'),
 * `flagged`: "Download all" would leave it out unless ticked (a short clip, a preview, a copy, no name),
 * `blocked`: it can't be downloaded at all (protected, a live stream, a playlist).
 * A file you have is "saved" whatever else is true of it; a download in progress is "busy".
 */
export function cellState({ status = 'new', flagged = false, blocked = false } = {}) {
  if (status === 'done') return 'saved';
  if (status === 'active' || status === 'queued') return 'busy';
  if (blocked) return 'cant';
  if (flagged) return 'check';
  return 'get';
}

/**
 * The cells of a page, in page order: [{ id, state, here, name }]. `items`: [{ id, name, status, flagged,
 * blocked, order }]; `here`: the id of the video in front of the user (playing, or on the big card).
 */
export function stripCells(items = [], { here = '' } = {}) {
  return [...items]
    .map((x, i) => ({ x, i }))
    .sort((a, b) => (a.x.order ?? 1e9) - (b.x.order ?? 1e9) || a.i - b.i)
    .map(({ x }) => ({ id: x.id, state: cellState(x), here: !!here && x.id === here, name: String(x.name || '') }));
}

/** How many cells are in each state: { saved, busy, get, check, cant, total }. */
export function stripCounts(cells = []) {
  const counts = { saved: 0, busy: 0, get: 0, check: 0, cant: 0, total: cells.length };
  for (const c of cells) if (c.state in counts) counts[c.state]++;
  return counts;
}

const WORDS = {
  saved: (n) => `${n} saved`,
  busy: (n) => `${n} saving now`,
  get: (n) => `${n} to get`,
  check: (n) => `${n} to check`,
  cant: (n) => `${n} can't be saved`,
};

/** The legend under the strip: one entry for each state that has any, [{ state, n, text }]. */
export function stripLegend(counts = {}) {
  return STRIP_STATES.filter((s) => counts[s] > 0).map((s) => ({ state: s, n: counts[s], text: WORDS[s](counts[s]) }));
}

/**
 * The strip in one sentence, for a screen reader: "40 videos on this page: 13 saved, 21 to get, 4 to check, 2 can't be saved."
 * `noun`: what the cells are, in the singular ("video"; "recording" on a page that also has sound files).
 */
export function stripSummary(counts = {}, noun = 'video') {
  const n = counts.total || 0;
  const parts = stripLegend(counts).map((l) => l.text);
  return `${n} ${noun}${n === 1 ? '' : 's'} on this page${parts.length ? `: ${parts.join(', ')}` : ''}.`;
}

/**
 * How the cells are laid out so a long course still fits: { cols, size, rows }. Twenty to a row up to 60
 * videos, thirty up to 150, then forty (up to 240) and fifty in smaller cells, so 80 videos take three rows
 * and 300 take six.
 */
export function stripLayout(n) {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  const [cols, size] = count <= 60 ? [20, 'l'] : count <= 150 ? [30, 'm'] : count <= 240 ? [40, 's'] : [50, 's'];
  return { cols, size, rows: Math.ceil(count / cols) };
}

/**
 * The button under the strip, which opens the review sheet: "Download the 21 missing…". When only
 * "check these" videos are left it says so; '' when there is nothing left to download.
 */
export function stripAction(counts = {}) {
  if (counts.get > 0) return `Download the ${counts.get} missing…`;
  if (counts.check > 0) return `Review ${counts.check} to check…`;
  return '';
}
