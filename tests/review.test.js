import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REASONS, BLOCKED, usableName, looksLikePromo, flagItems, courseOrder, reviewGroups, numberNames, sameFileNames,
  splitName, folderTrail, reviewSummary, docKinds, foldedIds, foldLine, FOLDED,
} from '../extension/lib/review.js';

// A listed video as the popup hands it to lib/review.js. `order` is its place on the page.
let seq = 0;
const item = (id, name, duration = 0, extra = {}) => ({
  id, name, borrowed: false, url: `https://cdn.example.com/v/${id}/master.m3u8`, duration, kind: 'hls', mediaType: 'stream',
  playlist: false, protected: false, live: false, height: 720, size: 0, order: seq++, status: 'new', ...extra,
});
const flags = (items, ctx) => Object.fromEntries(flagItems(items, ctx));
const LECTURES = () => [item('l1', '001: Heart sounds', 1800), item('l2', '002: Atrial fibrillation', 2400), item('l3', '003: Valve disease', 2100)];

test('every reason has a label for the sheet, and the list tags say the same plain words', () => {
  // (Round 4, F12: 'sound' is new: the sound file of a lecture the page has as a video is not "a second copy".)
  assert.deepEqual(Object.keys(REASONS), ['copy', 'sound', 'promo', 'short', 'audio', 'samename', 'noname', 'appeared']);
  assert.equal(REASONS.sound.label, 'The same lecture, sound only');
  assert.equal(REASONS.sound.tag, 'The same lecture, sound only');
  assert.equal(REASONS.samename.label, 'Same name as another one');
  assert.equal(REASONS.short.label, 'Short clip');
  assert.equal(REASONS.noname.label, 'No name');
  assert.equal(REASONS.promo.label, 'Looks like a preview or ad');
  assert.equal(REASONS.copy.label, 'Same as another one');
  assert.equal(REASONS.audio.label, 'Sound only');
  assert.equal(REASONS.appeared.label, 'Just appeared');
  // U8: the list's tags are the sheet's own words, not "copy" / "preview" in small capitals.
  for (const key of ['short', 'noname', 'promo', 'copy', 'audio', 'samename']) assert.equal(REASONS[key].tag, REASONS[key].label, key);
  assert.equal(REASONS.appeared.tag, '');
});

// ------------------------------------------------------------------ short clip

test('short clip: under a minute next to a video of five minutes or more', () => {
  assert.deepEqual(flags([item('a', 'Lecture one', 300), item('b', 'Welcome back', 59)]), { b: 'short' });
  assert.deepEqual(flags([item('a', 'Lecture one', 300), item('b', 'Welcome back', 60)]), {}, '60 s is not "under a minute"');
  assert.deepEqual(flags([item('a', 'Lecture one', 299), item('b', 'Welcome back', 59)]), {}, 'no video of five minutes on the page');
  assert.deepEqual(flags([item('a', 'Lecture one', 3600), item('b', 'Welcome back', 10), item('c', 'Hello', 59.9)]), { b: 'short', c: 'short' });
});

test('short clip: under a fifth of the usual length, once three lengths are known', () => {
  // The usual length (median) is 200 s: a fifth of it is 40 s.
  assert.deepEqual(flags([item('a', 'One', 200), item('b', 'Two', 240), item('c', 'Outro', 39)]), { c: 'short' });
  assert.deepEqual(flags([item('a', 'One', 200), item('b', 'Two', 240), item('c', 'Outro', 40)]), {}, 'exactly a fifth is not under it');
  // Two lengths are not enough to say what is usual (and there is no five-minute video).
  assert.deepEqual(flags([item('a', 'One', 240), item('b', 'Outro', 39)]), {});
  // An even number of lengths: the usual length is halfway between the two middle ones (150 s → under 30 s).
  assert.deepEqual(flags([item('a', 'One', 100), item('b', 'Two', 200), item('c', 'Three', 250), item('d', 'Outro', 29)]), { d: 'short' });
  assert.deepEqual(flags([item('a', 'One', 100), item('b', 'Two', 200), item('c', 'Three', 250), item('d', 'Outro', 31)]), {});
  // A long clip can be "short" too, next to very long ones: 9 min among 50-minute lectures.
  assert.deepEqual(flags([item('a', 'One', 3000), item('b', 'Two', 3000), item('c', 'Recap', 540)]), { c: 'short' });
});

