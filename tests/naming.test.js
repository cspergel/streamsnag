// B3 (real-site test): what a video is called. The content script reports what the page offers (the
// player's label, a highlighted lesson, the heading by the player, the page's video data, its title); this
// picks the one a person would use. The cases are the pages of the real-site report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseName, cleanPageTitle, fileTitle, addressLike, weakName, linkTitle } from '../extension/lib/naming.js';

const name = (signals) => { const r = chooseName(signals); return r ? [r.name, r.source] : null; };

test('a generic word, a call to action or an address is never the name when the page has something better', () => {
  // dash.js reference player: the highlighted "Video" tab; Shaka demo: the slogan above its form.
  assert.deepEqual(name({ list: 'Video', title: 'DASH-IF Reference Client', host: 'reference.dashif.org' }), ['DASH-IF Reference Client', 'title']);
  assert.deepEqual(name({ heading: 'Try Shaka Player with your own content!', title: 'Shaka Player Demo', host: 'shaka-player-demo.appspot.com' }), ['Shaka Player Demo', 'title']);
  // Wikimedia Commons: the page's video data names the film; the title has the site in it.
  assert.deepEqual(name({ structured: 'Sintel movie 4K', title: 'File:Sintel movie 4K.webm - Wikimedia Commons', host: 'commons.wikimedia.org' }), ['Sintel movie 4K', 'structured']);
  for (const bad of ['Video', 'video player', 'Untitled', 'Beginning', 'Contents', 'Home', 'Loading…', 'Watch', 'https://example.com/a/b.mp4', 'upload.wikimedia.org/wikipedia/commons/x.webm', '12:30', '']) {
    assert.ok(weakName(bad), bad);
  }
  for (const good of ['Lecture 1: Probability Models and Axioms', 'Do schools kill creativity?', 'Course Introduction', '009: Updates in C. diff', 'Advertisement', 'Welcome']) {
    assert.ok(!weakName(good), good);
  }
  assert.ok(weakName('Try Shaka Player with your own content!', 'heading') && weakName('Sign up for our newsletter', 'heading'));
  assert.ok(!weakName('Welcome to the course!', 'player'), 'a slogan test only applies to a heading picked up near the player');
});

test('the page title without the site: the lecture\'s own part, and the course it belongs to', () => {
  const ocw = 'Lecture 1: Probability Models and Axioms Video | Probabilistic Systems Analysis and Applied Probability | Electrical Engineering and Computer Science | MIT OpenCourseWare';
  assert.deepEqual(cleanPageTitle(ocw, { host: 'ocw.mit.edu' }), { name: 'Lecture 1: Probability Models and Axioms Video', course: 'Probabilistic Systems Analysis and Applied Probability' });
  assert.deepEqual(cleanPageTitle('ASTR 160 - Lecture 1 - Introduction | Open Yale Courses', { host: 'oyc.yale.edu' }), { name: 'ASTR 160 - Lecture 1 - Introduction', course: '' });
  assert.equal(cleanPageTitle('Sir Ken Robinson: Do schools kill creativity? | TED Talk', { host: 'www.ted.com' }).name, 'Sir Ken Robinson: Do schools kill creativity?');
  assert.equal(cleanPageTitle('MIT 6.041 Probabilistic Systems Analysis and Applied Probability, Fall 2010 : Free Download, Borrow, and Streaming : Internet Archive', { host: 'archive.org' }).name,
    'MIT 6.041 Probabilistic Systems Analysis and Applied Probability, Fall 2010');
  assert.equal(cleanPageTitle('File:Sintel movie 4K.webm - Wikimedia Commons', { host: 'commons.wikimedia.org' }).name, 'File:Sintel movie 4K.webm');
  assert.equal(cleanPageTitle('Lecture 3 | Big Course | Academy', { site: 'Academy', host: 'learn.example.com' }).name, 'Lecture 3');
  assert.equal(cleanPageTitle('Lecture 3 | Big Course | Academy', { site: 'Academy', host: 'learn.example.com' }).course, 'Big Course');
  // A dash inside a name is not a site: nothing is cut when the last part is not the site's own name.
  assert.equal(cleanPageTitle('Day 2 - Keynote', { host: 'conf.example.org' }).name, 'Day 2 - Keynote');
  assert.equal(cleanPageTitle('Test Clip 42', { host: '127.0.0.1' }).name, 'Test Clip 42');
  assert.equal(cleanPageTitle('Keynote on Vimeo', { host: 'vimeo.com' }).name, 'Keynote');
});

