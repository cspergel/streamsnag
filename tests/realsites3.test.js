// What the third round of testing on real public websites found (E1 to E17 of that report, and what was
// left of B3 and B14): names that say nothing ("Blender Video", "Play"), which lecture a course page leads
// with, more than 40 media links, one video listed as several, and what may be asked before StreamSnag is
// opened. The units below are the ones those pages go through; each case is a page of the report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseName, cleanPageTitle, siteOnly, controlOnly, linkTitle, weakName, fileTitle, fileStem, recordingKey, whenOnly } from '../extension/lib/naming.js';
import { MAX_LINKS, noteLinks, linksWaiting, linksLeftOut, leftOutNote, linkName, formatTwins } from '../extension/lib/linked.js';
import { flagItems, heroChoice, reviewGroups, usableName } from '../extension/lib/review.js';
import { groupVariants, variantOptions, heightOf } from '../extension/lib/variants.js';
import { hlsParts, isPart, addParts, emptyParts } from '../extension/lib/parts.js';
import { parseM3U8 } from '../extension/lib/hls.js';
import { dedupeKey, sameNamedFile } from '../extension/lib/detect.js';
import { uniqueChoices, canBulkDownload } from '../extension/lib/quality.js';
import { rankVideoOptions } from '../extension/lib/util.js';

const named = (signals) => { const r = chooseName(signals); return r ? [r.name, r.source] : null; };

// ---------------------------------------------------------------- E1: the site's own name is not a video's
test('E1 (PeerTube, video.blender.org): the site\'s name left in the page\'s data is not what the video is called; the title is', () => {
  // As the real page is after going from the listing to a video without a load: og:title and og:site_name both "Blender Video".
  const blender = { structured: 'Blender Video', title: 'What\'s New in Blender 5.3! Official Overview - Blender Video', site: 'Blender Video', host: 'video.blender.org', h1: 'What\'s New in Blender 5.3! Official Overview', moved: true };
  assert.deepEqual(named(blender), ['What\'s New in Blender 5.3! Official Overview', 'title']);
  assert.deepEqual(named({ ...blender, title: 'TOUCH your Blender 👀 Blender Today LIVE #292 - Blender Video', h1: '' }), ['TOUCH your Blender 👀 Blender Today LIVE #292', 'title']);
  // Without og:site_name the part cut off the title as the site's name says so, and so do the words of the address.
  assert.deepEqual(named({ ...blender, site: '' }), ['What\'s New in Blender 5.3! Official Overview', 'title']);
  assert.deepEqual(named({ player: 'Blender Video', title: 'Sintel', host: 'video.blender.org' }), ['Sintel', 'title'], 'whatever part of the page says it (here the player\'s label)');
  assert.deepEqual(named({ video: 'Blender Video', title: 'Sintel - Blender Video', host: 'video.blender.org' }), ['Sintel', 'title']);
  // A name that merely has the site's word in it is a name, and is kept before the title.
  assert.deepEqual(named({ structured: 'What\'s New in Blender 5.3', title: 'Overview - Blender Video', site: 'Blender Video', host: 'video.blender.org' }), ['What\'s New in Blender 5.3', 'structured']);
  // What a rule for the site says is never second-guessed.
  assert.deepEqual(named({ rule: 'Blender Video', title: 'Sintel - Blender Video', site: 'Blender Video', host: 'video.blender.org' }), ['Blender Video', 'rule']);
});

test('E1: what counts as the site\'s own name, and what does not', () => {
  assert.equal(siteOnly('Blender Video', { site: 'Blender Video', host: 'video.blender.org' }), true);
  assert.equal(siteOnly('blender video', { host: 'video.blender.org' }), true, 'made of the words of the address alone');
  assert.equal(siteOnly('Khan Academy', { host: 'www.khanacademy.org' }), true);
  assert.equal(siteOnly('Carmin PeerTube', { host: 'peertube.carmin.tv' }), true);
  assert.equal(siteOnly('Stanford Engineering Everywhere', { host: 'see.stanford.edu', cut: 'Stanford Engineering Everywhere' }), true, 'the part of the title that was cut as the site');
  assert.equal(siteOnly('Stanford Engineering Everywhere', { host: 'see.stanford.edu' }), false, 'only one of its words is the address\'s: not known to be the site without the title saying so');
  assert.equal(siteOnly('What\'s New in Blender 5.3', { site: 'Blender Video', host: 'video.blender.org' }), false);
  assert.equal(siteOnly('Video', { host: 'video.blender.org' }), false, '"video" is no site\'s own word');
  assert.equal(siteOnly('DASH-IF Reference Client', { host: 'reference.dashif.org' }), false);
  assert.equal(siteOnly('', { site: '', host: '' }), false);
  // cleanPageTitle still answers with its two fields only.
  assert.deepEqual(cleanPageTitle('Sintel - Blender Video', { site: 'Blender Video', host: 'video.blender.org' }), { name: 'Sintel', course: '' });
});

test('E1 (carmin.tv): a player in a frame that knows nothing but its site\'s name says so, and the page around it names the talk', () => {
  // The embedded PeerTube player's own document, as it is: title "Carmin PeerTube", nothing else.
  const frame = chooseName({ signals: true, title: 'Carmin PeerTube', host: 'peertube.carmin.tv' });
  assert.equal(frame.siteOnly, true);
  assert.equal(frame.name, 'Carmin PeerTube', 'it is still all that frame has, for a page with nothing better');
  // The page around it, as it is: the talk's name in its video data and in its title. No rule is needed.
  const top = chooseName({ signals: true, video: 'Complexity of Lasso with Normalized Data', structured: 'Complexity of Lasso with Normalized Data', title: 'Complexity of Lasso with Normalized Data | Vidéo | Carmin.tv', host: 'www.carmin.tv', h1: 'Heading 1' });
  assert.deepEqual([top.name, top.source, top.siteOnly], ['Complexity of Lasso with Normalized Data', 'structured', undefined]);
  // A page whose title says more than the site is never marked.
  assert.equal(chooseName({ title: 'hls.js demo', host: 'hlsjs.video-dev.org' }).siteOnly, undefined);
});