test('short clip: never on a page where every video is short, and never without a length', () => {
  assert.deepEqual(flags([item('a', 'Reel one', 50), item('b', 'Reel two', 45), item('c', 'Reel three', 5)]), {}, 'all under a minute: short is normal here');
  assert.deepEqual(flags([item('a', 'One', 30), item('b', 'Two', 31)]), {});
  assert.deepEqual(flags([item('a', 'Lecture one', 3600), item('b', 'Unknown length', 0)]), {});
});

// ------------------------------------------------------------------ no name

test('usableName: empty, numbers, generic words, the site itself and machine ids are not names', () => {
  for (const bad of ['', '   ', '42', 'video', 'Video', 'Player', 'Untitled', 'untitled-2', 'Video 3', 'video (1)', 'Video Player', 'master', 'index']) {
    assert.equal(usableName(bad), false, JSON.stringify(bad));
  }
  for (const good of ['Heart sounds', '001: Heart sounds', 'Lecture 3', 'Part 2', 'Videography basics', 'lecture01', 'deadbeef']) {
    assert.equal(usableName(good), true, good);
  }
  const at = { site: 'learn.example.com' };
  assert.equal(usableName('learn.example.com', at), false);
  assert.equal(usableName('example.com', at), false);
  assert.equal(usableName('Example', at), false);
  assert.equal(usableName('Example course intro', at), true);
  assert.equal(usableName('www.example.com', { url: 'https://www.example.com/watch/1' }), false, 'the site is read from the address when not given');
  // File hashes and ids: hex with digits, a uuid, a long run of letters and digits.
  for (const id of ['9f8a3c21d07b', 'a1b2c3d4', '3f2b8c1e-7a4d-4e9b-b1c2-0d9e8f7a6b5c', 'x7Kp29LmQ4tZ81vB', '9f8a3c21d07b.mp4']) assert.equal(usableName(id), false, id);
  assert.equal(usableName('20240115'), false, 'only digits');
  assert.equal(usableName('Lecture 9f8a3c21'), true, 'an id inside a real name is fine');
});

test('no name: flagged when at least as many videos on the page do have a name of their own', () => {
  assert.deepEqual(flags([...LECTURES(), item('x', '', 1500)]), { x: 'noname' });
  assert.deepEqual(flags([...LECTURES(), item('x', 'player', 1500)]), { x: 'noname' });
  assert.deepEqual(flags([...LECTURES(), item('x', 'cdn.example.com', 1500)]), { x: 'noname' }, 'named after the host its address is on');
  // Named only by the tab's title while the others have their own names: that is not its name.
  assert.deepEqual(flags([...LECTURES(), item('x', 'Cardio course', 1500, { borrowed: true })]), { x: 'noname' });
  // One with, one without: flagged. Two without, one with: that is how the page is, nothing is flagged.
  assert.deepEqual(flags([item('a', 'Heart sounds', 1500), item('x', '', 1700)]), { x: 'noname' });
  assert.deepEqual(flags([item('a', 'Heart sounds', 1500), item('x', '', 1700), item('y', '', 1900)]), {});
  // A page where everything carries the tab's title: nothing is flagged.
  const tabNamed = [1, 2, 3].map((n) => item(`t${n}`, 'Cardio course', 1000 + n * 100, { borrowed: true }));
  assert.deepEqual(flags(tabNamed), {});
});

// ------------------------------------------------------------------ preview or ad

test('preview or ad: the keyword as a whole word, first in the name or on a brief video', () => {
  const promo = (name, duration = 0, url = undefined) => looksLikePromo({ name, duration, ...(url ? { url } : {}) });
  // First word (a lecture number in front doesn't count), length unknown or not long.
  for (const name of ['Trailer', 'Trailer: next season', 'PREVIEW of week 4', '03 - Preview of week 4', 'Promo', 'Teaser clip', 'Advert', 'Sponsor message', 'Bumper', 'Sample lesson']) {
    assert.equal(promo(name), true, name);
    assert.equal(promo(name, 299), true, `${name} (just under five minutes)`);
  }
  // Whole words only.
  for (const name of ['Samples of tissue', 'Trailers and caravans', 'Previewing your work', 'Resample the signal', 'Promotion strategy', 'Sponsorship']) {
    assert.equal(promo(name), false, name);
    assert.equal(promo(name, 30), false, `${name} (brief)`);
  }
  // First word, but a long video: a lecture that happens to start with the word.
  assert.equal(promo('Sample size calculation', 300), false);
  assert.equal(promo('Sample size calculation', 2700), false);
  assert.equal(promo('Preview of the exam', 3600), false);
  // Elsewhere in the name: only on a brief video (under two minutes).
  assert.equal(promo('Tissue sample preparation', 2700), false);
  assert.equal(promo('Tissue sample preparation'), false, 'length unknown');
  assert.equal(promo('Course trailer', 119), true);
  assert.equal(promo('Course trailer', 120), false, 'two minutes is not brief');
  assert.equal(promo('Our sponsor says hello', 20), true);
});