test('the order of what a page offers: the player\'s own label, the highlighted lesson, the heading by the player, the page\'s video data, the title', () => {
  const all = { player: 'From the player', list: '003: Highlighted lesson', heading: 'Heading by the player', structured: 'Video data name', title: 'Big Course | Academy', host: 'academy.example' };
  assert.deepEqual(name(all), ['From the player', 'player']);
  assert.deepEqual(name({ ...all, player: '' }), ['003: Highlighted lesson', 'list']);
  assert.deepEqual(name({ ...all, player: '', list: '' }), ['Heading by the player', 'heading']);
  assert.deepEqual(name({ ...all, player: '', list: '', heading: '' }), ['Video data name', 'structured']);
  assert.deepEqual(name({ title: 'Big Course | Academy', host: 'academy.example' }), ['Big Course', 'title']);
  // A "lecture name" that only repeats the page's title is no better than the title: the next one wins.
  assert.deepEqual(name({ heading: 'Big Course', structured: 'Lesson 4: Valves', title: 'Big Course', host: 'x.example' }), ['Lesson 4: Valves', 'structured']);
});

test('a heading that is the file\'s own name gives way to what the page calls the video; a link names a file by its words, not by "download"', () => {
  // Wikimedia Commons: the page's heading is "File:Sintel movie 4K.webm", its video data says "Sintel movie 4K".
  assert.deepEqual(name({ heading: 'File:Sintel movie 4K.webm', structured: 'Sintel movie 4K', title: 'File:Sintel movie 4K.webm - Wikimedia Commons', host: 'commons.wikimedia.org' }), ['Sintel movie 4K', 'structured']);
  assert.deepEqual(name({ heading: 'File:Sintel movie 4K.webm', title: 'File:Sintel movie 4K.webm - Wikimedia Commons', host: 'commons.wikimedia.org' }), ['File:Sintel movie 4K.webm', 'heading']);
  assert.equal(linkTitle('Lecture 4: Counting download'), 'Lecture 4: Counting');
  assert.equal(linkTitle('Download Lecture 2: Conditioning and Bayes\' Rule (MP4)'), 'Lecture 2: Conditioning and Bayes\' Rule');
  for (const t of ['Download video', 'download the video', 'MP4', 'H.264 IA download', '2.2M', 'download 1 file', 'Video', '']) assert.equal(linkTitle(t), '', t);
});

test('MIT OpenCourseWare and Open Yale: the lecture\'s name, and its course from the rest of the title', () => {
  const r = chooseName({
    heading: 'Lecture 1: Probability Models and Axioms', h1: 'Lecture 1: Probability Models and Axioms', site: 'MIT OpenCourseWare', host: 'ocw.mit.edu', duration: 3071,
    title: 'Lecture 1: Probability Models and Axioms Video | Probabilistic Systems Analysis and Applied Probability | Electrical Engineering and Computer Science | MIT OpenCourseWare',
  });
  assert.equal(r.name, 'Lecture 1: Probability Models and Axioms');
  assert.equal(r.source, 'heading');
  assert.equal(r.course, 'Probabilistic Systems Analysis and Applied Probability');
  assert.equal(r.duration, 3071);
  assert.equal(r.heading, 'Lecture 1: Probability Models and Axioms');
  const yale = chooseName({ title: 'ASTR 160 - Lecture 1 - Introduction | Open Yale Courses', host: 'oyc.yale.edu' });
  assert.deepEqual([yale.name, yale.source], ['ASTR 160 - Lecture 1 - Introduction', 'title']);
});

