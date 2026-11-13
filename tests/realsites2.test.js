// What the second round of testing on real public websites found (C1 to C5, and what was left over from
// the first round): each case below is the page it was found on, reduced to what the logic sees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manifestKind, streamInData, isImageTrack, classifyUrl, dedupeKey, sameMedia } from '../extension/lib/detect.js';
import { plainError, NOT_A_STREAM } from '../extension/lib/jobs.js';
import { GRACE_MS, graceStart, splitAtChange, comeBack, leftBehind } from '../extension/lib/pagechange.js';
import { imageRef, imageCues, hasWords, buildTranscript, parseCues, cleanCues } from '../extension/lib/transcript.js';
import { chooseName, linkTitle } from '../extension/lib/naming.js';
import { noteLinks, linksWaiting, linkName, listSort, sameLecture } from '../extension/lib/linked.js';
import { hlsParts, addParts, emptyParts, ownCaption } from '../extension/lib/parts.js';
import { parseM3U8 } from '../extension/lib/hls.js';
import { orderSubtitles, captionFiles } from '../extension/lib/captions.js';

// ---------------------------------------------------------------- C1: an address that looks like a stream, a body that is not one
const FLAVOR = (id, h) => `https://cfvod.kaltura.com/scf/hls/p/243342/sp/24334200/serveFlavor/entryId/1_sf5ovm7u/v/31/pv/2/ev/6/flavorId/${id}/name/a.mp4/index.m3u8?Policy=eyJTdGF0&Signature=fOsJ~${h}&Key-Pair-Id=APKAJT6Q`;
const KALTURA = { entryId: '1_sf5ovm7u', duration: 114, baseUrl: '', flavors: [
  { url: FLAVOR('1_d2uwy7vv', 360), ext: 'mp4', bitrate: 1044, width: 640, height: 360, audioLanguage: null, frameRate: 23.976, codecs: '' },
  { url: FLAVOR('1_jl7y56al', 720), ext: 'mp4', bitrate: 1206, width: 1280, height: 720, audioLanguage: null, frameRate: 23.976, codecs: '' },
] };
// As the server writes it: wrapped in the callback's name, every "/" escaped.
const KALTURA_BODY = `cb(${JSON.stringify(KALTURA).replace(/\//g, '\\/')})`;

test('C1 (Kaltura): a body is a playlist or a manifest by what it starts with, not by the address it came from', () => {
  assert.equal(manifestKind('#EXTM3U\n#EXT-X-VERSION:3\n'), 'hls');
  assert.equal(manifestKind('﻿  #EXTM3U\n'), 'hls');
  assert.equal(manifestKind('<?xml version="1.0"?>\n<!-- made by a packager -->\n<MPD type="static">'), 'dash');
  assert.equal(manifestKind('<MPD\n xmlns="urn:mpeg:dash:schema:mpd:2011">'), 'dash');
  for (const not of [KALTURA_BODY, JSON.stringify(KALTURA), '', '<!doctype html><html><body>Sign in</body></html>', '{"error":"expired"}', 'WEBVTT\n\n00:01.000 --> 00:02.000\nHello', 'see master.m3u8 or the <MPD> docs']) {
    assert.equal(manifestKind(not), '', not.slice(0, 30));
  }
});

test('C1 (Kaltura): the stream address a JSON answer plainly holds is found (the tallest picture of several), and nothing is made up', () => {
  assert.equal(streamInData(KALTURA_BODY, 'https://cdnapisec.kaltura.com/p/243342/playManifest/a.m3u8'), FLAVOR('1_jl7y56al', 720));
  assert.equal(streamInData(JSON.stringify(KALTURA), 'https://cdnapisec.kaltura.com/x'), FLAVOR('1_jl7y56al', 720));
  // One address, however deep; a relative one is read against the answer's own address; a manifest of the other kind counts too.
  assert.equal(streamInData('{"data":{"playback":{"hls":"/v/77/master.m3u8?sig=abc"}}}', 'https://api.example.com/play/77'), 'https://api.example.com/v/77/master.m3u8?sig=abc');
  assert.equal(streamInData('{"sources":[{"src":"https://cdn.example.com/a/manifest.mpd","type":"application/dash+xml"}]}', 'https://x.example/'), 'https://cdn.example.com/a/manifest.mpd');
  // Several with nothing to choose by: the first. A height or a bitrate chooses.
  assert.equal(streamInData('[{"file":"https://c.example/low.m3u8"},{"file":"https://c.example/high.m3u8"}]', 'https://x.example/'), 'https://c.example/low.m3u8');
  assert.equal(streamInData('[{"file":"https://c.example/low.m3u8","bitrate":300},{"file":"https://c.example/high.m3u8","bitrate":900}]', 'https://x.example/'), 'https://c.example/high.m3u8');
  // Not there: an error, a file that is no stream, text that is not data, an address that is not the web's.
  for (const not of ['{"error":"expired"}', '{"url":"https://c.example/video.mp4"}', '<html>master.m3u8</html>', 'cb(', '', '{"url":"javascript:alert(1)//a.m3u8"}', '{"note":"ask for master.m3u8"}']) {
    assert.equal(streamInData(not, 'https://x.example/'), '', not);
  }
  assert.equal(streamInData(`{"a":${'['.repeat(5000)}`, 'https://x.example/'), '', 'data that cannot be read is not searched');
});