test('preview or ad: the address counts the same way (file name first, else only when brief)', () => {
  const at = (url, duration = 0, name = 'Lecture') => looksLikePromo({ name, duration, url });
  assert.equal(at('https://cdn.example.com/media/trailer.mp4'), true);
  assert.equal(at('https://cdn.example.com/media/promo_2024-final.mp4'), true, '"_" ends a word in a file name');
  assert.equal(at('https://cdn.example.com/media/Sample%20clip.mp4'), true, 'the address is decoded first');
  assert.equal(at('https://cdn.example.com/media/trailer.mp4', 600), false, 'long');
  assert.equal(at('https://cdn.example.com/preview/lecture-3/master.m3u8'), false, 'a folder called "preview", length unknown');
  assert.equal(at('https://cdn.example.com/preview/lecture-3/master.m3u8', 2400), false);
  assert.equal(at('https://cdn.example.com/preview/lecture-3/master.m3u8', 45), true, 'a brief video from a "preview" folder');
  assert.equal(at('https://preview.example.com/lecture-3/master.m3u8', 45), false, 'the host name is not looked at');
  assert.equal(at('https://cdn.example.com/media/samples.mp4', 45), false, 'whole words only');
  assert.equal(at('not an address', 45), false);
  // In a list, it is the item's reason.
  assert.deepEqual(flags([...LECTURES(), item('t', 'Trailer: next season', 90)]), { t: 'promo' });
});

// ------------------------------------------------------------------ same as another one

test('copy: same length within a second and the same name; the higher quality stays', () => {
  const hd = item('hd', '002: Atrial fibrillation', 2400, { height: 1080 });
  const sd = item('sd', '002 - atrial  fibrillation!', 2400.9, { height: 360 });
  assert.deepEqual(flags([item('l1', '001: Heart sounds', 1800), sd, hd]), { sd: 'copy' }, 'names compare without case, spaces or punctuation');
  // More than a second apart: not the same video, but two files of one name are worth a look (U14).
  assert.deepEqual(flags([hd, { ...sd, duration: 2401.1 }]), { sd: 'samename' });
  assert.deepEqual(flags([hd, { ...sd, duration: 2401 }]), { sd: 'copy' }, 'exactly a second apart still counts');
  // Same length, different names: not copies.
  assert.deepEqual(flags([hd, item('other', '003: Valve disease', 2400, { height: 360 })]), {});
  // Without a length only the name can tell: the same name is the same lecture a second time (U14).
  assert.deepEqual(flags([{ ...hd, duration: 0 }, { ...sd, duration: 0 }]), { sd: 'copy' });
  // Without a length and without a name of its own, nothing can be compared.
  assert.deepEqual(flags([{ ...hd, duration: 0, name: '' }, item('bare', '', 0)]), {});
});

test('U14: one file per lecture: the same lecture as .mp4 and as .ogv keeps the MP4, whatever their sizes', () => {
  const file = (id, ext, size) => item(id, 'MIT 6.041 Probabilistic Systems Analysis', 0, { kind: 'direct', mediaType: 'video', height: 0, ext, size });
  const mp4 = file('mp4', 'mp4', 113e6);
  const ogv = file('ogv', 'ogv', 216e6);
  assert.deepEqual(flags([ogv, mp4]), { ogv: 'copy' });
  assert.deepEqual(flags([mp4, ogv]), { ogv: 'copy' });
  const g = reviewGroups([ogv, mp4]);
  assert.deepEqual(g.ready, [{ id: 'mp4' }]);
  assert.deepEqual(g.check, [{ id: 'ogv', reason: 'copy' }]);
  // A higher quality still beats the file type.
  assert.deepEqual(flags([{ ...mp4, height: 360 }, { ...ogv, height: 720 }]), { mp4: 'copy' });
  // A lecture's player and the "Download video" link beside it, under one name and with no length known:
  // the player's video is the one kept (it has the captions), the link is the copy.
  const player = item('player', 'Lecture 1: Probability Models', 0, { kind: 'embed', mediaType: 'video', height: 0 });
  const link = item('link', 'Lecture 1: Probability Models', 0, { kind: 'direct', mediaType: 'video', height: 0, ext: 'mp4', size: 440e3, linked: true });
  assert.deepEqual(flags([link, player]), { link: 'copy' });
  assert.deepEqual(flags([player, link, item('other', 'Lecture 2: Conditioning', 0, { kind: 'embed' })]), { link: 'copy' });
  // Three recordings of one name at three lengths: one is ticked, the others wait under "Check these".
  const takes = [item('a', 'Guest lecture', 1800), item('b', 'Guest lecture', 2400), item('c', 'Guest lecture', 600)];
  assert.deepEqual(Object.values(flags(takes)), ['samename', 'samename']);
  assert.equal(reviewGroups(takes).ready.length, 1);
});