test('E3 (Stanford Engineering Everywhere): the site\'s name in the page\'s top heading is neither the lecture\'s name nor its course', () => {
  // As the real page is: three h1 (the first is the site's), no og:site_name, the course after the site in the title.
  const see = chooseName({ signals: true, heading: 'Stanford Engineering Everywhere', h1: 'Stanford Engineering Everywhere', title: 'Stanford Engineering Everywhere | CS106A - Programming Methodology', host: 'see.stanford.edu' });
  assert.deepEqual([see.name, see.source, see.heading], ['CS106A - Programming Methodology', 'title', '']);
  // (The worker takes a linked lecture's course from `heading`, else from `name`: here the course, not the site.)
  assert.equal([see.heading, see.name].find((x) => x && x !== 'Lecture 1'), 'CS106A - Programming Methodology');
  // What the title calls the page, for the course of files the page only links to; never the site's name.
  assert.equal(see.page, 'CS106A - Programming Methodology');
  assert.equal(chooseName({ list: 'Courses', h1: 'Stanford Engineering Everywhere', title: 'Stanford Engineering Everywhere | CS106A - Programming Methodology', host: 'see.stanford.edu' }).page, 'CS106A - Programming Methodology', 'also where a highlighted entry of the menu is taken for the page\'s name');
  assert.equal(chooseName({ structured: 'A talk', title: 'Blender Video', site: 'Blender Video', host: 'video.blender.org' }).page, '');
  // A main heading that is the page's own keeps being reported.
  assert.equal(chooseName({ h1: 'Lecture 1: Probability Models and Axioms', title: 'Lecture 1 | Course | MIT OpenCourseWare', host: 'ocw.mit.edu' }).heading, 'Lecture 1: Probability Models and Axioms');
});

// ---------------------------------------------------------------- E2: a control's word names nothing
test('E2: "Play", "Listen", "Watch the video" and the like name nothing; a link that says more keeps what it says', () => {
  for (const t of ['Play', 'play', 'Listen', 'Watch', 'View', 'Open', 'Stream', '▶ Play', 'Play ▶', 'Play episode', 'Play Episode', 'Listen to the latest', 'Watch the video', 'Listen now', 'Open in new tab', 'Play this episode']) {
    assert.equal(controlOnly(t), true, t);
    assert.equal(linkTitle(t), '', t);
  }
  for (const [t, want] of [['Play Chapter 3', 'Chapter 3'], ['Watch: Sorting', 'Sorting'], ['Play: Keynote (Google I/O \'18)', 'Keynote (Google I/O \'18)'], ['Listen to Episode 12: Canaries', 'Episode 12: Canaries'],
    ['We now have Kerr’s Law', 'We now have Kerr’s Law'], ['Playing with fire', 'Playing with fire'], ['Open problems in topology', 'Open problems in topology'], ['Stream processing', 'Stream processing'], ['Lecture 4: Counting download', 'Lecture 4: Counting']]) {
    assert.equal(controlOnly(t), false, t);
    assert.equal(linkTitle(t), want, t);
  }
  // A player's or a list entry's label that is a control's word is as weak as "Video"; a page's title is judged as before.
  assert.equal(weakName('Play', 'player'), true);
  assert.equal(weakName('Play', 'embed'), true);
  assert.equal(weakName('Play episode', 'list'), true);
  assert.equal(weakName('Play'), false);
  assert.equal(weakName('Playing with fire', 'player'), false);
});

test('E2 (changelog.com/podcast, librivox.org): a "Play" link is called what its row says: the heading, else the row\'s main link', () => {
  // changelog.com: the link says "Play"; the episode's block has the heading.
  const ep = { url: 'https://op3.dev/e/https://cdn.changelog.com/uploads/podcast/689/the-changelog-689.mp3', label: 'Play', row: 'We now have Kerr’s Law', near: 'Changelog Interviews #689' };
  assert.deepEqual(linkName(ep, { several: true }), { title: 'We now have Kerr’s Law', source: 'link' });
  // librivox.org: "Play" in one cell, the chapter's own link in the next; the cells' loose words are a number and a length.
  const ch = { url: 'https://www.archive.org/download/art_of_war_librivox/art_of_war_01-02_sun_tzu_64kb.mp3', label: 'Play', row: '', near: '01 - Laying Plans / 02 - Waging War' };
  assert.deepEqual(linkName(ch, { several: true }), { title: '01 - Laying Plans / 02 - Waging War', source: 'link' });
  assert.deepEqual(linkName({ ...ch, row: '01 00:08:26' }, { several: true }), { title: '01 - Laying Plans / 02 - Waging War', source: 'link' }, 'a row that only says when or how long comes after the main link');
  assert.deepEqual(linkName({ ...ch, row: '2026-11-04 · 45 min', near: 'Episode 5: Foo' }, { several: true }), { title: 'Episode 5: Foo', source: 'link' });
  // A row that names the lecture still comes before another link in it (Stanford: "Lecture 1" beside "Transcript").
  assert.deepEqual(linkName({ url: 'https://see.stanford.edu/v/CS106A-lecture01.mp4', label: 'Download', row: 'Lecture 1', near: 'Transcript (HTML)' }, { several: true }), { title: 'Lecture 1', source: 'link' });
  // With nothing else, a "Play" link is called by its file, never "Play"; and a lone link still leaves the name to the page.
  assert.deepEqual(linkName({ ...ch, near: '' }, { several: true }), { title: 'art of war 01-02 sun tzu', source: 'file' });
  assert.deepEqual(linkName(ep, { several: false }), { title: '', source: '' });
  assert.equal(whenOnly('2026-11-04 · 45 min') && whenOnly('01 00:08:26') && whenOnly('Jan 5th, 2024'), true);
  assert.equal(whenOnly('Lecture 1') || whenOnly('Moira Fogarty') || whenOnly('Minutes of the meeting'), false);
});