test('C1: a manifest that cannot be read is reported in plain words, with what the reader said kept for bug reports', () => {
  for (const raw of ['Not an HLS playlist (missing #EXTM3U)', 'Not a DASH manifest (root is not <MPD>)']) {
    const said = plainError(raw);
    assert.equal(said.text, NOT_A_STREAM);
    assert.equal(said.code, 'not-a-stream');
    assert.equal(said.detail, raw);
    assert.ok(!/EXTM3U|MPD|HLS|DASH|manifest|playlist/i.test(said.text), said.text);
  }
  // Other failures are worded as before.
  assert.equal(plainError('HTTP 403 fetching https://x.example/a.m3u8').code, undefined);
  assert.deepEqual(plainError('Disk full'), { text: 'Disk full', detail: '' });
});

// ---------------------------------------------------------------- C2: the page's address changes without a load
test('C2 (PeerTube): what stays when the address changes: what was found since the click that changed it, or in the last four seconds without one', () => {
  const now = 100000;
  assert.equal(GRACE_MS, 4000);
  assert.equal(graceStart(now), now - 4000);
  assert.equal(graceStart(now, now - 900), now - 900, 'a click 0.9 s ago led here: only what came after it is the new page\'s');
  assert.equal(graceStart(now, now - 9000), now - 4000, 'an old click says nothing');
  assert.equal(graceStart(now, now + 500), now - 4000, 'nor does a clock that disagrees');
  const first = { id: 'a', key: 'https://v.example/first.mp4', title: 'First video', detectedAt: now - 60000 };
  const quick = { id: 'b', key: 'https://v.example/second.mp4', title: 'Second video', detectedAt: now - 2500 }; // played 2.5 s before the next click
  const next = { id: 'c', key: 'https://v.example/third.mp4', title: '', detectedAt: now - 300 }; // the next page's video, loading already
  let cut = splitAtChange([first, quick, next], graceStart(now));
  assert.deepEqual([cut.stay.map((m) => m.id), cut.left.map((m) => m.id)], [['b', 'c'], ['a']]);
  cut = splitAtChange([first, quick, next], graceStart(now, now - 900));
  assert.deepEqual([cut.stay.map((m) => m.id), cut.left.map((m) => m.id)], [['c'], ['a', 'b']], 'the video played before the click leaves, however recently it was found');
});

