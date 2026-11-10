// Numbered titles, per-site rules, playlist listings and yt-dlp output names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitLecture, buildFilename, rulesFor } from '../extension/lib/util.js';
import { parseFlatPlaylist, ytdlpSafeName } from '../native-host/host.js';

test('splitLecture separates a leading lecture number from the name', () => {
  assert.deepEqual(splitLecture('009: Updates in the Diagnosis of C. diff'), { number: '009', name: 'Updates in the Diagnosis of C. diff' });
  assert.deepEqual(splitLecture('033 Management of Endocarditis'), { number: '033', name: 'Management of Endocarditis' });
  assert.deepEqual(splitLecture('Lecture 12 - Sepsis'), { number: '12', name: 'Sepsis' });
  assert.deepEqual(splitLecture('000 - Course Introduction'), { number: '000', name: 'Course Introduction' });
  // Not lecture numbers: dates, times, a number that is the whole title, a year inside a name.
  assert.deepEqual(splitLecture('2026-11-02 Morning session'), { number: '', name: '2026-11-02 Morning session' });
  assert.deepEqual(splitLecture('10:30 Keynote'), { number: '', name: '10:30 Keynote' });
  assert.deepEqual(splitLecture('42'), { number: '', name: '42' });
  assert.deepEqual(splitLecture('Update in Medicine 2026'), { number: '', name: 'Update in Medicine 2026' });
});

test('{number} and {name} fill a template; missing parts collapse cleanly', () => {
  assert.equal(buildFilename('{number} - {name}', { title: '009: C. diff Update' }, 'mp4'), '009 - C. diff Update.mp4');
  assert.equal(buildFilename('{number} - {name}', { title: 'Keynote' }, 'mp4'), 'Keynote.mp4');
  assert.equal(buildFilename('{course} - {number} {name} - {quality}', { title: '7. Pain', course: 'Big Course', quality: '' }, ''), 'Big Course - 7 Pain');
  // The default template is unchanged.
  assert.equal(buildFilename('', { title: 'Clip', quality: '720p' }, 'ts'), 'Clip - 720p.ts');
});

test('a site rule overrides folder and name for that site and its subdomains only', () => {
  const settings = {
    subfolder: 'StreamSnag', filenameTemplate: '{title} - {quality}',
    siteRules: { 'example.com': { subfolder: 'Courses/{course}', filenameTemplate: '{number} - {name}' }, 'video.example.com': { subfolder: 'Clips', filenameTemplate: '' } },
  };
  assert.deepEqual(rulesFor(settings, 'https://www.example.com/course/1'), { site: 'example.com', subfolder: 'Courses/{course}', filenameTemplate: '{number} - {name}' });
  assert.deepEqual(rulesFor(settings, 'https://learn.example.com/x'), { site: 'example.com', subfolder: 'Courses/{course}', filenameTemplate: '{number} - {name}' });
  // The most specific rule wins; an empty field falls back to the general setting.
  assert.deepEqual(rulesFor(settings, 'https://video.example.com/x'), { site: 'video.example.com', subfolder: 'Clips', filenameTemplate: '{title} - {quality}' });
  // Look-alike domains are not covered.
  assert.deepEqual(rulesFor(settings, 'https://notexample.com/'), { site: '', subfolder: 'StreamSnag', filenameTemplate: '{title} - {quality}' });
  assert.deepEqual(rulesFor({ subfolder: 'S', filenameTemplate: 'T' }, ''), { site: '', subfolder: 'S', filenameTemplate: 'T' });
});

test('a yt-dlp flat playlist becomes ordered entries with usable URLs', () => {
  const listing = {
    _type: 'playlist', id: '12471493', title: 'Course - Day 1', extractor: 'vimeo:album',
    entries: [
      { _type: 'url', ie_key: 'Vimeo', id: '1111111', url: 'https://vimeo.com/1111111', title: '000 - Course Introduction', duration: 855 },
      { _type: 'url', ie_key: 'Vimeo', id: '2222222', title: '001: Rheumatology' }, // no URL: built from the id
      { _type: 'url', ie_key: 'Youtube', id: 'dQw4w9WgXcQ', title: 'A YouTube one', playlist_index: 7 },
      { _type: 'url', title: 'Broken entry without id or url' },
      { _type: 'url', ie_key: 'Generic', id: 'x', url: 'javascript:alert(1)', title: 'Not a web link' },
    ],
  };
  const p = parseFlatPlaylist(JSON.stringify(listing));
  assert.equal(p.title, 'Course - Day 1');
  assert.deepEqual(p.entries.map((e) => [e.index, e.url, e.duration]), [
    [1, 'https://vimeo.com/1111111', 855],
    [2, 'https://vimeo.com/2222222', 0],
    [7, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 0],
  ]);
  assert.deepEqual(parseFlatPlaylist({}), { title: '', playlistId: '', entries: [] });
});

test('yt-dlp output names cannot leave the folder or inject template fields', () => {
  assert.equal(ytdlpSafeName('009 - C. diff: 100% better'), '009 - C. diff 100%% better');
  assert.equal(ytdlpSafeName('..\\..\\Windows\\evil'), 'Windows evil');
  assert.equal(ytdlpSafeName('a/b'), 'a b');
  assert.throws(() => ytdlpSafeName('   '), /Empty/);
  assert.ok(ytdlpSafeName('x'.repeat(400)).length <= 150);
});