test('E2: thirty episodes under their own names are not "the same as another one"; thirty that are all called "Play" would be', () => {
  const eps = (name) => Array.from({ length: 30 }, (_, i) => ({ id: `e${i}`, name: name(i), kind: 'direct', mediaType: 'audio', linked: true, url: `https://cdn.example/podcast/${700 - i}/show-${700 - i}.mp3`, size: 5e7 + i, order: i }));
  assert.equal(flagItems(eps((i) => `Episode ${700 - i}: a title of its own`)).size, 0);
  const same = flagItems(eps(() => 'Play'));
  assert.equal(same.size, 29, 'which is what the page showed before: every row but one marked');
  assert.ok([...same.values()].every((why) => why === 'copy'));
});

// ---------------------------------------------------------------- E3: which lecture a course page leads with
test('E3: on a page that only links to its lectures the first in the page\'s order is in front, whichever link answered last', () => {
  const lectures = Array.from({ length: 28 }, (_, i) => ({ id: `l${i + 1}`, kind: 'direct', linked: true, detectedAt: 1000 + ((i * 37) % 28) })); // found in another order
  assert.equal(lectures.reduce((a, b) => (b.detectedAt > a.detectedAt ? b : a)).id !== 'l1', true, '(the newest is not the first: the old rule would have put it in front)');
  assert.deepEqual(heroChoice(lectures, {}), { id: 'l1', why: '' });
  assert.deepEqual(heroChoice(lectures.map((m) => ({ ...m, linked: undefined, listed: true })), {}), { id: 'l1', why: '' }, 'the same for a playlist\'s entries none of which is loaded');
  // The one already in front stays; the one playing in the page comes first.
  assert.deepEqual(heroChoice(lectures, { kept: 'l9' }), { id: 'l9', why: '' });
  // Embedded players that have loaded nothing (three YouTube players on a Canvas page) say no more than links do: the first.
  const players = [3, 1, 2].map((at, i) => ({ id: `yt${i + 1}`, kind: 'embed', detectedAt: at }));
  assert.deepEqual(heroChoice(players, {}), { id: 'yt1', why: '' });
  // A page whose player has loaded videos keeps the old rule: the newest (what was just started).
  const played = [{ id: 'a', kind: 'hls', detectedAt: 1 }, { id: 'b', kind: 'hls', detectedAt: 2 }];
  assert.deepEqual(heroChoice(played, {}), { id: 'b', why: '' });
  assert.deepEqual(heroChoice([...lectures, played[0]], {}), { id: 'a', why: '' }, 'and a loaded video is in front of any number of links');
});

// ---------------------------------------------------------------- E4: more than 40 media links
test('E4 (video.fosdem.org/2024/h2214/, 82 links): 150 links a frame are kept, and the ones past that are counted, not dropped without a word', () => {
  assert.equal(MAX_LINKS, 150);
  const links = (n) => Array.from({ length: n }, (_, i) => ({ url: `https://video.example/2024/room/talk-${i}.mp4`, label: `talk-${i}.mp4` }));
  let sets = noteLinks({}, 0, links(82));
  assert.deepEqual([sets[0].items.length, sets[0].left, linksLeftOut(sets)], [82, 0, 0], 'the page of the report fits whole');
  sets = noteLinks({}, 0, links(150));
  assert.deepEqual([sets[0].items.length, linksLeftOut(sets)], [150, 0], 'exactly the limit: nothing left out');
  sets = noteLinks({}, 0, links(151));
  assert.deepEqual([sets[0].items.length, linksLeftOut(sets)], [150, 1], 'one over: one left out');
  // The page's own script reports at most the limit and says how many more it has.
  sets = noteLinks({}, 0, links(150), 37);
  assert.deepEqual([sets[0].items.length, sets[0].left, linksLeftOut(sets)], [150, 37, 37]);
  // The count alone changing does not make the links be looked at again; nonsense from a page counts as none.
  sets[0].done = true;
  const again = noteLinks(sets, 0, links(150), 40);
  assert.deepEqual([again[0].done, again[0].left], [true, 40]);
  assert.equal(linksLeftOut(noteLinks({}, 0, links(3), -5)), 0);
  assert.equal(linksLeftOut(noteLinks({}, 0, links(3), 'many')), 0);
  // Links past the page's own limit of looks (several frames) are counted too.
  assert.equal(linksLeftOut({ 0: { items: [], done: true, left: 2 }, 3: { items: [], done: true, skipped: 5 } }), 7);
  assert.equal(leftOutNote(0), '');
  assert.equal(leftOutNote(1), '1 more link on this page was left out. StreamSnag looks at the first 150 on a page.');
  assert.equal(leftOutNote(37), '37 more links on this page were left out. StreamSnag looks at the first 150 on a page.');
});

test('E4: a talk linked as MP4 and as ".av1.webm" is one recording in two formats; ".av1" is not part of its name', () => {
  const dir = 'https://video.fosdem.org/2024/h2214/';
  const a = `${dir}fosdem-2024-1648-confidential-computing-devroom-welcome.av1.webm`;
  const b = `${dir}fosdem-2024-1648-confidential-computing-devroom-welcome.mp4`;
  const c = `${dir}fosdem-2024-1769-reproducible-builds-for-confidential-computing.mp4`;
  assert.equal(linkTitle('fosdem-2024-1648-confidential-computing-devroom-welcome.av1.webm'), 'fosdem-2024-1648-confidential-computing-devroom-welcome');
  assert.equal(linkTitle('fosdem-2024-1648-confidential-computing-devroom-welcome.mp4'), 'fosdem-2024-1648-confidential-computing-devroom-welcome');
  assert.equal(fileTitle(a), 'fosdem-2024-1648-confidential-computing-devroom-welcome');
  assert.equal(usableName('fosdem-2024-1648-confidential-computing-devroom-welcome'), true, 'words joined by hyphens are a name, not a machine-made id');
  assert.equal(usableName('Video-7bad5878-1561-4a12-a68a-0a6db5be0194_processed'), false, 'an id with a word at each end still is one');
  const twins = formatTwins([a, b, c].map((url) => ({ url, mediaType: 'video', title: '' })));
  assert.equal(twins.get(a), twins.get(b));
  assert.ok(twins.get(a));
  assert.equal(twins.has(c), false, 'a talk in one format is nobody\'s twin');
  // Folded, the MP4 is the first choice and the WebM the second: one row, not two.
  const media = [{ id: 'w', kind: 'direct', ext: 'webm', url: a, size: 36e6, set: twins.get(a), linked: true }, { id: 'm', kind: 'direct', ext: 'mp4', url: b, size: 256e6, set: twins.get(b), linked: true }, { id: 'o', kind: 'direct', ext: 'mp4', url: c, size: 444e6, linked: true }];
  groupVariants(media);
  assert.deepEqual(media.filter((m) => !m.variantOf).map((m) => m.id), ['m', 'o']);
  assert.deepEqual(variantOptions(media[1]).map((o) => o.label), ['MP4 · 244 MB', 'WEBM · 34.3 MB']);
});