test('copy: which one stays: a name, then video over sound, quality, size, then the first on the page', () => {
  // One of the two has no name: the named one stays, even at a lower quality.
  const named = item('named', 'Heart sounds', 900, { height: 360 });
  const bare = item('bare', '', 900.5, { height: 1080 });
  assert.deepEqual(flags([bare, named]), { bare: 'copy' });
  // A name borrowed from the tab is no name of its own.
  assert.deepEqual(flags([{ ...bare, name: 'Cardio course', borrowed: true }, named]), { bare: 'copy' });
  // Video over a sound file of the same lecture.
  const sound = item('sound', 'Heart sounds', 900, { kind: 'direct', mediaType: 'audio', height: 0 });
  // (Round 4, F12: this used to be 'copy', shown as "Same as another one": it is the same lecture as sound, and says so.)
  assert.deepEqual(flags([sound, named]), { sound: 'sound' });
  // Same quality: the bigger file, then the one listed first.
  const big = item('big', 'Heart sounds', 900, { height: 360, size: 9e6, kind: 'direct', mediaType: 'video' });
  const small = item('small', 'Heart sounds', 900, { height: 360, size: 5e6, kind: 'direct', mediaType: 'video' });
  assert.deepEqual(flags([small, big]), { small: 'copy' });
  const first = item('first', 'Heart sounds', 900);
  const second = item('second', 'Heart sounds', 900);
  assert.deepEqual(flags([second, first]), { second: 'copy' }, 'page order, not list order');
  // Three of one video: one stays.
  assert.deepEqual(flags([first, second, { ...second, id: 'third', order: 99 }]), { second: 'copy', third: 'copy' });
  // An unnamed item of the same length does not tie two differently named videos together.
  const a = item('a', 'Heart sounds', 1200);
  const b = item('b', 'Valve disease', 1200);
  const u = item('u', '', 1200);
  assert.deepEqual(flags([a, u, b]), { u: 'copy' });
});

// ------------------------------------------------------------------ sound only, single pages, precedence

test('sound only: a sound file on a page that also has videos', () => {
  const mp3 = item('mp3', 'Podcast version', 1700, { kind: 'direct', mediaType: 'audio' });
  assert.deepEqual(flags([...LECTURES(), mp3]), { mp3: 'audio' });
  const other = item('mp3b', 'Episode two', 2000, { kind: 'direct', mediaType: 'audio' });
  assert.deepEqual(flags([mp3, other]), {}, 'a page of sound files: nothing odd about them');
});

test('a page with a single video is never flagged; subtitle files and playlists are not counted', () => {
  assert.deepEqual(flags([item('t', 'Trailer', 10)]), {});
  assert.deepEqual(flags([]), {});
  assert.deepEqual(flags(null), {});
  const subs = item('s', 'English', 0, { kind: 'subtitle', mediaType: 'subtitle' });
  const list = item('p', 'All lectures', 0, { kind: 'embed', playlist: true });
  assert.deepEqual(flags([item('t', 'Trailer', 10), subs, list]), {}, 'still one video');
  assert.deepEqual(flags([item('a', 'Lecture', 600), item('t', 'Trailer', 10), subs, list]), { t: 'promo' });
});

