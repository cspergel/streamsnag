// "Files on this page": which links count as documents, what they are called, and when they count as downloaded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DOC_EXTS, MAX_DOCS, docExtOf, docLabel, docKey, isGenericText, nameFromUrl, docName, docFilename,
  cleanDocs, frameDocs, mergeDocs, sameDoc, docStatus, directDocUrl, isWebPageMime, WEB_PAGE_NOT_FILE,
} from '../extension/lib/files.js';
import { sameItem } from '../extension/lib/match.js';
import { pickPlaying } from '../extension/lib/util.js';

const SITE = 'https://learn.example.com';

test('the whitelist is exactly the agreed document types', () => {
  assert.deepEqual([...DOC_EXTS].sort(), ['csv', 'doc', 'docx', 'epub', 'ipynb', 'key', 'numbers', 'odp', 'ods', 'odt', 'pages', 'pdf',
    'pps', 'ppsx', 'ppt', 'pptx', 'rtf', 'xls', 'xlsx', 'zip']);
  for (const e of DOC_EXTS) {
    assert.equal(docExtOf(`${SITE}/files/handout.${e}`), e, e);
    assert.match(docLabel(e), /^[A-Z]{3,5}$/, e);
  }
  assert.equal(docLabel('pptx'), 'PPT');
  assert.equal(docLabel('PDF'), 'PDF');
  assert.equal(docLabel('exe'), '');
});

test('only a path that ends in a whitelisted type is a document', () => {
  assert.equal(docExtOf(`${SITE}/a/Slides.PDF`), 'pdf'); // case
  assert.equal(docExtOf(`${SITE}/a/slides.pdf?download=1&name=x.exe`), 'pdf'); // query strings don't matter…
  assert.equal(docExtOf(`${SITE}/a/slides.pdf#page=4`), 'pdf');
  assert.equal(docExtOf(`${SITE}/a/week%203/Notes%20(final).docx`), 'docx');
  for (const bad of [
    `${SITE}/setup.exe`, `${SITE}/notes.pdf.exe`, `${SITE}/installer.msi`, `${SITE}/app.js`, `${SITE}/page.html`, `${SITE}/run.bat`,
    `${SITE}/a.scr`, `${SITE}/x.lnk`, `${SITE}/macro.docm`, `${SITE}/sheet.xlsm`, `${SITE}/archive.rar`, `${SITE}/disk.iso`,
    `${SITE}/run.exe?file=slides.pdf`, `${SITE}/run.exe#slides.pdf`, // …in either direction
    `${SITE}/download?file=slides.pdf`, `${SITE}/slides.pdf/`, `${SITE}/pdf`, `${SITE}/`, `${SITE}/slides.pdf%2Eexe`,
    `${SITE}/a.constructor`, `${SITE}/a.toString`, `${SITE}/a.__proto__`,
  ]) assert.equal(docExtOf(bad), '', bad);
  // Only web addresses, whatever they end in.
  for (const bad of ['javascript:alert(1)//x.pdf', 'javascript:void(0);//a.pdf', 'data:application/pdf;base64,AAAA.pdf', 'file:///C:/Users/me/tax.pdf',
    'blob:https://learn.example.com/1234.pdf', 'ftp://example.com/a.pdf', 'chrome://settings/x.pdf', '/files/relative.pdf', 'slides.pdf', '', null, undefined, 42, {}]) {
    assert.equal(docExtOf(bad), '', String(bad));
  }
});

test('link text that says nothing about the file is recognised', () => {
  for (const t of ['Download', 'download', 'here', 'Click here', 'click here!', 'PDF', 'pdf', '[PDF]', 'Download PDF', 'Download (PDF, 2.4 MB)', 'View file',
    'Open in new tab', 'Read more', 'this link', 'DOCX', 'Download the file here', '[1]', '2', '', '   ', '→', '***']) {
    assert.equal(isGenericText(t), true, JSON.stringify(t));
  }
  for (const t of ['Week 3 slides', 'Syllabus', 'Slides', 'Lecture 12', 'Answer key', 'Download the syllabus', 'Notes (PDF)', 'Übungsblatt 4', '讲义']) {
    assert.equal(isGenericText(t), false, t);
  }
});