test('E4 / E10: what makes two linked files one recording, and what does not', () => {
  const twin = (...urls) => { const t = formatTwins(urls.map((u) => (typeof u === 'string' ? { url: u, mediaType: /\.(mp3|opus|ogg|m4a)$/.test(u) ? 'audio' : 'video', title: '' } : u))); return urls.map((u) => t.get(typeof u === 'string' ? u : u.url) || ''); };
  // media.ccc.de: each language's MP3 and Opus file are one recording (in folders of their own); the two languages are two.
  const ccc = twin('https://cdn.media.ccc.de/congress/2023/mp3/37c3-12142-eng-Breaking_DRM_in_Polish_trains_mp3.mp3', 'https://cdn.media.ccc.de/congress/2023/opus/37c3-12142-eng-Breaking_DRM_in_Polish_trains_opus.opus',
    'https://cdn.media.ccc.de/congress/2023/mp3-translated/37c3-12142-deu-Breaking_DRM_in_Polish_trains_mp3-2.mp3', 'https://cdn.media.ccc.de/congress/2023/opus-translation/37c3-12142-deu-Breaking_DRM_in_Polish_trains_opus-2.opus');
  assert.ok(ccc[0] && ccc[0] === ccc[1] && ccc[2] && ccc[2] === ccc[3] && ccc[0] !== ccc[2], JSON.stringify(ccc));
  assert.equal(fileTitle('https://cdn.media.ccc.de/congress/2023/mp3-translated/37c3-12142-deu-Breaking_DRM_in_Polish_trains_mp3-2.mp3'), '37c3-12142-deu-Breaking DRM in Polish trains', 'no "mp3-2" in the name');
  // librivox.org: the 64 kb file behind "Play" and the chapter's own file.
  const book = twin('https://www.archive.org/download/art_of_war_librivox/art_of_war_01-02_sun_tzu_64kb.mp3', 'https://www.archive.org/download/art_of_war_librivox/art_of_war_01-02_sun_tzu.mp3', 'https://www.archive.org/download/art_of_war_librivox/art_of_war_03-04_sun_tzu.mp3');
  assert.ok(book[0] && book[0] === book[1] && !book[2], JSON.stringify(book));
  // A lecture's quality files (cs50, videos.cern.ch): one recording.
  const q = twin('https://cdn.example/2024/lectures/0/lecture0-360p.mp4', 'https://cdn.example/2024/lectures/0/lecture0-720p.mp4', 'https://cdn.example/2024/lectures/0/lecture0-1080p.mp4', 'https://cdn.example/2024/lectures/1/lecture1-720p.mp4');
  assert.ok(q[0] && q[0] === q[1] && q[1] === q[2] && !q[3], JSON.stringify(q));
  // Not twins: the same file name twice (two courses' "lecture1.mp4"), a video and a sound file, short names in different folders, links that name them differently.
  assert.deepEqual(twin('https://x.example/a/introduction-to-sorting.mp4', 'https://x.example/b/introduction-to-sorting.mp4'), ['', '']);
  assert.deepEqual(twin('https://x.example/a/introduction-to-sorting.mp4', 'https://x.example/a/introduction-to-sorting.mp3'), ['', '']);
  assert.deepEqual(twin('https://x.example/week1/intro.mp4', 'https://x.example/week2/intro.webm'), ['', '']);
  assert.ok(twin('https://x.example/week1/intro.mp4', 'https://x.example/week1/intro.webm').every(Boolean), 'short names in one folder are');
  assert.deepEqual(twin({ url: 'https://x.example/a/session-recording-main.mp4', mediaType: 'video', title: 'Morning session' }, { url: 'https://x.example/a/session-recording-main.webm', mediaType: 'video', title: 'Evening session' }), ['', '']);
  assert.equal(recordingKey('https://x.example/v/1.mp4'), '', 'a number alone says nothing');
  // FOSDEM writes some names with a hyphen before the type ("…-instantly-.mp4" beside "…-instantly-.av1.webm"): still one recording, and no hyphen at the end of its name.
  const odd = twin('https://video.fosdem.org/2024/h2214/fosdem-2024-2003-better-than-loading-fast-is-loading-instantly-.av1.webm', 'https://video.fosdem.org/2024/h2214/fosdem-2024-2003-better-than-loading-fast-is-loading-instantly-.mp4');
  assert.ok(odd[0] && odd[0] === odd[1], JSON.stringify(odd));
  assert.equal(linkTitle('fosdem-2024-2003-better-than-loading-fast-is-loading-instantly-.mp4'), 'fosdem-2024-2003-better-than-loading-fast-is-loading-instantly');
  // A short name of words and numbers ("fosdem-2024-2483-citrineos") is a name too; in a listing of files, the size and date beside the link are not.
  assert.equal(usableName('fosdem-2024-2483-citrineos'), true);
  assert.equal(usableName('9f8a3c21-d07b-44aa'), false);
  assert.deepEqual(linkName({ url: 'https://video.fosdem.org/2024/h2214/fosdem-2024-2483-citrineos.av1.webm', label: 'fosdem-2024-2483-citrineos.av1.webm', row: '80.7 MiB 2024-Feb-06 18:17' }, { several: true }), { title: 'fosdem-2024-2483-citrineos', source: 'link' });
  assert.deepEqual(linkName({ url: 'https://x.example/dl/9f8a3c21d07b44aa9f8a3c21d07b44aa.mp4', label: 'Download', row: '80.7 MiB 2024-Feb-06 18:17' }, { several: true }), { title: '', source: '' }, 'a size and a date name nothing, whatever else is missing');
  assert.equal(whenOnly('80.7 MiB 2024-Feb-06 18:17') && whenOnly('322.2 MB'), true);
  assert.equal(recordingKey('not an address'), '');
});