test('one reason each, the most telling first: copy, preview, short clip, sound only, no name', () => {
  const lecture = item('l', 'Heart sounds', 1800);
  const more = [item('m1', 'Valve disease', 2000), item('m2', 'Murmurs', 2200)];
  // A brief, unnamed trailer file that is also a copy of another item.
  const twin = item('twin', '', 30, { url: 'https://cdn.example.com/trailer.mp4' });
  const orig = item('orig', 'Trailer', 30, { url: 'https://cdn.example.com/a.mp4' });
  assert.deepEqual(flags([lecture, ...more, orig, twin]), { orig: 'promo', twin: 'copy' });
  assert.deepEqual(flags([lecture, ...more, item('x', 'Trailer', 20)]), { x: 'promo' }, 'a short trailer is a preview first');
  assert.deepEqual(flags([lecture, ...more, item('x', '', 20)]), { x: 'short' }, 'short before no name');
  assert.deepEqual(flags([lecture, ...more, item('x', '', 20, { kind: 'direct', mediaType: 'audio' })]), { x: 'short' });
  assert.deepEqual(flags([lecture, ...more, item('x', '', 1900, { kind: 'direct', mediaType: 'audio' })]), { x: 'audio' }, 'sound only before no name');
});

// ------------------------------------------------------------------ order

test('courseOrder: by lecture number, then the unnumbered ones in page order', () => {
  const ids = (items) => courseOrder(items).map((x) => x.id);
  const list = [
    item('c', '010: Late lecture'), item('intro', 'Introduction'), item('a', '002 - Second'), item('b', 'Lecture 3: Third'),
    item('z', 'Appendix'), item('first', '1. First'),
  ];
  assert.deepEqual(ids(list), ['first', 'a', 'b', 'c', 'intro', 'z']);
  // Numbers compare as numbers ("2" before "010"), and equal numbers keep their page order.
  const ties = [item('x', '5 - Part two', 0, { order: 7 }), item('y', '005 - Part one', 0, { order: 3 }), item('w', '2 Before')];
  assert.deepEqual(ids(ties), ['w', 'y', 'x']);
  // No numbers at all: the order on the page, whatever order the list came in.
  const plain = [item('p3', 'Gamma', 0, { order: 30 }), item('p1', 'Alpha', 0, { order: 10 }), item('p2', 'Beta', 0, { order: 20 })];
  assert.deepEqual(ids(plain), ['p1', 'p2', 'p3']);
  // A date or a time at the start is not a lecture number.
  assert.deepEqual(ids([item('d', '2026-11-02 Session', 0, { order: 1 }), item('n', '4: Four', 0, { order: 2 })]), ['n', 'd']);
  assert.deepEqual(ids([]), []);
  assert.deepEqual(ids(null), []);
});

// ------------------------------------------------------------------ groups

test('reviewGroups: ready, check (with reasons), blocked (with the sentence to show), and what is skipped', () => {
  const page = [
    item('l2', '002: Atrial fibrillation', 2400), item('l1', '001: Heart sounds', 1800), item('l3', '003: Valve disease', 2100),
    item('clip', 'Welcome back', 10), item('x', 'Cardio course', 1500, { borrowed: true }),
    item('dup', '002: Atrial fibrillation', 2400.5, { height: 360 }),
    item('drm', '004: Murmurs', 2000, { protected: true }), item('live', 'Live Q&A', 0, { live: true }),
    item('pl', 'All sessions', 0, { kind: 'embed', playlist: true }),
    item('done', '000: Welcome', 1700, { status: 'done' }), item('busy', '005: ECG', 1900, { status: 'active' }), item('q', '006: Echo', 1900.0, { status: 'queued', name: '006: Echo' }),
    item('sub', 'English', 0, { kind: 'subtitle', mediaType: 'subtitle' }),
  ];
  const g = reviewGroups(page);
  assert.deepEqual(g.ready, [{ id: 'l1' }, { id: 'l2' }, { id: 'l3' }]);
  assert.deepEqual(g.check, [{ id: 'dup', reason: 'copy' }, { id: 'clip', reason: 'short' }, { id: 'x', reason: 'noname' }]);
  assert.deepEqual(g.blocked, [
    { id: 'drm', why: 'protected', reason: BLOCKED.protected },
    { id: 'live', why: 'live', reason: BLOCKED.live },
    { id: 'pl', why: 'playlist', reason: BLOCKED.playlist },
  ]);
  assert.equal(g.have, 1);
  assert.equal(g.busy, 2);
  assert.match(BLOCKED.live, /record it from its own card/i);
  // (Plain words since the ease-of-use round: "Protected by the site", not "DRM".)
  assert.match(BLOCKED.protected, /^Protected by the site, so it can.t be saved.$/);
  assert.doesNotMatch(BLOCKED.protected, /DRM/);
});

