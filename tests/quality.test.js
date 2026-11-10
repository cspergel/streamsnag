import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickPreferred, qualityChips, canBulkDownload, bulkSummary, QUALITY_PREFS } from '../extension/lib/quality.js';
import { rankVideoOptions } from '../extension/lib/util.js';
import { DEFAULT_SETTINGS } from '../extension/lib/settings.js';

// As `inspect` lists a stream: qualities in the stream's own order, then audio-only and subtitle choices.
const LADDER = [
  { id: 'v0', label: '360p · 800 kbps', height: 360, bandwidth: 800e3 },
  { id: 'v1', label: '1080p · 5.0 Mbps', height: 1080, bandwidth: 5e6 },
  { id: 'v2', label: '720p · 2.5 Mbps', height: 720, bandwidth: 2.5e6 },
  { id: 'v3', label: '2160p · 16.0 Mbps', height: 2160, bandwidth: 16e6 },
  { id: 'v4', label: '480p · 1.2 Mbps', height: 480, bandwidth: 1.2e6 },
  { id: 'a0', label: 'Audio only · English', audio: true },
  { id: 's0', label: 'Subtitles · English', subtitle: true },
];
const pick = (options, pref) => pickPreferred(options, pref)?.id ?? null;

test('the setting defaults to "best", and every choice is a known one', () => {
  assert.equal(DEFAULT_SETTINGS.preferredQuality, 'best');
  assert.deepEqual(QUALITY_PREFS, ['best', '1080', '720', '480', 'smallest']);
});

test('pickPreferred: "best" is the tallest picture and "smallest" the shortest, whatever the listed order', () => {
  assert.equal(pick(LADDER, 'best'), 'v3');
  assert.equal(pick(LADDER, 'smallest'), 'v0');
  assert.equal(pick(LADDER), 'v3', 'no setting means best');
});

test('pickPreferred: a cap picks the best quality that is not above it', () => {
  assert.equal(pick(LADDER, '1080'), 'v1');
  assert.equal(pick(LADDER, '720'), 'v2');
  assert.equal(pick(LADDER, '480'), 'v4');
  // No quality sits exactly on the cap: the next one down, never the next one up.
  const gaps = LADDER.filter((o) => o.id !== 'v2');
  assert.equal(pick(gaps, '720'), 'v4', '480p, not 1080p');
  // Two qualities of the capped height: the higher bitrate.
  assert.equal(pick([{ id: 'lo', height: 720, bandwidth: 1e6 }, { id: 'hi', height: 720, bandwidth: 3e6 }, { id: 'top', height: 1080, bandwidth: 5e6 }], '720'), 'hi');
});

test('pickPreferred: when every quality is above the cap, the lowest there is', () => {
  const high = [
    { id: 'v0', label: '2160p', height: 2160 }, { id: 'v1', label: '1080p', height: 1080 }, { id: 'v2', label: '1440p', height: 1440 },
    { id: 'a0', label: 'Audio only', audio: true },
  ];
  assert.equal(pick(high, '720'), 'v1');
  assert.equal(pick(high, '480'), 'v1');
  assert.equal(pick(high, '1080'), 'v1');
  assert.equal(pick([{ id: 'only', height: 2160 }], '480'), 'only', 'a single quality is always the answer');
});

test('pickPreferred: a height a few lines over the cap (1088 stored for 1080p) still counts as that quality', () => {
  const odd = [{ id: 'uhd', height: 2160 }, { id: 'fhd', height: 1088 }, { id: 'hd', height: 736 }, { id: 'sd', height: 360 }];
  assert.equal(pick(odd, '1080'), 'fhd');
  assert.equal(pick(odd, '720'), 'hd');
  assert.equal(pick([{ id: 'a', height: 1200 }, { id: 'b', height: 360 }], '1080'), 'b', '1200 lines is above 1080p');
});