// ---------------------------------------------------------------- B3 remainder: a file's own name
test('B3: a transcode\'s suffixes are not part of a file\'s name; a name that is nothing else keeps them', () => {
  assert.equal(fileTitle('https://upload.wikimedia.org/wikipedia/commons/transcoded/f/f1/Sintel_movie_4K.webm/Sintel_movie_4K.webm.240p.vp9.webm'), 'Sintel movie 4K');
  assert.equal(fileStem('Sintel_movie_4K.webm.1080p.vp9.webm'), 'Sintel_movie_4K');
  assert.equal(fileStem('big_buck_bunny_480p_h264.mov'), 'big_buck_bunny');
  assert.equal(fileStem('talk.av1.webm'), 'talk');
  assert.equal(fileStem('book_01_64kb.mp3'), 'book_01');
  assert.equal(fileStem('lecture_hd.mp4'), 'lecture');
  assert.equal(fileStem('720p.mp4'), '720p', 'never cut down to nothing');
  assert.equal(fileStem('Week 3 - Valve disease.mp4'), 'Week 3 - Valve disease');
  assert.equal(fileStem('Top 100 songs.mp3'), 'Top 100 songs', 'a number in a name is not a bitrate');
  assert.equal(fileStem('notes.pdf'), 'notes.pdf', 'only a media type is taken off');
  assert.equal(fileTitle('https://x.example/media/Why%20SD%20cards%20fail.mp4'), 'Why SD cards fail', '"SD" inside a name stays');
});

// ---------------------------------------------------------------- E6: a stream's quality playlists
test('E6 (YuJa): a quality\'s playlist the player asks for with its own word after the "?" is the listed stream\'s, not another video', () => {
  // As the real master playlist is: three qualities by absolute address, no picture sizes.
  const base = 'https://d2pqza7rl9apc8.cloudfront.net/Video-7bad_processed.mp4_hls';
  const master = parseM3U8(['#EXTM3U', '#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=600000', `${base}/360p/Video-7bad_processed.mp4_hls.m3u8`,
    '#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2400000', `${base}/720p/Video-7bad_processed.mp4_hls.m3u8`, '#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=5400000', `${base}/1080p/Video-7bad_processed.mp4_hls.m3u8`].join('\n'),
  'https://d2pqza7rl9apc8.cloudfront.net/P/Data/VideoUrl/Video7bad-index.m3u8?dist=coursecast&key=x');
  const parts = addParts(emptyParts(), hlsParts(master, 'https://d2pqza7rl9apc8.cloudfront.net/P/Data/VideoUrl/Video7bad-index.m3u8?dist=coursecast&key=x'));
  // What the player really asked for, and what was listed as two more videos:
  assert.equal(isPart(parts, dedupeKey(`${base}/720p/Video-7bad_processed.mp4_hls.m3u8?ClassPID=0`)), true);
  assert.equal(isPart(parts, dedupeKey(`${base}/1080p/Video-7bad_processed.mp4_hls.m3u8?ClassPID=0`)), true);
  assert.equal(isPart(parts, dedupeKey(`${base}/720p/Video-7bad_processed.mp4_hls.m3u8`)), true, 'and as the master wrote it');
  // The other way round: the master writes a word after the "?", the player asks without it (or with another).
  const signed = addParts(emptyParts(), hlsParts(parseM3U8('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://cdn.example/v/720/index.m3u8?session=abc', 'https://cdn.example/v/master.m3u8'), 'https://cdn.example/v/master.m3u8'));
  assert.equal(isPart(signed, 'https://cdn.example/v/720/index.m3u8?session=xyz'), true);
  assert.equal(isPart(signed, 'https://cdn.example/v/720/index.m3u8'), true);
  // Another video's playlist is not one of its parts; nor is a file that is no playlist, whatever follows its "?".
  assert.equal(isPart(parts, dedupeKey('https://d2pqza7rl9apc8.cloudfront.net/Video-other_processed.mp4_hls/720p/Video-other_processed.mp4_hls.m3u8?ClassPID=0')), false);
  assert.equal(isPart(signed, 'https://cdn.example/v/480/index.m3u8?session=abc'), false);
  const files = { keys: new Set(['https://cdn.example/v/clip.mp4']), patterns: [] };
  assert.equal(isPart(files, 'https://cdn.example/v/clip.mp4?v=2'), false, 'only a playlist is known by its path alone');
});

// ---------------------------------------------------------------- E8: one video and its smaller copies
test('E8 (JW Player trailer page): the stream is in front and ticked; its two small copies stay behind, marked; a lone "trailer" is not called an ad', () => {
  // As the real page is: a 1080p stream of 33 seconds and two MP4 files of the same name with no length known.
  const page = [
    { id: 'dash', name: 'Big Buck Bunny Trailer', kind: 'dash', mediaType: 'stream', duration: 33, height: 1080, url: 'https://cdn.jwplayer.com/manifests/bkaovAYt.mpd', order: 0, status: 'new' },
    { id: 'big', name: 'Big Buck Bunny Trailer', kind: 'direct', mediaType: 'video', ext: 'mp4', size: 2.2e6, url: 'https://cdn.jwplayer.com/videos/bkaovAYt-bPwArWA4.mp4', order: 1, status: 'new' },
    { id: 'small', name: 'Big Buck Bunny Trailer', kind: 'direct', mediaType: 'video', ext: 'mp4', size: 1.9e6, url: 'https://cdn.jwplayer.com/videos/bkaovAYt-640.mp4', order: 2, status: 'new' },
  ];
  const flags = flagItems(page);
  assert.deepEqual([...flags], [['big', 'copy'], ['small', 'copy']], 'the stream itself is not marked: there is nothing to compare it with');
  // The big card: the stream, though the 1.9 MB copy was found last (and was in front before).
  const found = [{ id: 'dash', kind: 'dash', detectedAt: 1 }, { id: 'big', kind: 'direct', detectedAt: 2 }, { id: 'small', kind: 'direct', detectedAt: 3 }];
  assert.deepEqual(heroChoice(found, { flags }), { id: 'dash', why: '' });
  assert.deepEqual(heroChoice(found, { flags, playing: { id: 'small', playing: true } }), { id: 'dash', why: '' }, 'even while a copy is what plays');
  assert.deepEqual(heroChoice(found, { flags: new Map() }), { id: 'small', why: '' }, '(without the marks the newest would be in front, as it was)');
  // The sheet: the stream ticked, the copies under "Check these".
  const groups = reviewGroups(page, { flags });
  assert.deepEqual(groups.ready, [{ id: 'dash' }]);
  assert.deepEqual(groups.check, [{ id: 'big', reason: 'copy' }, { id: 'small', reason: 'copy' }]);
  // A trailer beside a real lecture is still passed over and left unticked.
  const mixed = [{ id: 'lec', name: 'Lecture 1: Models', kind: 'hls', mediaType: 'stream', duration: 3000, url: 'https://x.example/lec.m3u8', status: 'new' }, { ...page[0], id: 'ad' }];
  assert.deepEqual([...flagItems(mixed)], [['ad', 'promo']]);
  // A page of nothing but copies of one another still has one of them in front.
  assert.deepEqual(heroChoice([{ id: 'x', kind: 'direct', detectedAt: 1 }], { flags: new Map([['x', 'copy']]) }), { id: 'x', why: '' });
});