test('reviewGroups: what the worker could not read moves to "can\'t be downloaded", in plain words', () => {
  const page = LECTURES();
  const plans = new Map([
    ['l1', { id: 'l1', ok: true, filename: '001 Heart sounds - 720p.mp4' }],
    ['l2', { id: 'l2', ok: false, why: 'unreadable', reason: 'HTTP 404 fetching https://cdn.example.com/v/l2/master.m3u8' }],
    ['l3', { id: 'l3', ok: false, why: 'other', reason: 'yt-dlp was not found. Install it, then try again.' }],
  ]);
  const g = reviewGroups(page, { plans });
  assert.deepEqual(g.ready, [{ id: 'l1' }]);
  assert.deepEqual(g.blocked, [
    { id: 'l2', why: 'unreadable', reason: 'The link may have expired. Reload the page and press play.' },
    { id: 'l3', why: 'other', reason: 'yt-dlp was not found. Install it, then try again.' },
  ]);
  // A kind the worker has no sentence for, and one it gave no reason for.
  const odd = reviewGroups(page, { plans: new Map([['l1', { ok: false, why: 'mystery', reason: 'Odd.' }], ['l2', { ok: false }], ['l3', { ok: false, why: 'slow', reason: 'x' }]]) });
  assert.deepEqual(odd.blocked.map((b) => [b.why, b.reason]), [['other', 'Odd.'], ['other', BLOCKED.other], ['slow', BLOCKED.slow]]);
  assert.deepEqual(odd.ready, []);
});

test('reviewGroups: videos that turn up while the sheet is open go last under "check" as "Just appeared"', () => {
  const page = [...LECTURES(), item('clip', 'Welcome back', 10)];
  const known = new Set(page.map((x) => x.id));
  const frozen = flagItems(page);
  const later = [item('n2', '000: Came later', 1800), ...page, item('n1', 'Bonus', 5)];
  const g = reviewGroups(later, { flags: frozen, known });
  assert.deepEqual(g.ready, [{ id: 'l1' }, { id: 'l2' }, { id: 'l3' }], 'a newcomer never lands in "ready", whatever its number');
  assert.deepEqual(g.check, [{ id: 'clip', reason: 'short' }, { id: 'n2', reason: 'appeared' }, { id: 'n1', reason: 'appeared' }]);
  // A newcomer that can't be downloaded is blocked like any other.
  const blocked = reviewGroups([...page, item('n3', 'New and protected', 100, { protected: true })], { flags: frozen, known });
  assert.deepEqual(blocked.blocked.map((b) => b.id), ['n3']);
  // One that vanished is simply not there any more.
  assert.deepEqual(reviewGroups(page.slice(1), { flags: frozen, known }).ready, [{ id: 'l2' }, { id: 'l3' }]);
});

test('reviewGroups: nothing listed, and nothing left to download', () => {
  assert.deepEqual(reviewGroups([]), { ready: [], check: [], blocked: [], have: 0, busy: 0 });
  assert.deepEqual(reviewGroups(null), { ready: [], check: [], blocked: [], have: 0, busy: 0 });
  const all = LECTURES().map((x) => ({ ...x, status: 'done' }));
  assert.deepEqual(reviewGroups(all), { ready: [], check: [], blocked: [], have: 3, busy: 0 });
  // A failed or missing one is offered again.
  const again = reviewGroups([{ ...all[0], status: 'failed' }, { ...all[1], status: 'missing' }, all[2]]);
  assert.deepEqual(again.ready, [{ id: 'l1' }, { id: 'l2' }]);
  assert.equal(again.have, 1);
});

// ------------------------------------------------------------------ numbering