test('nothing usable on the page (a file opened in a tab has only its address for a title): no name, and the file\'s own name is used', () => {
  const tab = 'upload.wikimedia.org/wikipedia/commons/transcoded/f/f1/Sintel_movie_4K.webm/Sintel_movie_4K.webm.240p.vp9.webm';
  assert.equal(chooseName({ title: tab, host: 'upload.wikimedia.org' }), null);
  assert.equal(chooseName({ title: '', host: 'x.example' }), null);
  assert.ok(addressLike(tab) && addressLike('https://a.example/b') && addressLike('www.example.com/watch') && !addressLike('Lecture 3.2: Entropy') && !addressLike('Dr. Smith on valves'));
  assert.equal(fileTitle('https://upload.wikimedia.org/wikipedia/commons/transcoded/f/f1/Sintel_movie_4K.webm/Sintel_movie_4K.webm.240p.vp9.webm'), 'Sintel movie 4K'); // (round 3, B3: the transcode's own suffixes are not part of the name)
  assert.equal(fileTitle('https://download.blender.org/peach/BigBuckBunny_320x180.mp4?x=1'), 'BigBuckBunny'); // (round 3: nor is its picture size)
  assert.equal(fileTitle('https://x.example/media/Week%203%20-%20Valve%20disease.mp4'), 'Week 3 - Valve disease');
  assert.equal(fileTitle('https://x.example/media/'), '');
  assert.equal(fileTitle('https://cdn.example/v/9f8a3c21d07b44aa9f8a3c21d07b44aa.mp4'), '', 'a machine-made id is not a name');
});

test('a heading that is not the page\'s own name: the title is more telling (Open Yale, MIT OpenCourseWare as the real pages are)', () => {
  // Open Yale Courses: the nearest heading is a section under the player, the page's h1 is the course; the lecture is in the title.
  const yale = { title: 'ASTR 160 - Lecture 1 - Introduction | Open Yale Courses', host: 'oyc.yale.edu' };
  assert.deepEqual(name({ ...yale, heading: 'Lecture Chapters' }), ['ASTR 160 - Lecture 1 - Introduction', 'title']);
  assert.deepEqual(name({ ...yale, heading: 'ASTR 160: Frontiers and Controversies in Astrophysics' }), ['ASTR 160 - Lecture 1 - Introduction', 'title']);
  // …but a heading that says more than a course-wide title still names the video,
  assert.deepEqual(name({ heading: 'Cardiology: 002 Atrial fibrillation', title: 'Cardiology course', host: 'learn.example' }), ['Cardiology: 002 Atrial fibrillation', 'heading']);
  // and one that has nothing in common with the title is the lesson's name on a page titled after its course.
  assert.deepEqual(name({ heading: '12. Props and state', title: 'React - The Complete Guide', host: 'learn.example' }), ['12. Props and state', 'heading']);
  // A heading that is part of the title (or the other way round) stays, as before.
  assert.deepEqual(name({ heading: 'Do schools kill creativity?', title: 'Sir Ken Robinson: Do schools kill creativity? | TED Talk', host: 'www.ted.com' }), ['Do schools kill creativity?', 'heading']);
  // The page's video data often repeats the whole title, site and all: it is cleaned the same way.
  const ocw = 'Lecture 1: Probability Models and Axioms Video | Probabilistic Systems Analysis and Applied Probability | Electrical Engineering and Computer Science | MIT OpenCourseWare';
  assert.deepEqual(name({ structured: ocw, title: ocw, host: 'ocw.mit.edu' }), ['Lecture 1: Probability Models and Axioms Video', 'structured']);
  assert.deepEqual(name({ structured: 'Introducing the Open Book Futures Project : Free Download, Borrow, and Streaming : Internet Archive', title: 'x', host: 'archive.org' }),
    ['Introducing the Open Book Futures Project', 'structured']);
});

test('a section\'s heading under the player ("Summary", "Captions [Edit]") is not the video\'s name (Wikimedia Commons, as the real page is)', () => {
  const commons = { structured: 'Sintel movie 4K', title: 'File:Sintel movie 4K.webm - Wikimedia Commons', host: 'commons.wikimedia.org' };
  assert.deepEqual(name({ ...commons, heading: 'Summary' }), ['Sintel movie 4K', 'structured']);
  assert.deepEqual(name({ ...commons, heading: 'Captions Edit' }), ['Sintel movie 4K', 'structured']);
  for (const h of ['Summary', 'Description', 'Transcript', 'Comments', 'Related videos', 'Licensing', 'File history', 'Captions [edit]', 'Up next', 'Downloads']) assert.ok(weakName(h, 'heading'), h);
  // As a lesson in a list or a player's own label such a word can be a name; and "Introduction" is a lecture.
  assert.ok(!weakName('Summary', 'list') && !weakName('Introduction', 'heading') && !weakName('Summary of week 3', 'heading'));
});