// ---------------------------------------------------------------- E9: two players, one section
test('E9 (Canvas): two embedded players of one name are two videos, not one "the same as another"; two files of one name still are', () => {
  const yt = (id, name) => ({ id, name, kind: 'embed', mediaType: 'video', url: `https://www.youtube.com/embed/${id}`, order: 0 });
  assert.deepEqual([...flagItems([yt('MNP0Ikwac6Y', 'Finding OER Videos'), yt('srVPLrmlBJY', 'Licensing'), yt('qtd6QY5CbFM', 'Licensing')])], [['qtd6QY5CbFM', 'samename']]);
  assert.equal(flagItems([yt('MNP0Ikwac6Y', 'Finding OER Videos'), yt('srVPLrmlBJY', 'Standard YouTube License'), yt('qtd6QY5CbFM', 'Proper Attributions')]).size, 0, 'each under its own heading: nothing to mark');
  const file = (id, ext) => ({ id, name: 'Lecture 1', kind: 'direct', mediaType: 'video', ext, url: `https://x.example/${id}.${ext}` });
  assert.deepEqual([...flagItems([file('a', 'mp4'), file('b', 'ogv'), { ...file('c', 'mp4'), name: 'Lecture 2' }])], [['b', 'copy']]);
});

// ---------------------------------------------------------------- E11: a bitrate is not a height
test('E11: a picture height is read only where one is written; "_300k" and "64kb" are bitrates', () => {
  assert.equal(heightOf({ url: 'https://archive.org/download/MIT6.041F10/MIT6_041F11_lec01_300k.mp4' }), 0);
  assert.equal(heightOf({ url: 'https://archive.org/download/MIT6.041F10/MIT6_041F11_lec01_300k.ogv' }), 0);
  assert.equal(heightOf({ url: 'https://x.example/book_01_64kb.mp3' }), 0);
  assert.equal(heightOf({ url: 'https://x.example/talk_512kb.mp4', quality: '512kb' }), 0);
  // archive.org's own playlist says its OGV is 300 high (400 × 300): that is the page's word, and it is kept.
  assert.equal(heightOf({ url: 'https://archive.org/download/MIT6.041F10/MIT6_041F11_lec01_300k.ogv', height: 300 }), 300);
  assert.equal(heightOf({ url: 'https://x.example/Sintel.webm.480p.vp9.webm' }), 480);
  assert.equal(heightOf({ url: 'https://download.blender.org/peach/BigBuckBunny_320x180.mp4' }), 180);
  assert.equal(heightOf({ url: 'https://x.example/a.mp4', quality: 'Low quality WebM (240P)' }), 240);
});

test('E11 (FOSDEM talk): one file whose height is known only because it is playing is not ranked above its twin that never said one', () => {
  const pair = () => [
    { id: 'webm', kind: 'direct', ext: 'webm', set: 'el:x', height: 720, size: 287e6, detectedAt: 1, url: 'https://video.fosdem.org/2023/UD2.218A/python_micropython_intro.webm' },
    { id: 'mp4', kind: 'direct', ext: 'mp4', set: 'el:x', size: 428e6, detectedAt: 2, url: 'https://video.fosdem.org/2023/UD2.218A/python_micropython_intro.mp4' },
  ];
  const media = pair();
  groupVariants(media);
  const first = media.find((m) => m.variants);
  assert.equal(first.id, 'mp4');
  const options = variantOptions(first);
  assert.deepEqual(options.map((o) => o.label), ['MP4 · 408 MB', 'WEBM · 274 MB'], 'told apart by type, the bigger MP4 first: nothing is called "smaller" than a file it is bigger than');
  assert.deepEqual(rankVideoOptions(options).map((o) => o.id), ['file', 'alt:webm'], 'and the popup\'s own ranking keeps that order');
  // Two files that both say a height are still ranked by it, the taller first, whatever their type.
  const both = pair();
  both[1].height = 360;
  groupVariants(both);
  assert.deepEqual(variantOptions(both.find((m) => m.variants)).map((o) => o.label), ['720p · WEBM · 274 MB', '360p · MP4 · 408 MB']);
  // Of two files alike in height and type the bigger is first (an audiobook's 128 kb file before its 64 kb one).
  const book = [{ id: 'small', kind: 'direct', ext: 'mp3', set: 'twin:x', size: 4e6, detectedAt: 1, url: 'https://x.example/ch1_64kb.mp3' }, { id: 'full', kind: 'direct', ext: 'mp3', set: 'twin:x', size: 8e6, detectedAt: 2, url: 'https://x.example/ch1.mp3' }];
  groupVariants(book);
  assert.equal(book.find((m) => m.variants).id, 'full');
  // …but only where every size is known: a file nobody has asked about (a playlist's entry) is not "smaller" than one that was (a link).
  const mixed = [{ id: 'player', kind: 'direct', ext: 'mp3', set: 'list:x', detectedAt: 1, url: 'https://x.example/ch1_64kb.mp3' }, { id: 'linked', kind: 'direct', ext: 'mp3', set: 'list:x', size: 8e6, detectedAt: 2, url: 'https://x.example/ch1.mp3' }];
  groupVariants(mixed);
  assert.equal(mixed.find((m) => m.variants).id, 'player', 'the one found first stays the first choice');
});

