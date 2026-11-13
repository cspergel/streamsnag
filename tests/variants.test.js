// B4, B5, B6, B10, B16 (real-site test): one video offered in several files is one video with choices;
// a playlist written into the page lists every lecture; caption files belong to the video they were
// declared for; and the subtitles and caption file picked first are the ones the user can read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupVariants, variantOptions, variantChoice, pagePlaylists } from '../extension/lib/variants.js';
import { soleVideo, captionFiles, orderSubtitles, langOfFile } from '../extension/lib/captions.js';
import { pickPreferred } from '../extension/lib/quality.js';

let n = 0;
const file = (url, extra = {}) => ({ id: `m${++n}`, kind: 'direct', mediaType: 'video', url, key: url, ext: url.split('.').pop(), detectedAt: n, ...extra });
const sub = (url, extra = {}) => ({ id: `s${++n}`, kind: 'subtitle', mediaType: 'subtitle', url, key: url, ext: url.split(/[.?]/).pop(), detectedAt: n, ...extra });
const shown = (media) => media.filter((m) => !m.hidden && !m.variantOf);

test('archive.org (B5): the same lecture as OGV and MP4 is one video, and MP4 is what it starts with', () => {
  const ogv = file('https://archive.org/download/MIT6.041F10/lec01_300k.ogv', { set: 'g1', size: 216e6 });
  const mp4 = file('https://archive.org/download/MIT6.041F10/lec01_300k.mp4', { set: 'g1', size: 113e6 });
  const media = [ogv, mp4];
  groupVariants(media);
  assert.deepEqual(shown(media).map((m) => m.id), [mp4.id], 'one card, and it is the MP4');
  assert.equal(ogv.variantOf, mp4.id);
  const options = variantOptions(mp4);
  assert.deepEqual(options.map((o) => [o.id, o.label]), [['file', 'MP4 · 108 MB'], [`alt:${ogv.id}`, 'OGV · 206 MB']]);
  assert.equal(pickPreferred(options, 'best').id, 'file');
  assert.equal(pickPreferred(options, '720').id, 'file');
  // Choosing the other file downloads that file, under the same video's keys (so it shows as downloaded afterwards).
  const chosen = variantChoice(media, mp4, `alt:${ogv.id}`);
  assert.equal(chosen.url, ogv.url);
  assert.equal(chosen.ext, 'ogv');
  assert.equal(chosen.size, 216e6);
  assert.equal(chosen.id, mp4.id);
  assert.ok([chosen.key, ...chosen.aliases].includes(mp4.key) && [chosen.key, ...chosen.aliases].includes(ogv.key));
  assert.equal(variantChoice(media, mp4, 'file'), mp4);
});

test('Wikimedia Commons (B5): four transcodes are four qualities of one video, best first; a setting picks among them', () => {
  const dir = 'https://upload.wikimedia.org/wikipedia/commons/transcoded/f/f1/Sintel_movie_4K.webm/Sintel_movie_4K.webm';
  const media = [
    file(`${dir}.480p.vp9.webm`, { set: 'el', size: 67e6 }), file(`${dir}.1080p.vp9.webm`, { set: 'el', size: 241e6, height: 1080 }),
    file(`${dir}.240p.vp9.webm`, { set: 'el', hint: 'Low quality WebM (240P)' }), file(`${dir}.720p.vp9.webm`, { set: 'el' }),
    file('https://upload.wikimedia.org/other/Unrelated_clip.webm'),
  ];
  groupVariants(media);
  assert.equal(shown(media).length, 2, 'the film and the unrelated clip');
  const film = shown(media).find((m) => m.variants);
  assert.match(film.url, /1080p/);
  const options = variantOptions(film);
  assert.deepEqual(options.map((o) => o.height), [1080, 720, 480, 240]);
  assert.equal(options[0].label, '1080p · WEBM · 230 MB');
  assert.equal(pickPreferred(options, '480').height, 480);
  assert.equal(pickPreferred(options, 'smallest').height, 240);
  assert.equal(media.at(-1).variants, undefined, 'a video on its own has no choices');
});