test('a document is named from its link text, else from the file name in its address', () => {
  const url = `${SITE}/files/wk3_slides-v2.pdf`;
  assert.equal(docName({ text: '  Week 3:\n\t  Thermodynamics   slides ', url }), 'Week 3: Thermodynamics slides'); // trimmed, single spaces
  for (const generic of ['Download', 'here', 'PDF', 'click here', '', undefined]) assert.equal(docName({ text: generic, url }), 'wk3_slides-v2', String(generic));
  // A tooltip or label is better than a generic text.
  assert.equal(docName({ text: 'Download', alt: 'Lab manual', url }), 'Lab manual');
  assert.equal(docName({ text: '', alt: 'PDF', url }), 'wk3_slides-v2');
  // The text is the address or the file name itself.
  assert.equal(docName({ text: 'https://learn.example.com/files/wk3_slides-v2.pdf', url }), 'wk3_slides-v2');
  assert.equal(docName({ text: 'Syllabus.PDF', url }), 'Syllabus');
  // Encoded names are decoded; a broken encoding is kept as written.
  assert.equal(nameFromUrl(`${SITE}/f/Week%203%20%E2%80%93%20R%C3%A9sum%C3%A9.pdf`), 'Week 3 – Résumé');
  assert.equal(docName({ text: 'Download', url: `${SITE}/f/Reading%20list%20(week%203).pdf?token=abc#page=2` }), 'Reading list (week 3)');
  assert.equal(nameFromUrl(`${SITE}/f/100%25%zz.pdf`), '100%25%zz');
  assert.equal(nameFromUrl(`${SITE}/f/a%2Fb%5Cc.pdf`), 'a b c'); // an encoded slash is not a folder
  assert.equal(nameFromUrl(`${SITE}/f/archive.tar.zip`), 'archive.tar');
  assert.equal(docName({ text: 'here', url: `${SITE}/f/.pdf` }), 'document');
  assert.equal(nameFromUrl('not a url'), '');
});

test('very long link text is cut to 120 characters', () => {
  const long = `Lecture notes ${'very '.repeat(60)}long`;
  const name = docName({ text: long, url: `${SITE}/n.pdf` });
  assert.equal([...name].length <= 120, true, String(name.length));
  assert.equal(name.startsWith('Lecture notes very very'), true);
  assert.equal(name, name.trim());
  // Cut between characters, never through one.
  const emoji = docName({ text: `Notes${'😀'.repeat(200)}`, url: `${SITE}/n.pdf` });
  assert.equal([...emoji].length, 120);
  assert.equal(emoji.length, 5 + 115 * 2); // every emoji whole (two code units each)
  assert.equal(/[\ud800-\udbff]$/.test(emoji), false);
  assert.equal([...nameFromUrl(`${SITE}/${'x'.repeat(500)}.pdf`)].length, 120);
});

test('the saved file is the sanitised name plus the whitelisted extension, and nothing else', () => {
  assert.equal(docFilename('Week 3: Thermodynamics', 'pdf'), 'Week 3 Thermodynamics.pdf');
  assert.equal(docFilename('a/b\\c<d>|e?*"f', 'PPTX'), 'a b c d e f.pptx');
  assert.equal(docFilename('Syllabus.pdf', 'pdf'), 'Syllabus.pdf'); // not "Syllabus.pdf.pdf"
  // A name can't smuggle in another type or a folder: the last extension is always the whitelisted one.
  assert.equal(docFilename('invoice.exe', 'pdf'), 'invoice.exe.pdf');
  assert.equal(docFilename('..\\..\\Start Menu\\run', 'docx'), 'Start Menu run.docx');
  assert.equal(docFilename('evil\u202Efdp.exe', 'pdf'), 'evil fdp.exe.pdf'); // right-to-left override removed
  assert.equal(docFilename('con', 'pdf'), '_con.pdf');
  for (const empty of ['', '   ', '...', '???', null, undefined]) assert.equal(docFilename(empty, 'pdf'), 'document.pdf', String(empty));
  assert.equal(docFilename('x'.repeat(400), 'pdf').length, 124);
  // Never a type outside the list, whatever the caller passes.
  for (const bad of ['exe', 'pdf.exe', 'js', 'html', '', null, undefined, 'constructor']) assert.equal(docFilename('setup', bad), '', String(bad));
});