test('C2: a video of the previous page that is still there comes back as itself (its own name), and goes when its frame no longer has it', () => {
  const old = { id: 'a', key: 'https://v.example/first.mp4', aliases: ['https://v.example/first.mp4?x=1'], kind: 'direct', title: 'First video', course: 'Channel', nameSource: 'heading', detectedAt: 5 };
  const sub = { id: 's', key: 'https://v.example/first.en.vtt', kind: 'subtitle', detectedAt: 6 };
  const stream = { id: 'h', key: 'https://v.example/live.m3u8', kind: 'hls', title: 'The channel', detectedAt: 7 };
  const left = [old, sub, stream];
  assert.equal(comeBack(left, 'https://v.example/other.mp4', { frameId: 0 }), null);
  assert.deepEqual(left.map((m) => m.id), ['a', 's', 'h'], 'nothing is taken for an address that was not there');
  const back = comeBack(left, 'https://v.example/first.mp4?x=1', { frameId: 3, pageTitle: 'Second video - Site' });
  assert.equal(back, old, 'the very item: its id, its name, what was made from it');
  assert.deepEqual([back.title, back.course, back.nameSource, back.carried, back.carriedBy], ['First video', 'Channel', 'heading', true, 3]);
  assert.deepEqual(left.map((m) => m.id), ['s', 'h']);
  // One that had no name yet is called what its own page was called, never what the new page is.
  const bare = { id: 'n', key: 'https://v.example/n.mp4', kind: 'direct', title: '', pageTitle: 'First page - Site', detectedAt: 8 };
  assert.equal(comeBack([bare], bare.key, { frameId: 0 }).title, 'First page - Site');

  // Gone from its frame: a file or caption file that frame's report no longer lists; a stream whose player has another source now.
  const media = [{ ...old }, { ...sub, carried: true, carriedBy: 3 }, { ...stream, carried: true, carriedBy: 0, carriedSrc: 'blob:https://v.example/1' }, { id: 'new', key: 'https://v.example/second.mp4', kind: 'direct' }];
  const ids = (list) => list.map((m) => m.id);
  assert.deepEqual(ids(leftBehind(media, 3, new Set(['https://v.example/first.mp4', 'https://v.example/first.en.vtt']), new Set())), []);
  assert.deepEqual(ids(leftBehind(media, 3, new Set(['https://v.example/second.mp4']), new Set())), ['a', 's']);
  assert.deepEqual(ids(leftBehind(media, 3, new Set(['https://v.example/first.mp4?x=1']), new Set())), ['s'], 'any of its addresses keeps it');
  assert.deepEqual(ids(leftBehind(media, 5, new Set(), new Set())), [], 'another frame\'s report says nothing about it');
  assert.deepEqual(ids(leftBehind(media, 0, new Set(), new Set(['blob:https://v.example/1']))), [], 'the player still has the same source');
  assert.deepEqual(ids(leftBehind(media, 0, new Set(), new Set(['blob:https://v.example/2']))), ['h']);
  // A stream that came back because it was asked for again (a live playlist) is not judged by the page's elements.
  assert.deepEqual(ids(leftBehind([{ ...stream, carried: true, carriedBy: 0 }], 0, new Set(), new Set())), []);
  // And what was never carried is never taken off this way.
  assert.deepEqual(ids(leftBehind([{ id: 'x', key: 'https://v.example/x.mp4', kind: 'direct' }], 0, new Set(), new Set())), []);
});

// ---------------------------------------------------------------- C3: a thumbnail index is not captions
const STORYBOARD = ['WEBVTT', '', '00:00:00.000 --> 00:00:02.000', 'https://image.mux.com/BV3YZtogl89mg9VcNBhhnHm02Y34zI1nlMuMQfAbl3dM/storyboard.jpg#xywh=0,0,256,144', '',
  '00:00:02.000 --> 00:00:04.000', 'https://image.mux.com/BV3YZtogl89mg9VcNBhhnHm02Y34zI1nlMuMQfAbl3dM/storyboard.jpg#xywh=256,0,256,144', ''].join('\n');
const STRIPS = ['WEBVTT', '', '1', '00:00.000 --> 00:05.000', 'bkaovAYt-120.jpg#xywh=0,0,120,67', '', '2', '00:05.000 --> 00:10.000', 'bkaovAYt-120.jpg#xywh=120,0,120,67', ''].join('\n');
const SPRITES = ['WEBVTT', '', '00:00:00.000 --> 00:00:10.000', '/media/congress/2023/12142-thumbnails-0.jpg', '', '00:00:10.000 --> 00:00:20.000', 'sprites/sheet_01.png?v=3', ''].join('\n');
const SPOKEN = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nWelcome to the lecture.\n\n00:00:03.500 --> 00:00:06.000\nToday: entropy.\n';