test('grouping follows the page: it is undone when the group goes, never mixes streams or caption files in, and skips removed items', () => {
  const a = file('https://x.example/a.webm', { set: 'g' });
  const b = file('https://x.example/a.mp4', { set: 'g' });
  const stream = { id: 'h1', kind: 'hls', url: 'https://x.example/a.m3u8', set: 'g' };
  const cc = sub('https://x.example/a.vtt', { set: 'g' });
  const media = [a, b, stream, cc];
  groupVariants(media);
  assert.deepEqual(shown(media).map((m) => m.id), [b.id, 'h1', cc.id]);
  b.dismissed = true; // "Remove from list" on the card: the other file is not put in its place as a new video… it is one again
  groupVariants(media);
  assert.equal(a.variantOf, undefined);
  delete b.dismissed;
  delete a.set;
  groupVariants(media);
  assert.ok(!a.variantOf && !b.variants, 'no longer one video');
});

test('B5/B4: the caption file of a page belongs to its one video, however many files that video comes in', () => {
  const media = [
    file('https://c.example/film.1080p.webm', { set: 'el' }), file('https://c.example/film.480p.webm', { set: 'el' }),
    sub('https://c.example/api?lang=en&trackformat=vtt', { lang: 'en' }),
  ];
  groupVariants(media);
  const film = shown(media).find((m) => m.kind === 'direct');
  assert.ok(soleVideo(shown(media), film.id), 'two files, one video');
  assert.deepEqual(captionFiles(media, film).map((s) => s.lang), ['en']);
  // MIT OpenCourseWare: the player (a YouTube embed) and the page's "Download video" link are the same lecture.
  const embed = { id: 'e1', kind: 'embed', url: 'https://www.youtube.com/embed/j9WZyLZCBzs' };
  const linked = file('http://www.archive.org/download/MIT6.041F10/MIT6_041F11_lec01_300k.mp4', { linked: true });
  const track = sub('https://ocw.mit.edu/courses/x/j9WZyLZCBzs_captions.webvtt', { lang: 'en' });
  const ocw = [embed, linked, track];
  assert.ok(soleVideo(ocw, embed.id) && soleVideo(ocw, linked.id));
  assert.equal(captionFiles(ocw, embed)[0], track);
  assert.equal(captionFiles(ocw, linked)[0], track);
  // Two players, or a page of download links: nobody can say whose captions they are.
  const two = [embed, { id: 'e2', kind: 'embed', url: 'https://www.youtube.com/embed/other000000' }, track];
  assert.ok(!soleVideo(two, embed.id));
  assert.deepEqual(captionFiles(two, embed), []);
  const listing = [linked, file('https://x.example/lec02.mp4', { linked: true }), track];
  assert.ok(!soleVideo(listing, linked.id));
});

test('B16: of the caption files beside a video, the user\'s language first, and a .vtt before the .srt made from it', () => {
  const v = file('https://archive.org/download/OBF/01_Introduction_McGann.ia.mp4');
  const srt = sub('https://archive.org/download/OBF/01_Introduction_McGann-en-GB%20(1).asr.srt');
  const vtt = sub('https://archive.org/download/OBF/01_Introduction_McGann-en-GB%20(1).vtt');
  assert.deepEqual(captionFiles([v, srt, vtt], v).map((s) => s.ext), ['vtt', 'srt']);
  const en = sub('https://archive.org/download/a11ynyc0725/a11ynyc0725.EN.srt');
  const ja = sub('https://archive.org/download/a11ynyc0725/a11ynyc0725.JA.srt');
  assert.deepEqual(captionFiles([v, ja, en], v).map((s) => langOfFile(s.url)), ['en', 'ja']);
  assert.deepEqual(captionFiles([v, ja, en], v, { langs: ['ja-JP', 'en'] }).map((s) => langOfFile(s.url)), ['ja', 'en']);
  assert.equal(langOfFile('https://commons.wikimedia.org/w/api.php?action=timedtext&lang=pt-br&trackformat=vtt'), 'pt-br');
  assert.equal(langOfFile('https://x.example/captions/lesson.vtt'), '');
  assert.equal(langOfFile('https://x.example/video.mp4.srt'), '', '"mp4" is not a language');
});