test('a frame\'s report is cleaned: whitelist only, one row per document, capped', () => {
  const docs = cleanDocs([
    { url: `${SITE}/files/slides.pptx`, text: 'Week 3 slides' },
    { url: `${SITE}/files/syllabus.pdf`, text: 'Download' },
    { url: `${SITE}/files/syllabus.pdf#page=2`, text: 'Course syllabus' }, // the same file again, with a better name
    { url: `${SITE}/files/syllabus.pdf?token=zzz&Expires=9`, text: 'Syllabus (signed link)' }, // and again, re-signed
    { url: `${SITE}/files/setup.exe`, text: 'Lecture viewer' },
    { url: `${SITE}/files/notes.pdf.exe`, text: 'Notes' },
    { url: 'javascript:void(0)//x.pdf', text: 'Secret' },
    { url: `${SITE}/files/${'a'.repeat(2100)}.pdf`, text: 'Absurdly long address' },
    { text: 'no url' }, null, 'str', 7,
  ]);
  assert.deepEqual(docs.map((d) => [d.name, d.ext, d.url]), [
    ['Week 3 slides', 'pptx', `${SITE}/files/slides.pptx`],
    ['Course syllabus', 'pdf', `${SITE}/files/syllabus.pdf`],
  ]);
  assert.equal(docs[1].key, docKey(`${SITE}/files/syllabus.pdf#anything`));
  assert.deepEqual(Object.keys(docs[0]).sort(), ['ext', 'key', 'name', 'url']);
  for (const junk of [null, undefined, 'x', 5, {}]) assert.deepEqual(cleanDocs(junk), []);

  const many = Array.from({ length: 900 }, (_, i) => ({ url: `${SITE}/f/${i}.pdf`, text: `Paper ${i}` }));
  assert.equal(cleanDocs(many).length, MAX_DOCS);
  assert.equal(cleanDocs(many, 3).map((d) => d.name).join(), 'Paper 0,Paper 1,Paper 2');
});

test('frames share one list: replaced per frame, one budget, each document once', () => {
  let by = frameDocs(undefined, 0, [{ url: `${SITE}/a.pdf`, text: 'Alpha' }, { url: `${SITE}/b.pdf`, text: 'Beta' }]);
  by = frameDocs(by, 7, [{ url: `${SITE}/b.pdf`, text: 'Beta again' }, { url: 'https://cdn.example.net/c.docx', text: 'Gamma' }]);
  assert.deepEqual(mergeDocs(by).map((d) => d.name), ['Alpha', 'Beta', 'Gamma']);
  // A frame reports its whole list each time: what is no longer there goes.
  by = frameDocs(by, 0, [{ url: `${SITE}/a.pdf`, text: 'Alpha' }]);
  assert.deepEqual(mergeDocs(by).map((d) => d.name), ['Alpha', 'Beta again', 'Gamma']);
  by = frameDocs(by, 7, []);
  assert.deepEqual(Object.keys(by), ['0']);
  assert.deepEqual(frameDocs(by, 0, [{ url: `${SITE}/x.exe`, text: 'Nope' }]), {});
  // The whole tab has one budget, and the main page goes first.
  const lots = (tag) => Array.from({ length: 150 }, (_, i) => ({ url: `${SITE}/${tag}/${i}.pdf`, text: `${tag} ${i}` }));
  let big = frameDocs({}, 3, lots('frame'));
  big = frameDocs(big, 0, lots('main'));
  assert.equal(big[0].length, 150);
  assert.equal(big[3].length, MAX_DOCS - 150);
  assert.equal(mergeDocs(big).length, MAX_DOCS);
  assert.equal(mergeDocs(big)[0].name, 'main 0');
  assert.deepEqual(mergeDocs(undefined), []);
});

test('links with the same text are told apart by their file names', () => {
  const by = frameDocs({}, 0, [
    { url: `${SITE}/l1/intro.pdf`, text: 'Slides' }, { url: `${SITE}/l2/entropy.pdf`, text: 'slides' },
    { url: `${SITE}/l3/Slides.pdf`, text: 'Slides' }, { url: `${SITE}/l1/notes.pdf`, text: 'Notes' },
  ]);
  assert.deepEqual(mergeDocs(by).map((d) => d.name), ['Slides (intro)', 'slides (entropy)', 'Slides', 'Notes']);
});