// ---------------------------------------------------------------- E17: a link that is never asked is not "being looked at"
test('E17: links that will never be asked do not count as waiting; the others do until their frame is done', () => {
  const sets = noteLinks({}, 0, [{ url: 'http://192.168.1.10/nas/film.mp4', label: 'Film' }, { url: 'https://x.example/a.mp4', label: 'A' }, { url: 'https://x.example/b.mp4', label: 'B' }]);
  const local = (it) => it.url.startsWith('http://192.168.');
  assert.equal(linksWaiting(sets), 3);
  assert.equal(linksWaiting(sets, local), 2);
  assert.equal(linksWaiting(noteLinks({}, 0, [{ url: 'http://192.168.1.10/nas/film.mp4', label: 'Film' }]), local), 0, 'a page whose only link is never asked is not "looking" at all');
  sets[0].done = true;
  assert.equal(linksWaiting(sets, local), 0);
});

// ---------------------------------------------------------------- B14 remainder: identical choices
test('B14: choices that read the same are listed once (the one most players open is kept); different ones all stay', () => {
  // Apple's sample stream lists each picture size once per sound format: the same row three times over.
  const options = [
    { id: 'v0', label: '1080p · 8.2 Mbps · 60fps', height: 1080, bandwidth: 8.2e6, codecs: 'hvc1.2.4.L123.B0,ec-3' },
    { id: 'v1', label: '1080p · 8.2 Mbps · 60fps', height: 1080, bandwidth: 8.2e6, codecs: 'avc1.64002a,ac-3' },
    { id: 'v2', label: '1080p · 8.2 Mbps · 60fps', height: 1080, bandwidth: 8.2e6, codecs: 'avc1.64002a,mp4a.40.2' },
    { id: 'v3', label: '1080p · 6.2 Mbps · 60fps', height: 1080, bandwidth: 6.2e6, codecs: 'avc1.64002a,mp4a.40.2' },
    { id: 'v4', label: '720p · 3.0 Mbps', height: 720, bandwidth: 3e6, codecs: '' },
    { id: 'v5', label: '720p · 3.0 Mbps', height: 720, bandwidth: 3e6, codecs: '' },
    { id: 'a0', label: 'Audio only · English', audio: true },
    { id: 'a1', label: 'Audio only · English', audio: true },
    { id: 's0', label: 'Subtitles · English', subtitle: true },
  ];
  const once = uniqueChoices(options);
  assert.deepEqual(once.map((o) => o.id), ['v2', 'v3', 'v4', 'a0', 's0']);
  assert.equal(new Set(once.map((o) => `${o.audio ? 'a' : o.subtitle ? 's' : 'v'}|${o.label}`)).size, once.length, 'no two rows read the same');
  assert.ok(once.every((o) => !('codecs' in o)), 'what was only used to choose is not passed on');
  assert.deepEqual(once[0], { id: 'v2', label: '1080p · 8.2 Mbps · 60fps', height: 1080, bandwidth: 8.2e6 });
  // A video row and a sound row that happened to read alike are two choices; nothing listed once is touched.
  assert.equal(uniqueChoices([{ id: 'v0', label: 'Auto' }, { id: 'a0', label: 'Auto', audio: true }]).length, 2);
  assert.deepEqual(uniqueChoices([{ id: 'v0', label: 'A' }, { id: 'v1', label: 'B' }]).map((o) => o.id), ['v0', 'v1']);
  assert.deepEqual(uniqueChoices(null), []);
});

// ---------------------------------------------------------------- from the earlier notes: one lecture's quality files
test('a lecture\'s quality files are one recording (cs50\'s week page: eight files; videos.cern.ch: four named by their quality alone)', () => {
  const keyOf = (urls) => { const t = formatTwins(urls.map((url) => ({ url, mediaType: 'video', title: '' }))); return urls.map((u) => t.get(u) || ''); };
  // cs50.harvard.edu/x/2024/weeks/0/ links these (and "lecture0.mp3", which is sound and stays apart).
  const cs50 = ['360p', '360p-hdr', '720p', '720p-hdr', '1080p', '1080p-hdr', '4k', '4k-hdr'].map((q) => `https://cdn.cs50.net/2023/fall/lectures/0/lecture0-${q}.mp4`);
  const one = keyOf(cs50);
  assert.ok(one[0] && one.every((k) => k === one[0]), JSON.stringify(one));
  assert.equal(formatTwins([...cs50.map((url) => ({ url, mediaType: 'video', title: '' })), { url: 'https://cdn.cs50.net/2023/fall/lectures/0/lecture0.mp3', mediaType: 'audio', title: '' }]).has('https://cdn.cs50.net/2023/fall/lectures/0/lecture0.mp3'), false);
  assert.notEqual(recordingKey(cs50[0]), recordingKey('https://cdn.cs50.net/2023/fall/lectures/1/lecture1-360p.mp4'), 'another week\'s lecture is another recording');
  // Folded, the tallest is first: "4k" is 2160 high.
  assert.deepEqual(cs50.map((url) => heightOf({ url })), [360, 360, 720, 720, 1080, 1080, 2160, 2160]);
  const media = cs50.map((url, i) => ({ id: `q${i}`, kind: 'direct', ext: 'mp4', url, set: one[0], size: 1e8 * (i + 1), detectedAt: i }));
  groupVariants(media);
  assert.deepEqual(media.filter((m) => !m.variantOf).map((m) => m.id), ['q7'], 'one row');
  assert.deepEqual(media[7].variants.map((v) => v.height), [2160, 2160, 1080, 1080, 720, 720, 360, 360]);
  // Its name: the files' own, without the quality; "4k" stays where it may be part of a name.
  assert.equal(fileTitle(cs50[2]), 'lecture0');
  assert.equal(fileTitle(cs50[7]), 'lecture0-4k', '(the worker gives the row the plainest of its files\' names: "lecture0")');
  assert.equal(fileTitle('https://upload.wikimedia.org/wikipedia/commons/f/f1/Sintel_movie_4K.webm'), 'Sintel movie 4K');
  // videos.cern.ch: "360p.mp4" … "1080p.mp4" in one folder are that folder's one recording; the original beside them has a name of its own.
  const dir = 'https://videos.cern.ch/api/files/da8d1090-bc0e-4c7c-b976-00d416c3487c/';
  const cern = keyOf(['360p.mp4', '480p.mp4', '720p.mp4', '1080p.mp4', 'OPEN-VIDEO-2023-382-002.mp4'].map((x) => dir + x));
  assert.ok(cern[0] && cern.slice(0, 4).every((k) => k === cern[0]) && cern[4] === '', JSON.stringify(cern));
  assert.equal(fileTitle(`${dir}720p.mp4`), '', 'a quality is not a name: the page names the recording');
  assert.equal(linkTitle('720p.mp4'), '');
  assert.equal(fileTitle(`${dir}OPEN-VIDEO-2023-382-002.mp4`), 'OPEN-VIDEO-2023-382-002');
  // Not one recording: quality-named files of different folders, or of no folder at all.
  assert.deepEqual(keyOf(['https://x.example/a/720p.mp4', 'https://x.example/b/1080p.mp4']), ['', '']);
  assert.equal(recordingKey('https://x.example/720p.mp4'), '');
});