test('B10: a playlist written into the page (archive.org) gives every lecture its name, its files and its captions', () => {
  const lec = (i, title) => ({
    title, orig: `lec0${i}.mp4`, image: `/download/C/thumb${i}.jpg`, duration: i === 1 ? '3070.64' : 3071,
    sources: [{ file: `/download/C/lec0${i}_300k.mp4`, type: 'mp4', height: '360', width: '480', label: '360p' }, { file: `/download/C/lec0${i}_300k.ogv`, type: 'ogg', height: '300', width: '400', label: '300p' }],
    tracks: [{ kind: 'thumbnails', file: `/stream/C/thumbs${i}.jpg?vtt=vtt.vtt` }, { file: `/download/C/lec0${i}_300k.srt`, label: '300k', kind: 'subtitles' }],
  });
  const json = JSON.stringify([lec(1, 'Lecture 1: Probability Models and Axioms'), lec(2, 'Lecture 2: Conditioning and Bayes\' Rule'), lec(3, 'Lecture 3: Independence')]);
  const lists = pagePlaylists([json], 'https://archive.org/details/C');
  assert.equal(lists.length, 3);
  assert.deepEqual(lists.map((e) => e.title), ['Lecture 1: Probability Models and Axioms', 'Lecture 2: Conditioning and Bayes\' Rule', 'Lecture 3: Independence']);
  assert.deepEqual(lists[0].sources, [
    { url: 'https://archive.org/download/C/lec01_300k.mp4', height: 360, label: '360p', type: 'mp4' },
    { url: 'https://archive.org/download/C/lec01_300k.ogv', height: 300, label: '300p', type: 'ogg' },
  ]);
  assert.deepEqual(lists[0].tracks, [{ url: 'https://archive.org/download/C/lec01_300k.srt', label: '300k', lang: '' }], 'thumbnail tracks are not captions');
  assert.equal(lists[0].duration, 3070.64);
  assert.equal(lists[0].poster, 'https://archive.org/download/C/thumb1.jpg');
  // Other shapes of the same thing, and what is not a playlist at all.
  const jw = JSON.stringify({ playlist: [{ title: 'One', file: 'https://cdn.example/1.m3u8' }, { name: 'Two', sources: [{ src: 'https://cdn.example/2.mp4', type: 'video/mp4' }] }] });
  assert.deepEqual(pagePlaylists([jw], 'https://x.example/').map((e) => [e.title, e.sources[0].url]), [['One', 'https://cdn.example/1.m3u8'], ['Two', 'https://cdn.example/2.mp4']]);
  for (const not of ['', 'not json', '[1,2,3]', '{"a":1}', JSON.stringify([{ title: 'Only one', file: '/a.mp4' }]), JSON.stringify([{ title: 'A', file: '/a.jpg' }, { title: 'B', file: '/b.jpg' }]),
    JSON.stringify([{ title: 'A', file: 'javascript:alert(1)' }, { title: 'B', file: 'data:video/mp4;base64,AAAA' }])]) {
    assert.deepEqual(pagePlaylists([not], 'https://x.example/'), [], not.slice(0, 40));
  }
  assert.ok(pagePlaylists([JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ title: `L${i}`, file: `/v/${i}.mp4` })))], 'https://x.example/').length <= 120, 'a page cannot list without end');
});

test('B6: subtitles saved inside a video: the user\'s language first, then the page\'s, then English, then the rest in the stream\'s order', () => {
  // The TED talk: more than sixty languages, in an order of the stream's own.
  const ted = ['pt-br', 'mfe', 'el', 'eo', 'ja', 'fr', 'en', 'de'].map((language) => ({ language, name: language, url: `https://hls.ted.com/subs/${language}.m3u8` }));
  const langs = (list) => list.map((s) => s.language);
  assert.deepEqual(langs(orderSubtitles(ted, { langs: ['en-US', 'en'] }).slice(0, 4)), ['en', 'pt-br', 'mfe', 'el']);
  // (The page's language now comes before English: one order for what is saved in a video and what a transcript is made from.)
  assert.deepEqual(langs(orderSubtitles(ted, { langs: ['ja'], pageLang: 'fr-FR' }).slice(0, 4)), ['ja', 'fr', 'en', 'pt-br']);
  assert.deepEqual(langs(orderSubtitles(ted, { langs: ['de-AT'], pageLang: 'ja' }).slice(0, 4)), ['de', 'ja', 'en', 'pt-br']);
  assert.deepEqual(langs(orderSubtitles(ted, {})), ['en', 'pt-br', 'mfe', 'el', 'eo', 'ja', 'fr', 'de'], 'nothing known: English, then as listed');
  // DASH tracks say `lang`; a track that only has a name is matched by it.
  assert.deepEqual(orderSubtitles([{ lang: 'es' }, { lang: 'eng' }], { langs: ['en'] }).map((s) => s.lang), ['eng', 'es']);
  assert.deepEqual(orderSubtitles([{ name: 'Deutsch' }, { name: 'English' }], { langs: ['en'] }).map((s) => s.name), ['English', 'Deutsch']);
});