test('C3 (Mux storyboard, JW Player strips): cues that point at pictures are not captions', () => {
  for (const line of ['https://image.mux.com/x/storyboard.jpg#xywh=0,0,256,144', 'bkaovAYt-120.jpg#xywh=120,0,120,67', '/thumbs/0001.png', 'sprites/sheet_01.webp?v=3', 'https://c.example/t?frame=4#xywh=0,0,160,90']) {
    assert.ok(imageRef(line), line);
  }
  for (const line of ['Welcome to the lecture.', 'Open the file photo.jpg and look at it', 'See https://example.com/slides for more', 'xywh', '']) assert.ok(!imageRef(line), line);
  for (const vtt of [STORYBOARD, STRIPS, SPRITES]) {
    assert.equal(imageCues(vtt), true);
    assert.equal(hasWords(vtt), false);
    assert.equal(buildTranscript(vtt, { title: 'x', format: 'md' }).paragraphs, 0, 'a transcript of picture addresses is not saved');
    assert.deepEqual(cleanCues(parseCues(vtt)), []);
  }
  assert.equal(imageCues(SPOKEN), false);
  assert.equal(hasWords(SPOKEN), true);
  // Captions that mention a picture once are still captions; a file with no cues, or cues with no letters, has no words.
  const mixed = `${SPOKEN}\n00:00:07.000 --> 00:00:09.000\nslide-04.png\n`;
  assert.deepEqual([imageCues(mixed), hasWords(mixed)], [false, true]);
  assert.ok(!/slide-04/.test(buildTranscript(mixed, { title: 'x', format: 'md' }).text), 'the picture\'s address is not something that was said');
  for (const empty of ['', 'WEBVTT\n', 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n♪ ♪\n', '<html>Not found</html>']) assert.deepEqual([imageCues(empty), hasWords(empty)], [false, false], empty);
  assert.equal(hasWords('WEBVTT\n\n00:01.000 --> 00:02.000\nHi\n'), true, 'short captions are captions');
});

test('C3: a caption file\'s address that says it is a thumbnail index (before anything is read)', () => {
  for (const u of ['https://image.mux.com/BV3YZ/storyboard.vtt', 'https://assets-jpcust.jwpsrv.com/strips/bkaovAYt-120.vtt', 'https://static.media.ccc.de/media/congress/2023/12142-68160267.thumbnails.vtt',
    'https://cdn.example.com/v/9/thumbs.vtt?x=1', 'https://cdn.example.com/v/9/sprite.vtt', 'https://cdn.example.com/thumbnails/9.vtt', 'https://cdn.example.com/v/9/seek-thumbnails_en.vtt']) {
    assert.ok(isImageTrack(u), u);
  }
  for (const u of ['https://hls.ted.com/project_masters/1253/subtitles/en/full.vtt', 'https://cdn.example.com/v/9/captions.en.vtt', 'https://cdn.example.com/v/9/comic-strips.vtt', 'https://cdn.example.com/v/9/spritely-talk.srt',
    'https://cdn.example.com/v/9/thumbnail-design-lecture.vtt', 'https://cdn.example.com/v/9/thumbnailing.vtt', 'not an address']) {
    assert.ok(!isImageTrack(u), u);
  }
});

// ---------------------------------------------------------------- C4: the name the page's own video data gives
test('C4 (media.ccc.de): the talk is called what the page\'s video data calls it, not the sub-heading by the player', () => {
  const ccc = {
    signals: true, player: '', list: '', heading: 'Reverse engineering a train to analyze a suspicious malfunction', video: 'Breaking "DRM" in Polish trains', structured: 'Breaking "DRM" in Polish trains',
    title: 'Breaking "DRM" in Polish trains - media.ccc.de', site: '', host: 'media.ccc.de', h1: 'Breaking "DRM" in Polish trains', duration: 3705.72,
  };
  const got = chooseName(ccc);
  assert.deepEqual([got.name, got.source], ['Breaking "DRM" in Polish trains', 'structured']);
  // The player's own label and a highlighted lesson by the player still come first; without video data it is as it was.
  assert.equal(chooseName({ ...ccc, list: '003: Highlighted lesson' }).name, '003: Highlighted lesson');
  assert.equal(chooseName({ ...ccc, player: 'From the player' }).name, 'From the player');
  assert.equal(chooseName({ ...ccc, video: '' }).name, 'Reverse engineering a train to analyze a suspicious malfunction');
  // Video data that names nothing ("Video"), or that the page's title does not bear out (an app that went on to
  // another video without rewriting its data), is passed over.
  assert.equal(chooseName({ ...ccc, video: 'Video' }).name, 'Reverse engineering a train to analyze a suspicious malfunction');
  assert.equal(chooseName({ ...ccc, video: 'The talk before this one', structured: 'The talk before this one' }).name, 'Reverse engineering a train to analyze a suspicious malfunction');
  // A lesson page titled after its course whose video data names the lesson: the lesson, filed under the course.
  const lesson = chooseName({ heading: 'Big Course', video: 'Lesson 4: Valves', structured: 'Lesson 4: Valves', title: 'Big Course | Academy', site: 'Academy', host: 'academy.example' });
  assert.deepEqual([lesson.name, lesson.course], ['Lesson 4: Valves', 'Big Course']);
});

test('7e (Wikimedia Commons, as the real page is): the film\'s name, and no "course" made of what is left of a file name', () => {
  const commons = chooseName({ signals: true, player: '', list: '', heading: 'Captions Edit', structured: 'Sintel movie 4K', title: 'File:Sintel movie 4K.webm - Wikimedia Commons', site: '', host: 'commons.wikimedia.org', h1: '' });
  assert.deepEqual([commons.name, commons.source, commons.course], ['Sintel movie 4K', 'structured', '']);
  // What is left of an ordinary title is still the course.
  assert.equal(chooseName({ heading: 'Lecture 2: Thermodynamics', title: 'Physics 101 - Lecture 2: Thermodynamics', host: 'x.example' }).course, 'Physics 101');
});

// ---------------------------------------------------------------- C5: links to media files
test('C5: a link to a sound file is a file to offer, as a link to a video file is', () => {
  for (const ext of ['mp3', 'm4a', 'ogg', 'opus', 'wav', 'flac']) {
    const got = classifyUrl(`https://oyc.yale.edu/sites/default/files/lecture01.${ext}`);
    assert.deepEqual([got?.kind, got?.mediaType, got?.ext], ['direct', 'audio', ext]);
  }
  assert.equal(classifyUrl('https://see.stanford.edu/videos/courses/see/CS106A/CS106A-lecture01.mp4')?.mediaType, 'video');
});

test('C5 (Stanford Engineering Everywhere): a lecture behind a link that only says "Download" is named from its row', () => {
  const see = (n) => ({ url: `https://see.stanford.edu/videos/courses/see/CS106A/CS106A-lecture${String(n).padStart(2, '0')}.mp4`, label: 'Download', row: `Lecture ${n}` });
  assert.deepEqual(linkName(see(1), { several: true }), { title: 'Lecture 1', source: 'link' });
  assert.deepEqual(linkName(see(28), { several: true }), { title: 'Lecture 28', source: 'link' });
  // The link's own words come first when they name the file; then its row; then (among several) the file's own name.
  assert.deepEqual(linkName({ url: 'https://x.example/a.mp3', label: '1 Laying Plans - 2 Waging War download', row: 'Chapter list' }, { several: true }), { title: '1 Laying Plans - 2 Waging War', source: 'link' });
  assert.deepEqual(linkName({ url: 'https://x.example/v/Week%203%20-%20Valves.mp4', label: 'MP4', row: 'Download' }, { several: true }), { title: 'Week 3 - Valves', source: 'file' });
  assert.deepEqual(linkName({ url: 'https://x.example/v/Week%203%20-%20Valves.mp4', label: 'MP4', row: '3 Valves and pumps MP4 Download' }, { several: true }), { title: '3 Valves and pumps', source: 'link' });
  // A lone "Download video" is the page's lecture: it takes the page's name (nothing is said here).
  assert.deepEqual(linkName({ url: 'https://x.example/v/lec01_300k.mp4', label: 'Download video', row: '' }, { several: false }), { title: '', source: '' });
  assert.equal(linkTitle('Download'), '');
  assert.equal(linkTitle('Lecture 12'), 'Lecture 12');
});

test('C5: a list of lectures the page links to stays in the page\'s order; what the page has loaded comes first, the biggest first', () => {
  const media = [
    { id: 'l1', kind: 'direct', linked: true, size: 300 }, { id: 'l2', kind: 'direct', linked: true, size: 900 }, { id: 'l3', kind: 'direct', linked: true, size: 0 },
    { id: 'cc', kind: 'subtitle' }, { id: 'small', kind: 'direct', size: 10 }, { id: 'big', kind: 'direct', size: 50 }, { id: 'yt', kind: 'embed' }, { id: 'hls', kind: 'hls' },
  ];
  const order = media.map((m) => m.id);
  assert.deepEqual(listSort([...media].reverse(), order).map((m) => m.id), ['hls', 'big', 'small', 'l1', 'l2', 'l3', 'yt', 'cc']);
});

// ---------------------------------------------------------------- 6: linked files wait until StreamSnag is opened
test('6: links to media files are kept as candidates per frame; the same list again keeps what was found out, a changed list is looked at again', () => {
  const a = [{ url: 'https://x.example/1.mp4', label: 'One' }, { url: 'https://x.example/2.mp4', label: 'Two' }];
  let sets = noteLinks(undefined, 0, a);
  assert.equal(linksWaiting(sets), 2);
  assert.equal(sets[0].done, false);
  sets[0].done = true; // looked at (StreamSnag was opened)
  assert.equal(linksWaiting(sets), 0);
  const kept = sets[0];
  sets = noteLinks(sets, 0, a.map((x) => ({ ...x })));
  assert.equal(sets[0], kept, 'the same links, reported again: nothing to do');
  sets = noteLinks(sets, 0, [...a, { url: 'https://x.example/3.mp4', label: 'Three' }]);
  assert.deepEqual([sets[0].done, linksWaiting(sets)], [false, 3]);
  // Another frame's links are its own; a frame that reports none any more has none; at most 150 a frame (round 3, E4: it was 60), each address once.
  sets = noteLinks(sets, 4, [{ url: 'https://y.example/a.mp3', label: '' }]);
  assert.equal(linksWaiting(sets), 4);
  sets = noteLinks(sets, 0, []);
  assert.deepEqual(Object.keys(sets), ['4']);
  const many = Array.from({ length: 400 }, (_, i) => ({ url: `https://x.example/${i % 200}.mp4`, label: 'x'.repeat(900), row: 'r'.repeat(900) }));
  const big = noteLinks({}, 0, many)[0].items;
  assert.equal(big.length, 150);
  assert.ok(big.every((it) => it.label.length <= 200 && it.row.length <= 200));
  assert.deepEqual(noteLinks({}, 0, [{ url: 'javascript:alert(1)' }, { url: 7 }, null, { url: 'https://x.example/ok.mp4' }])[0].items.map((x) => x.url), ['https://x.example/ok.mp4']);
});

// ---------------------------------------------------------------- 7a: TED's own caption file
test('7a (TED): a caption file the player loads from the folder of the stream\'s own subtitle playlists is the stream\'s, not a file of its own', () => {
  const master = 'https://hls.ted.com/project_masters/1253/manifest.m3u8?intro_master_id=9294';
  const pl = parseM3U8(['#EXTM3U',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="en",NAME="English",URI="/project_masters/1253/subtitles/en.m3u8?intro_master_id=9294"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="fr",NAME="French",URI="/project_masters/1253/subtitles/fr.m3u8?intro_master_id=9294"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1104484,RESOLUTION=640x480,SUBTITLES="subs"', 'index-f9-v1.m3u8?intro_master_id=9294'].join('\n'), master);
  const parts = addParts(emptyParts(), hlsParts(pl, master));
  assert.deepEqual(parts.folders, ['https://hls.ted.com/project_masters/1253/subtitles/']);
  const key = (u) => dedupeKey(u);
  assert.ok(ownCaption(parts, key('https://hls.ted.com/project_masters/1253/subtitles/en/full.vtt?intro_master_id=9294')));
  assert.ok(ownCaption(parts, key('https://hls.ted.com/project_masters/1253/subtitles/fr.vtt')));
  // Not: a caption file somewhere else, another talk's, or a file in that folder that is no caption file.
  assert.ok(!ownCaption(parts, key('https://hls.ted.com/project_masters/1253/full.vtt')));
  assert.ok(!ownCaption(parts, key('https://hls.ted.com/project_masters/9999/subtitles/en/full.vtt')));
  assert.ok(!ownCaption(parts, key('https://www.ted.com/project_masters/1253/subtitles/en/full.vtt')));
  assert.ok(!ownCaption(parts, key('https://hls.ted.com/project_masters/1253/subtitles/en/intro.mp4')));
  // A stream that keeps everything in one folder says nothing about the caption files beside it.
  const flat = 'https://cdn.example.com/v/9/master.m3u8';
  const flatParts = addParts(emptyParts(), hlsParts(parseM3U8(['#EXTM3U', '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",LANGUAGE="en",NAME="English",URI="subs_en.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000,SUBTITLES="s"', 'v.m3u8'].join('\n'), flat), flat));
  assert.deepEqual(flatParts.folders, []);
  assert.ok(!ownCaption(flatParts, key('https://cdn.example.com/v/9/lecture2.en.vtt')));
  assert.ok(!ownCaption(emptyParts(), key('https://cdn.example.com/v/9/lecture2.en.vtt')));
});

// ---------------------------------------------------------------- 7b: which language
test('7b: one order for every choice of language: yours, then the page\'s, then English, then the first listed', () => {
  const ted = ['pt-br', 'mfe', 'el', 'eo', 'ja', 'fr', 'en', 'de'].map((language) => ({ language, name: language, url: `https://hls.ted.com/subs/${language}.m3u8` }));
  const first = (prefs) => orderSubtitles(ted, prefs)[0].language;
  assert.equal(first({ langs: ['de-AT', 'de'], pageLang: 'ja' }), 'de');
  assert.equal(first({ langs: ['sw'], pageLang: 'ja' }), 'ja', 'your language is not there: the page\'s');
  assert.equal(first({ langs: ['sw'], pageLang: 'ko' }), 'en', 'nor the page\'s: English');
  assert.equal(first({ langs: ['sw'], pageLang: '' }), 'en');
  assert.equal(orderSubtitles(ted.filter((s) => s.language !== 'en'), { langs: ['sw'], pageLang: 'ko' })[0].language, 'pt-br', 'none of them: the first');
  // Separate caption files are chosen the same way.
  const v = { id: 'v', kind: 'direct' };
  const files = ['ar', 'en', 'ja'].map((lang, i) => ({ id: `s${i}`, kind: 'subtitle', ext: 'vtt', lang, url: `https://x.example/t.vtt?lang=${lang}` }));
  assert.deepEqual(captionFiles([v, ...files], v, { langs: ['sw'], pageLang: 'ja' }).map((s) => s.lang), ['ja', 'en', 'ar']);
  assert.deepEqual(captionFiles([v, ...files], v, { langs: ['ar'], pageLang: 'ja' }).map((s) => s.lang), ['ar', 'ja', 'en']);
});

// ---------------------------------------------------------------- found while re-checking the real pages
test('media.ccc.de\'s download links: words that only say the format, the language and the size name nothing; two linked sound files of one size are two files', () => {
  for (const t of ['Download mp3 eng 56.5 MB', 'opus deu 37.3 MB', 'Download 1080p eng-deu-fra 703.5 MB', 'MP3 (English)', 'webm 576p fra']) assert.equal(linkTitle(t), '', t);
  for (const t of ['Lecture 3: English grammar', 'Opus 27, no. 2', 'Is it my turn']) assert.ok(linkTitle(t), t);
  assert.deepEqual(linkName({ url: 'https://cdn.media.ccc.de/congress/2023/mp3/37c3-12142-eng-Breaking_DRM_in_Polish_trains_mp3.mp3', label: 'Download mp3 eng 56.5 MB', row: '' }, { several: true }),
    { title: '37c3-12142-eng-Breaking DRM in Polish trains', source: 'file' }); // (round 3, E10: without the "mp3" that only says its format)
  // A talk's English and German sound tracks are as long as each other, and at a fixed bitrate as big.
  const eng = { id: 'a', kind: 'direct', mediaType: 'audio', ext: 'mp3', size: 59244544, linked: true, url: 'https://cdn.media.ccc.de/congress/2023/mp3/37c3-12142-eng-x_mp3.mp3' };
  const deu = { ...eng, id: 'b', url: 'https://cdn.media.ccc.de/congress/2023/mp3-translated/37c3-12142-deu-x_mp3-2.mp3' };
  assert.equal(sameMedia(eng, deu), false);
  // What still is one file: the same size where one of the two was loaded by a player, and two linked video files of one size (archive.org's original and its copy).
  assert.equal(sameMedia(eng, { ...deu, linked: undefined }), true);
  assert.equal(sameMedia({ ...eng, mediaType: 'video', ext: 'mp4' }, { ...deu, mediaType: 'video', ext: 'mp4' }), true);
});

test('PeerTube (as the real page is): a name the page\'s data writes with a character code is the name it stands for', () => {
  const tube = {
    signals: true, player: '', list: '', heading: 'What\'s New in Blender 5.3! Official Overview', structured: 'What&#39;s New in Blender 5.3! Official Overview', video: 'What&#39;s New in Blender 5.3! Official Overview',
    title: 'What\'s New in Blender 5.3! Official Overview - Blender Video', site: 'Blender Video', host: 'video.blender.org', h1: 'What\'s New in Blender 5.3! Official Overview',
  };
  const got = chooseName(tube);
  assert.deepEqual([got.name, got.course], ['What\'s New in Blender 5.3! Official Overview', 'Blender Video']);
  assert.equal(chooseName({ structured: 'Tom &amp; Jerry: the chase', title: 'Cartoons', host: 'x.example' }).name, 'Tom & Jerry: the chase');
});

test('PeerTube: after the page has gone on to another video without a load, the data it was loaded with no longer names the video', () => {
  const second = {
    signals: true, player: '', list: '', heading: 'TOUCH your Blender', structured: 'What&#39;s New in Blender 5.3! Official Overview', video: 'What&#39;s New in Blender 5.3! Official Overview',
    title: 'TOUCH your Blender - Blender Video', site: 'Blender Video', host: 'video.blender.org', h1: 'TOUCH your Blender', moved: true,
  };
  assert.deepEqual([chooseName(second).name, chooseName(second).course], ['TOUCH your Blender', 'Blender Video']);
  // Data the app has rewritten for the new page (the title says the same) still counts; and on a page that was loaded, data the title does not repeat is the lesson's name as before.
  assert.equal(chooseName({ ...second, heading: 'Comments', structured: 'TOUCH your Blender', video: '' }).name, 'TOUCH your Blender');
  assert.equal(chooseName({ heading: 'Big Course', structured: 'Lesson 4: Valves', title: 'Big Course', host: 'x.example' }).name, 'Lesson 4: Valves');
});

test('FOSDEM (as the real page is): the heading of a section by the player ("Speakers", "Links") is not the talk\'s name', () => {
  const fosdem = {
    signals: true, player: '', list: '', heading: 'Speakers', structured: 'FOSDEM 2023 - An introduction to MicroPython', video: '', title: 'FOSDEM 2023 - An introduction to MicroPython',
    site: '', host: 'archive.fosdem.org', h1: 'An introduction to MicroPython',
  };
  assert.equal(chooseName(fosdem).name, 'An introduction to MicroPython');
  for (const heading of ['Links', 'Attachments', 'Abstract', 'Presenters', 'About the speaker']) assert.equal(chooseName({ ...fosdem, heading }).name, 'An introduction to MicroPython', heading);
  // A lesson's heading on a page titled after its course stays the name.
  assert.equal(chooseName({ ...fosdem, heading: 'Speakers of the house: a history' }).name, 'Speakers of the house: a history');
});

test('Wikimedia Commons (as the real page is): a page\'s one linked file is the page\'s video, whatever stands beside its link; a row names a file only among several', () => {
  const original = { url: 'https://upload.wikimedia.org/wikipedia/commons/f/f1/Sintel_movie_4K.webm', label: 'Original file', row: '(WebM audio/video file, VP8/Vorbis, length 14 min 48 s, 4,096 × 1,744 pixels, 31.51 Mbps overall, file size: 3.26 GB)' };
  assert.deepEqual(linkName(original, { several: false }), { title: '', source: '' });
});

test('archive.org audiobook: a link that names a chapter of the page\'s playlist is that chapter in another file, not a second chapter', () => {
  const chapter = (n, extra = {}) => ({ id: `c${n}`, kind: 'direct', mediaType: 'audio', title: `${n} Laying Plans`, nameSource: 'playlist', set: `list:https://archive.org/download/b/ch${n}_64kb.mp3`, ...extra });
  const media = [chapter(1), chapter(1, { id: 'c1ogg', variantOf: 'c1' }), chapter(2)];
  const link = { id: 'l1', kind: 'direct', mediaType: 'audio', linked: true, title: '1 laying plans', nameSource: 'link' };
  assert.equal(sameLecture([...media, link], link), 'list:https://archive.org/download/b/ch1_64kb.mp3');
  // Not: another name, another kind of media, a name the link did not give, a name two entries share, an entry that was taken off the list.
  assert.equal(sameLecture([...media, link], { ...link, title: '3 Attack' }), '');
  assert.equal(sameLecture([...media, link], { ...link, mediaType: 'video' }), '');
  assert.equal(sameLecture([...media, link], { ...link, nameSource: 'file' }), '');
  assert.equal(sameLecture([...media, chapter(1, { id: 'again', set: 'list:other' }), link], link), '');
  assert.equal(sameLecture([chapter(1, { dismissed: true }), link], link), '');
});

test('a title that is a file\'s name on a site the address does not name: still no "course" made of what is left of it', () => {
  const got = chooseName({ signals: true, heading: 'Captions Edit', structured: 'Sintel movie 4K', title: 'File:Sintel movie 4K.webm - Some Wiki', site: '', host: '127.0.0.1', h1: 'File:Sintel movie 4K.webm' });
  assert.deepEqual([got.name, got.course], ['Sintel movie 4K', '']);
  // A name followed by something that is no file type keeps what is left as its course.
  assert.equal(chooseName({ heading: 'Valves', title: 'Valves.and pumps - Hydraulics 101', host: 'x.example' }).course, '.and pumps - Hydraulics 101');
});

test('7a: only a folder inside the stream\'s own counts as its subtitles\' folder (never a whole server, or a folder shared with other videos)', () => {
  const master = 'https://cdn.example.com/v/9/master.m3u8';
  const withSubsAt = (uri) => addParts(emptyParts(), hlsParts(parseM3U8(['#EXTM3U', `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",LANGUAGE="en",NAME="English",URI="${uri}"`,
    '#EXT-X-STREAM-INF:BANDWIDTH=1000,SUBTITLES="s"', 'v.m3u8'].join('\n'), master), master));
  assert.deepEqual(withSubsAt('subs/en.m3u8').folders, ['https://cdn.example.com/v/9/subs/']);
  assert.deepEqual(withSubsAt('/en.m3u8').folders, [], 'the server\'s top folder holds everyone\'s files');
  assert.deepEqual(withSubsAt('../captions/en.m3u8').folders, [], 'a folder beside the stream\'s may hold other videos\' captions');
  assert.deepEqual(withSubsAt('https://subs.example.net/9/en.m3u8').folders, []);
  assert.ok(!ownCaption(withSubsAt('/en.m3u8'), dedupeKey('https://cdn.example.com/v/12/lecture12.en.vtt')));
});