test('pickPreferred: reads the height from the label when the number is missing', () => {
  const labelled = [{ id: 'a', label: '480p · 1.2 Mbps' }, { id: 'b', label: '1080p · 5.0 Mbps' }, { id: 'c', label: '720p · 2.5 Mbps' }];
  assert.equal(pick(labelled, '720'), 'c');
  assert.equal(pick(labelled, 'best'), 'b');
  assert.equal(pick(labelled, 'smallest'), 'a');
});

test('pickPreferred: without heights the bitrate decides, and without that the listed order', () => {
  const rates = [{ id: 'low', label: '900 kbps', bandwidth: 900e3 }, { id: 'top', label: '7.0 Mbps', bandwidth: 7e6 }, { id: 'mid', label: '3.0 Mbps', bandwidth: 3e6 }];
  assert.equal(pick(rates, 'best'), 'top');
  assert.equal(pick(rates, 'smallest'), 'low');
  assert.equal(pick(rates, '1080'), 'top', '7 Mbps is within what 1080p needs');
  assert.equal(pick(rates, '720'), 'mid', '7 Mbps is more than 720p needs, 3 Mbps is not');
  assert.equal(pick(rates, '480'), 'low');
  assert.equal(pick([{ id: 'x', bandwidth: 9e6 }, { id: 'y', bandwidth: 6e6 }], '480'), 'y', 'all above: the lowest');
  // Nothing to measure at all (a plain playlist): the first one listed, for every setting but "smallest".
  const bare = [{ id: 'media', label: 'Download · 12:30' }, { id: 'other', label: 'Download' }];
  for (const pref of ['best', '1080', '720', '480']) assert.equal(pick(bare, pref), 'media', pref);
  assert.equal(pick(bare, 'smallest'), 'other');
  // One option knows its height, one only its bitrate: each is judged by what it says.
  assert.equal(pick([{ id: 'h', height: 1080, bandwidth: 5e6 }, { id: 'r', bandwidth: 2e6 }], '720'), 'r');
});

test('pickPreferred: audio-only and subtitle options are never chosen, whatever the setting', () => {
  const noVideo = [{ id: 'a0', label: 'Audio only · English', audio: true, bandwidth: 128e3 }, { id: 's0', label: 'Subtitles · English', subtitle: true }];
  for (const pref of QUALITY_PREFS) {
    assert.equal(pickPreferred(noVideo, pref), null, pref);
    const got = pickPreferred(LADDER, pref);
    assert.ok(got && !got.audio && !got.subtitle, pref);
  }
  // An audio track with the lowest bitrate of all must not win "smallest" or a low cap.
  const mixed = [{ id: 'a0', label: 'Audio only', audio: true, bandwidth: 64e3, height: 0 }, { id: 'v0', label: '1080p', height: 1080 }, { id: 's0', label: '240p subtitles', subtitle: true, height: 240 }];
  assert.equal(pick(mixed, 'smallest'), 'v0');
  assert.equal(pick(mixed, '480'), 'v0');
});

test('pickPreferred: an empty or missing list gives null, an unknown setting means best, and the input is left alone', () => {
  for (const pref of [...QUALITY_PREFS, undefined, null, 'nonsense']) {
    assert.equal(pickPreferred([], pref), null);
    assert.equal(pickPreferred(undefined, pref), null);
    assert.equal(pickPreferred(null, pref), null);
  }
  for (const pref of ['nonsense', '', null, undefined, '4320', 720.5, {}, '-720', 'Infinity']) assert.equal(pick(LADDER, pref), 'v3', String(pref));
  assert.equal(pick(LADDER, 720), 'v2', 'the number 720 is the same as "720"');
  const before = JSON.stringify(LADDER);
  QUALITY_PREFS.forEach((p) => pickPreferred(LADDER, p));
  assert.equal(JSON.stringify(LADDER), before);
  // It returns the very option object from the list (the caller uses its id).
  assert.equal(pickPreferred(LADDER, '720'), LADDER[2]);
});