test('numberNames: offered from three selected videos without a lecture number', () => {
  const two = numberNames([{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }]);
  assert.equal(two.eligible, false);
  assert.equal(two.names.size, 0);
  const three = numberNames([{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }, { id: 'c', name: 'Gamma' }]);
  assert.equal(three.eligible, true);
  assert.deepEqual([...three.names], [['a', '01 - Alpha'], ['b', '02 - Beta'], ['c', '03 - Gamma']]);
  // Videos that already have a number keep their name and are not counted.
  const mixed = numberNames([{ id: 'n1', name: '001: Heart sounds' }, { id: 'a', name: 'Alpha' }, { id: 'n2', name: 'Lecture 2 - Valves' }, { id: 'b', name: 'Beta' }]);
  assert.equal(mixed.eligible, false, 'only two without a number');
  const mixed3 = numberNames([{ id: 'n1', name: '001: Heart sounds' }, { id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }, { id: 'c', name: 'Gamma' }]);
  assert.deepEqual([...mixed3.names], [['a', '01 - Alpha'], ['b', '02 - Beta'], ['c', '03 - Gamma']]);
  // Nothing selected.
  assert.deepEqual(numberNames([]), { eligible: false, names: new Map() });
  assert.deepEqual(numberNames(null), { eligible: false, names: new Map() });
  // A hundred or more: three digits, so the files still sort.
  const many = numberNames(Array.from({ length: 120 }, (_, i) => ({ id: `v${i}`, name: `Clip ${String.fromCharCode(65 + (i % 26))}` })));
  assert.equal(many.names.get('v0'), '001 - Clip A');
  assert.equal(many.names.get('v119'), '120 - Clip P');
});

// ------------------------------------------------------------------ small helpers

test('sameFileNames: the later rows that would get an earlier row\'s file name in the same folder', () => {
  const rows = [
    { id: 'a', folder: 'StreamSnag', filename: 'Cardio course - 720p.mp4' },
    { id: 'b', folder: 'StreamSnag', filename: 'cardio course - 720p.MP4' },
    { id: 'c', folder: 'StreamSnag/other', filename: 'Cardio course - 720p.mp4' },
    { id: 'd', folder: 'StreamSnag', filename: 'Cardio course - 360p.mp4' },
    { id: 'e', folder: 'StreamSnag', filename: 'Cardio course - 720p.mp4' },
    { id: 'f', folder: 'StreamSnag', filename: '' },
    { id: 'g', folder: 'StreamSnag', filename: '' },
  ];
  assert.deepEqual([...sameFileNames(rows)], ['b', 'e']);
  assert.deepEqual([...sameFileNames([])], []);
  assert.deepEqual([...sameFileNames(null)], []);
});

test('splitName: a long file name is cut so its end (quality and type) stays whole', () => {
  assert.deepEqual(splitName('009 - Atrial fibrillation - 720p.mp4'), ['009 - Atrial fibrillation', ' - 720p.mp4']);
  assert.deepEqual(splitName('Gallery clip two.mp4'), ['Gallery clip two.mp4', ''], 'short names are left whole');
  assert.deepEqual(splitName(''), ['', '']);
  assert.deepEqual(splitName(null), ['', '']);
  // No file type: the last few characters still stay.
  const [head, tail] = splitName('A long name that has no type at the end of it');
  assert.equal(head + tail, 'A long name that has no type at the end of it');
  assert.equal(tail.length, 7);
  // Never cut through a character made of two code units.
  const [h2, t2] = splitName('Émissions spéciales de la semaine 😀😀😀😀😀😀😀😀.mp4');
  assert.equal(h2 + t2, 'Émissions spéciales de la semaine 😀😀😀😀😀😀😀😀.mp4');
  assert.equal([...t2].length, 11);
  assert.ok(!/[\ud800-\udbff]$/.test(h2), 'no half character at the cut');
});

test('folderTrail, reviewSummary and docKinds: the words on the sheet', () => {
  assert.deepEqual(folderTrail('Videos', 'StreamSnag/learn.example.com'), ['Videos', 'StreamSnag', 'learn.example.com']);
  assert.deepEqual(folderTrail('Downloads', ''), ['Downloads']);
  assert.deepEqual(folderTrail('', 'a//b'), ['Downloads', 'a', 'b']);
  assert.equal(reviewSummary({ selected: 12, check: 3, blocked: 1 }), '12 videos selected · 3 need a look · 1 can\'t be downloaded');
  assert.equal(reviewSummary({ selected: 1, check: 1 }), '1 video selected · 1 needs a look');
  assert.equal(reviewSummary({ selected: 4, files: 2 }), '4 videos and 2 files selected');
  assert.equal(reviewSummary({ selected: 0, files: 1, blocked: 2 }), '1 file selected · 2 can\'t be downloaded');
  assert.equal(reviewSummary({ selected: 0, check: 4 }), 'Nothing selected · 4 need a look');
  assert.equal(reviewSummary(), 'Nothing selected');
  // E8: a video and its two smaller copies is not "2 need a look".
  assert.equal(reviewSummary({ selected: 1, check: 2, copies: 2 }), '1 video selected · 2 are copies');
  assert.equal(reviewSummary({ selected: 1, check: 1, copies: 1 }), '1 video selected · 1 is a copy');
  assert.equal(reviewSummary({ selected: 4, check: 3, copies: 1, blocked: 2 }), '4 videos selected · 2 need a look · 1 is a copy · 2 can\'t be downloaded');
  assert.equal(reviewSummary({ selected: 2, check: 1, copies: 5 }), '2 videos selected · 1 is a copy', 'never more copies than there are rows to check');
  // C6: a page of sound files is not "videos"; a sheet about the page's files alone counts no videos at all.
  assert.equal(reviewSummary({ selected: 3, noun: 'audio file' }), '3 audio files selected');
  assert.equal(reviewSummary({ selected: 1, files: 2, noun: 'recording' }), '1 recording and 2 files selected');
  assert.equal(reviewSummary({ files: 5, only: 'files' }), '5 files selected');
  assert.equal(reviewSummary({ files: 0, only: 'files' }), 'Nothing selected');
  assert.equal(docKinds([{ ext: 'pdf' }, { ext: 'pptx' }, { ext: 'PDF' }, { ext: 'ppt' }]), 'PDFs, slides');
  assert.equal(docKinds([{ ext: 'docx' }, { ext: 'xlsx' }, { ext: 'zip' }, { ext: 'epub' }]), 'documents, spreadsheets, zip files', 'at most three kinds');
  assert.equal(docKinds([{ ext: 'exe' }, {}]), '');
  assert.equal(docKinds(null), '');
});