test('E6 (YuJa): a master playlist that states no picture sizes but keeps each quality in a folder named after its height says those heights, not "Auto" three times', () => {
  const base = 'https://d2pqza7rl9apc8.cloudfront.net/Video-7bad_processed.mp4_hls';
  const master = (uris, extra = '') => parseM3U8(['#EXTM3U', ...uris.flatMap((u, i) => [`#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=${600000 * (i + 1)}${extra}`, u])].join('\n'), 'https://d2pqza7rl9apc8.cloudfront.net/P/Data/index.m3u8');
  const yuja = master([360, 720, 1080].map((h) => `${base}/${h}p/Video-7bad_processed.mp4_hls.m3u8`));
  assert.deepEqual(yuja.variants.map((v) => v.height), [1080, 720, 360], 'tallest first, as the list of choices is ordered');
  assert.deepEqual(master(['v_360p.m3u8', 'v_720p.m3u8']).variants.map((v) => v.height), [720, 360], 'in the file\'s name as well');
  // Not when they all sit in one folder of that kind, when one of them has no such name, or when the master states sizes itself.
  assert.deepEqual(master(['https://cdn.example/1080p/low.m3u8', 'https://cdn.example/1080p/high.m3u8']).variants.map((v) => v.height), [0, 0]);
  assert.deepEqual(master(['https://cdn.example/720p/v.m3u8', 'https://cdn.example/best/v.m3u8']).variants.map((v) => v.height), [0, 0]);
  assert.deepEqual(master(['https://cdn.example/a/top10p/v.m3u8', 'https://cdn.example/a/99999p/v.m3u8']).variants.map((v) => v.height), [0, 0], 'only a number that could be a height');
  assert.deepEqual(master(['https://cdn.example/720p/v.m3u8', 'https://cdn.example/1080p/v.m3u8'], ',RESOLUTION=640x360').variants.map((v) => v.height), [360, 360]);
});

// ---------------------------------------------------------------- E13: what is not asked any more must still be known as one video
test('E13 (archive.org): the file a page\'s markup names and the one its player loaded from another address of the site are one video, without the named one being asked', () => {
  const named = { kind: 'direct', source: 'page', unasked: true, url: 'https://archive.org/download/OBF-showcase-01-mcgann/01_Introduction_McGann.ia.mp4' };
  const played = { kind: 'direct', source: 'network', size: 135e6, url: 'https://dn600208.us.archive.org/0/items/OBF-showcase-01-mcgann/01_Introduction_McGann.ia.mp4?cnt=0' };
  assert.equal(sameNamedFile(named, played), true);
  assert.equal(sameNamedFile(played, named), true);
  // Once it has been asked (StreamSnag was opened), the two are told apart by their size as any two loaded files are.
  assert.equal(sameNamedFile({ ...named, unasked: undefined }, played), false);
  // Not: another file's name, another site, a name that says nothing, two files that are both only named.
  assert.equal(sameNamedFile({ ...named, url: 'https://archive.org/download/OBF-showcase-01-mcgann/02_Second_Talk.ia.mp4' }, played), false);
  assert.equal(sameNamedFile({ ...named, url: 'https://elsewhere.example/download/01_Introduction_McGann.ia.mp4' }, played), false);
  assert.equal(sameNamedFile({ ...named, url: 'https://archive.org/download/a/video.mp4' }, { ...played, url: 'https://dn600208.us.archive.org/0/items/a/video.mp4' }), false);
  assert.equal(sameNamedFile(named, { ...named, url: 'https://ia800.us.archive.org/1/items/OBF-showcase-01-mcgann/01_Introduction_McGann.ia.mp4' }), false);
});

// ---------------------------------------------------------------- E13, follow-up: a player that waits to be looked up
test('E13: an embedded player still waiting to be looked up is listed, but is not a file "Download all" may start; once looked up (or once the lookup has failed) it is like any other', () => {
  const player = { id: 'p', kind: 'embed', mediaType: 'video', provider: 'vimeo', url: 'https://player.vimeo.com/video/990000201' };
  assert.equal(canBulkDownload({ ...player, pending: 'vimeo:990000201' }), false);
  assert.equal(canBulkDownload(player), true, 'the lookup failed: the player is offered to the other downloader, as before');
  assert.equal(canBulkDownload({ ...player, kind: 'hls', mediaType: 'stream' }), true, 'it has become its video');
  // In front of nothing else it is still what the page has: the big card is the player.
  assert.deepEqual(heroChoice([{ ...player, pending: 'vimeo:990000201', detectedAt: 1 }], {}), { id: 'p', why: '' });
});