test('a document counts as downloaded by its address, in this session or the history', () => {
  const [doc] = cleanDocs([{ url: `${SITE}/files/syllabus.pdf?token=aaa`, text: 'Syllabus' }]);
  const other = cleanDocs([{ url: `${SITE}/files/slides.pdf`, text: 'Slides' }])[0];
  const job = (status, d = doc) => ({ status, mediaUrl: d.url, mediaKeys: [d.key] });
  assert.equal(docStatus(doc, [], []), 'new');
  assert.equal(docStatus(doc, [job('running')], []), 'active');
  assert.equal(docStatus(doc, [job('queued')], []), 'queued');
  assert.equal(docStatus(doc, [job('done')], []), 'done');
  assert.equal(docStatus(doc, [job('error')], []), 'failed');
  assert.equal(docStatus(doc, [job('canceled')], []), 'new');
  assert.equal(docStatus(doc, [job('error'), job('running')], []), 'active'); // a retry in progress
  assert.equal(docStatus(doc, [job('done', other)], []), 'new'); // another file's download says nothing
  // History (a later visit, a fresh signature on the link).
  const resigned = cleanDocs([{ url: `${SITE}/files/syllabus.pdf?token=bbb&Expires=5`, text: 'Syllabus' }])[0];
  assert.equal(docStatus(resigned, [], [{ at: 1, mediaUrl: doc.url, mediaKeys: [doc.key] }]), 'done');
  assert.equal(docStatus(other, [], [{ at: 1, mediaUrl: doc.url, mediaKeys: [doc.key] }]), 'new');
  assert.equal(docStatus(doc, undefined, undefined), 'new');
  assert.equal(sameDoc(doc, null), false);
  assert.equal(sameDoc(null, job('done')), false);
});

test('documents never count as a video: not as its download, and not as what is playing', () => {
  const id = 'c5c7e357-a526-4c44-9a3e-1f0d2b6a7e91';
  const video = { id: 'v1', kind: 'hls', key: `https://cdn.example.net/${id}/v2/playlist.m3u8`, url: `https://cdn.example.net/${id}/v2/playlist.m3u8?sig=1`, info: { duration: 600 } };
  // The handout sits in the same per-lecture folder as the stream: downloading it must not mark the video as downloaded.
  const [doc] = cleanDocs([{ url: `https://cdn.example.net/${id}/handout.pdf`, text: 'Handout' }]);
  const docRecord = { mediaId: 'dabc', mediaUrl: doc.url, mediaKeys: [doc.key], fingerprint: '', mediaSize: null };
  assert.equal(sameItem(video, docRecord), false);
  // …while another copy of the video itself (same id, other host) still does.
  assert.equal(sameItem(video, { mediaUrl: `https://other.example.org/${id}/v2/playlist.m3u8`, mediaKeys: [] }), true);
  // A video's download says nothing about the document either.
  assert.equal(docStatus(doc, [{ status: 'done', mediaUrl: video.url, mediaKeys: [video.key] }], []), 'new');
  // "Now playing" only ever looks at the media list; a page that plays nothing has nothing playing.
  assert.equal(pickPlaying([video], [{ frameId: 0, src: doc.url, page: `${SITE}/lesson`, playing: true }]), null);
});

test('directDocUrl: a Dropbox share link becomes the link to the file itself', () => {
  assert.equal(directDocUrl('https://www.dropbox.com/s/abc123/slides.pdf?dl=0'), 'https://www.dropbox.com/s/abc123/slides.pdf?dl=1');
  assert.equal(directDocUrl('https://dropbox.com/s/abc123/slides.pdf?dl=0'), 'https://dropbox.com/s/abc123/slides.pdf?dl=1');
  // The new kind of share link keeps its key.
  assert.equal(directDocUrl('https://www.dropbox.com/scl/fi/xyz/Week%203.pptx?rlkey=k9&st=abc&dl=0'), 'https://www.dropbox.com/scl/fi/xyz/Week%203.pptx?rlkey=k9&st=abc&dl=1');
  // No "dl" at all opens the viewer too.
  assert.equal(directDocUrl('https://www.dropbox.com/s/abc123/slides.pdf'), 'https://www.dropbox.com/s/abc123/slides.pdf?dl=1');
  // Already the file: untouched, character for character.
  assert.equal(directDocUrl('https://www.dropbox.com/s/abc123/slides.pdf?dl=1'), 'https://www.dropbox.com/s/abc123/slides.pdf?dl=1');
});