test('qualityChips: the best few, and always the chosen one', () => {
  const ranked = rankVideoOptions([...LADDER, { id: 'v5', label: '1440p', height: 1440 }, { id: 'v6', label: '240p', height: 240 }]);
  const ids = (chosen, max) => qualityChips(ranked, chosen, max).map((o) => o.id);
  assert.deepEqual(ranked.map((o) => o.id), ['v3', 'v5', 'v1', 'v2', 'v4', 'v0', 'v6']);
  assert.deepEqual(ids(ranked[0]), ['v3', 'v5', 'v1', 'v2'], 'the chosen one is already among the top four');
  assert.deepEqual(ids(pickPreferred(ranked, '720')), ['v3', 'v5', 'v1', 'v2']);
  assert.deepEqual(ids(pickPreferred(ranked, '480')), ['v3', 'v5', 'v1', 'v4'], '480p takes the last place, still best-first');
  assert.deepEqual(ids(pickPreferred(ranked, 'smallest')), ['v3', 'v5', 'v1', 'v6']);
  assert.deepEqual(ids(null), ['v3', 'v5', 'v1', 'v2']);
  assert.deepEqual(ids({ id: 'a0', audio: true }), ['v3', 'v5', 'v1', 'v2'], 'something that is not one of the qualities is never shown');
  assert.deepEqual(ids(ranked[6], 2), ['v3', 'v6']);
  assert.deepEqual(qualityChips(ranked.slice(0, 2), ranked[1]).map((o) => o.id), ['v3', 'v5'], 'fewer than four: all of them');
  assert.deepEqual(qualityChips([], ranked[0]), []);
  assert.deepEqual(qualityChips(undefined, undefined), []);
  assert.equal(ranked.length, 7, 'the list given is not changed');
});

test('canBulkDownload: single videos and audio files only', () => {
  assert.equal(canBulkDownload({ kind: 'direct', mediaType: 'video' }), true);
  assert.equal(canBulkDownload({ kind: 'direct', mediaType: 'audio' }), true);
  assert.equal(canBulkDownload({ kind: 'hls', mediaType: 'stream', info: { master: true } }), true);
  assert.equal(canBulkDownload({ kind: 'dash', info: { live: false } }), true);
  assert.equal(canBulkDownload({ kind: 'embed', parentId: 'p1' }), true, 'a video listed from a playlist');
  assert.equal(canBulkDownload({ kind: 'embed', playlist: true }), false, 'a playlist');
  assert.equal(canBulkDownload({ kind: 'hls', protected: true }), false, 'DRM');
  assert.equal(canBulkDownload({ kind: 'subtitle', mediaType: 'subtitle' }), false);
  assert.equal(canBulkDownload({ kind: 'hls', mediaType: 'subtitle' }), false, 'a subtitle playlist');
  assert.equal(canBulkDownload({ kind: 'hls', info: { live: true } }), false, 'a live stream would record for ever');
  assert.equal(canBulkDownload({ kind: 'page' }), false, 'not a media item');
  assert.equal(canBulkDownload({}), false);
  assert.equal(canBulkDownload(null), false);
});

test('bulkSummary: one line, however many failed', () => {
  assert.equal(bulkSummary({ started: 6, failed: [] }), 'Started 6 downloads.');
  assert.equal(bulkSummary({ started: 1, failed: [] }), 'Started 1 download.');
  assert.equal(bulkSummary({ started: 6, failed: [{ error: 'HTTP 404 fetching x' }] }), "Started 6, 1 couldn't start: HTTP 404 fetching x");
  assert.equal(bulkSummary({ started: 2, failed: [{ error: 'gone' }, { error: 'gone' }] }), "Started 2, 2 couldn't start: gone");
  assert.equal(bulkSummary({ started: 2, failed: [{ error: 'gone' }, { error: 'DRM' }] }), "Started 2, 2 couldn't start: gone (and other reasons)");
  assert.equal(bulkSummary({ started: 0, failed: [{ error: 'no helper' }, { error: 'no helper' }] }), 'None could start: no helper');
  assert.equal(bulkSummary({ started: 0, failed: [] }), 'Nothing to download.');
  assert.equal(bulkSummary(), 'Nothing to download.');
  assert.equal(bulkSummary({ started: 1, failed: [{}] }), "Started 1, 1 couldn't start: unknown reason");
});