// ---------------------------------------------------------------- folded away in the list (batch 9)

test('copies, sound-only copies, previews and short clips fold into one line; never the big card, never all of them, never with "Show"', () => {
  assert.deepEqual([...FOLDED], ['copy', 'sound', 'promo', 'short']);
  const flags = new Map([['b', 'copy'], ['c', 'promo'], ['d', 'noname'], ['e', 'audio'], ['f', 'samename']]);
  const items = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, kind: 'hls' }));
  const out = foldedIds(items, flags, { hero: 'a' });
  assert.deepEqual([...out].sort(), ['b', 'c'], 'only copies, sound-only copies, previews and short clips fold: no name, sound only and the same name stay');
  assert.equal(foldLine(out, flags), '2 more hidden: a copy and a preview');
  assert.deepEqual([...foldedIds(items, flags, { hero: 'b' })], ['c'], 'the big card item is never folded');
  assert.equal(foldedIds(items, flags, { hero: 'a', showAll: true }).size, 0, '"Show" on this page, or "Always show everything"');
  const onlyFlagged = new Map([['x', 'copy'], ['y', 'short']]);
  assert.equal(foldedIds([{ id: 'x' }, { id: 'y' }], onlyFlagged, { hero: 'x' }).size, 0, 'when the page has nothing else, nothing is folded');
  assert.equal(foldedIds([{ id: 'a' }, { id: 's', kind: 'subtitle' }], new Map([['s', 'copy']])).size, 0, 'caption files are not part of it');
});

test('the folded line is one plain sentence built from the flags', () => {
  const flags = new Map([['1', 'copy'], ['2', 'copy'], ['3', 'sound'], ['4', 'promo'], ['5', 'short'], ['6', 'short'], ['7', 'short']]);
  assert.equal(foldLine(new Set(['1']), flags), '1 more hidden: a copy');
  assert.equal(foldLine(new Set(['3']), flags), '1 more hidden: a sound-only copy');
  assert.equal(foldLine(new Set(['5', '6']), flags), '2 more hidden: 2 short clips');
  assert.equal(foldLine(new Set(['1', '2', '3', '4', '5', '6', '7']), flags), '7 more hidden: 2 copies, a sound-only copy, a preview and 3 short clips');
  assert.equal(foldLine(new Set(), flags), '');
});

test('the popup folds with them, keeps them for "Download all" and the review sheet, and the toolbar count leaves them out', async () => {
  const fs = await import('node:fs');
  const popup = fs.readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8');
  assert.match(popup, /const rest = arrange\(shown\.filter\(\(m\) => m !== hero && !foldOut\.has\(m\.id\)\)\)/);
  assert.match(popup, /offered = shown\.map\(/, '"Download all" and the review sheet still offer every listed video');
  const bg = fs.readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  assert.match(bg, /shown\.length - foldedOn\(t, shown, showEverything\)\.size/);
  const opts = fs.readFileSync(new URL('../extension/options.html', import.meta.url), 'utf8');
  assert.match(opts, /id="showEverything"> Always show everything/);
});