test('directDocUrl: a GitHub "blob" page becomes the "raw" file', () => {
  assert.equal(directDocUrl('https://github.com/prof/course/blob/main/hw1.ipynb'), 'https://github.com/prof/course/raw/main/hw1.ipynb');
  assert.equal(directDocUrl('https://github.com/prof/course/blob/v2.1/week%203/notes.pdf?x=1'), 'https://github.com/prof/course/raw/v2.1/week%203/notes.pdf?x=1');
  // Only the "blob" right after owner/repo: a folder that happens to be called blob stays.
  assert.equal(directDocUrl('https://github.com/prof/course/raw/main/blob/hw1.ipynb'), 'https://github.com/prof/course/raw/main/blob/hw1.ipynb');
  assert.equal(directDocUrl('https://github.com/prof/course/releases/download/v1/slides.pdf'), 'https://github.com/prof/course/releases/download/v1/slides.pdf');
});

test('directDocUrl: only on those two sites; every other link is returned exactly as it was', () => {
  for (const url of [
    'https://learn.example.com/files/slides.pdf?dl=0',
    'https://learn.example.com/prof/course/blob/main/hw1.ipynb',
    'https://notdropbox.com/s/abc/slides.pdf?dl=0',
    'https://dropbox.com.evil.example/s/abc/slides.pdf?dl=0',
    'https://evil.example/?u=https://www.dropbox.com/s/abc/slides.pdf?dl=0',
    'https://gist.github.com/prof/abc/blob/main/hw1.ipynb',
    'https://raw.githubusercontent.com/prof/course/main/hw1.ipynb',
    'https://github.com.evil.example/prof/course/blob/main/hw1.ipynb',
    'https://dl.dropboxusercontent.com/s/abc/slides.pdf',
    'not a url', '',
  ]) assert.equal(directDocUrl(url), url, url);
});

test('cleanDocs lists a viewer link as the file behind it, once, whichever way it is linked', () => {
  const docs = cleanDocs([
    { url: 'https://www.dropbox.com/s/abc123/slides.pdf?dl=0', text: 'Lecture slides' },
    { url: 'https://www.dropbox.com/s/abc123/slides.pdf?dl=1', text: 'Slides again' },
    { url: 'https://github.com/prof/course/blob/main/hw1.ipynb', text: 'Homework 1' },
    { url: `${SITE}/files/plain.pdf?dl=0`, text: 'Plain' },
  ]);
  assert.deepEqual(docs.map((d) => [d.name, d.url, d.ext]), [
    ['Lecture slides', 'https://www.dropbox.com/s/abc123/slides.pdf?dl=1', 'pdf'],
    ['Homework 1', 'https://github.com/prof/course/raw/main/hw1.ipynb', 'ipynb'],
    ['Plain', `${SITE}/files/plain.pdf?dl=0`, 'pdf'],
  ]);
  // A page that is not a document on those sites is still not one.
  assert.deepEqual(cleanDocs([{ url: 'https://github.com/prof/course/blob/main/README.md', text: 'Readme' }, { url: 'https://www.dropbox.com/s/abc/setup.exe?dl=0', text: 'Tool' }]), []);
});

test('isWebPageMime: a "document" that arrived as a web page is told apart from a real file', () => {
  for (const mime of ['text/html', 'text/html; charset=utf-8', 'TEXT/HTML', ' text/html ', 'application/xhtml+xml']) assert.equal(isWebPageMime(mime), true, mime);
  for (const mime of ['application/pdf', 'application/octet-stream', 'application/zip', 'text/plain', 'text/csv', 'text/htmlx', 'application/vnd.ms-powerpoint', '', null, undefined]) {
    assert.equal(isWebPageMime(mime), false, String(mime));
  }
  assert.match(WEB_PAGE_NOT_FILE, /^This link opens a web page, not the file itself\./);
});
