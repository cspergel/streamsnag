// The plain words of the first screen (lib/wording.js): a recording's one line, its quality rows, where it
// was saved, how far a download is, the captions heading, the empty Activity view and plain errors.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAudio, kindWord, nounFor, plainDuration, cardLine, fileTypeWord, fileTypeHint, qualityWords, qualityRows, savedTrail, savedTo, progressWords,
  captionsTravel, captionsHeading, captionLabels, captionName, languageName, activityEmpty, samePage, protectedWords, plainProblem, OTHER_WAY,
  docRows, DOC_FOLD, DOC_FIND, ASIDE_GROUP, emptyState, flagWords, plainNote,
} from '../extension/lib/wording.js';
import { REASONS } from '../extension/lib/review.js';
import { stripSummary } from '../extension/lib/strip.js';

const TECH_WORDS = /\b(HLS|DASH|MP4|WEBM|OGV|Mbps|kbps|ffmpeg|yt-dlp|DRM)\b|\.[a-z]{2,}\.(com|org|net)/;

test('C6: audio is not "video": what an item is, and what a list of them is called', () => {
  assert.equal(kindWord({ kind: 'direct', mediaType: 'video', ext: 'mp4' }), 'Video');
  assert.equal(kindWord({ kind: 'direct', mediaType: 'audio', ext: 'mp3' }), 'Audio');
  assert.equal(kindWord({ kind: 'direct', mediaType: 'video', ext: 'm4a' }), 'Audio', 'a sound file is sound, whatever the page called it');
  assert.equal(kindWord({ kind: 'hls', mediaType: 'stream', info: { live: true } }), 'Live video');
  assert.equal(kindWord({ kind: 'subtitle' }), 'Captions');
  assert.equal(kindWord({ kind: 'embed', playlist: true }), 'Playlist');
  assert.equal(isAudio({ ext: 'OGG' }), true);
  assert.equal(isAudio({ ext: 'ogv' }), false);
  const video = { kind: 'hls', mediaType: 'stream' };
  const audio = { kind: 'direct', mediaType: 'audio' };
  assert.equal(nounFor([video, video]), 'videos');
  assert.equal(nounFor([audio, audio]), 'audio files');
  assert.equal(nounFor([video, audio]), 'recordings');
  assert.equal(nounFor([audio], 1), 'audio file');
  assert.equal(nounFor([video, { kind: 'subtitle' }], 1), 'video', 'caption files are not counted');
  assert.equal(stripSummary({ total: 3, get: 3 }, 'recording'), '3 recordings on this page: 3 to get.');
  assert.equal(stripSummary({ total: 1, saved: 1 }), '1 video on this page: 1 saved.');
});

test('U8: the card line says what it is, how long and how big, and nothing technical', () => {
  const lecture = { kind: 'direct', mediaType: 'video', ext: 'mp4', size: 129 * 1024 * 1024, duration: 27 * 60, label: 'MP4 · 129 MB', url: 'https://dn600208.us.archive.org/a.mp4' };
  assert.equal(cardLine(lecture), 'Video · 27 min · 129 MB');
  assert.equal(cardLine(lecture, { length: false }), 'Video · 129 MB');
  const stream = { kind: 'hls', mediaType: 'stream', info: { duration: 3905, maxHeight: 1080, variantCount: 5 }, label: 'HLS · up to 1080p · 5 qualities · 1:05:05', url: 'https://stream.mux.com/x.m3u8' };
  assert.equal(cardLine(stream), 'Video · 1 h 5 min');
  assert.equal(cardLine({ kind: 'direct', mediaType: 'audio', ext: 'mp3', size: 3.6 * 1024 * 1024, duration: 420 }), 'Audio · 7 min · 3.6 MB');
  assert.equal(cardLine({ kind: 'dash', mediaType: 'stream', info: { live: true } }), 'Live video');
  for (const m of [lecture, stream]) assert.doesNotMatch(cardLine(m), TECH_WORDS);
  assert.equal(plainDuration(45), '45 s');
  assert.equal(plainDuration(3600), '1 h');
  assert.equal(plainDuration(0), '');
  assert.equal(plainDuration(NaN), '');
});

test('U8: quality rows are one plain phrase per picture size', () => {
  // A stream's qualities: each lower picture size has a lower bitrate, and says so.
  const stream = (q, rate) => ({ q, rate });
  assert.deepEqual(qualityWords([stream('1080p', 5.2e6), stream('720p', 2.8e6)]), ['1080p · best', '720p · smaller']);
  assert.deepEqual(qualityWords([stream('2160p', 16e6), stream('1080p', 5e6), stream('720p', 2.8e6), stream('360p', 7e5)]), ['2160p · best', '1080p · smaller', '720p · smaller', '360p · smallest']);
  assert.deepEqual(qualityWords(['720p']), ['720p']);
  assert.deepEqual(qualityWords([]), []);
});

test('E11: "smaller" is only said of a file that is known to be smaller; the file type is a detail, not the choice', () => {
  const MB = 1024 * 1024;
  // Sizes not known: the picture sizes still name the rows, the first is the best picture, and nothing is claimed about size.
  assert.deepEqual(qualityWords(['1080p', '720p']), ['1080p · best', '720p']);
  assert.deepEqual(qualityWords(['1080p', '720p', '360p']), ['1080p · best', '720p', '360p']);
  // One size missing is "unknown" for all of them: no row is compared with a guess.
  assert.deepEqual(qualityWords([{ q: '1080p', bytes: 700 * MB }, { q: '576p' }]), ['1080p · best', '576p']);
  // Equal sizes: neither is "smaller".
  assert.deepEqual(qualityWords([{ q: '1080p', bytes: 300 * MB }, { q: '720p', bytes: 300 * MB }]), ['1080p · best', '720p']);
  // A lower picture size in a bigger file (another codec): it is not called smaller.
  assert.deepEqual(qualityWords([{ q: '720p', bytes: 287 * MB }, { q: '480p', bytes: 428 * MB }]), ['720p · best', '480p']);
  // FOSDEM: a 720p WebM of 287 MB and an MP4 of 428 MB whose picture size is not said. It used to read
  // "720p · best / MP4 · smaller": the bigger file called smaller, and a file type offered as a quality.
  const fosdem = qualityRows([{ q: '720p', ext: 'webm', bytes: 287 * MB }, { q: '', ext: 'mp4', bytes: 428 * MB }]);
  assert.deepEqual(fosdem, [{ words: '720p · 287 MB · smaller', detail: 'WEBM' }, { words: '428 MB', detail: 'MP4' }]);
  for (const r of fosdem) assert.doesNotMatch(r.words, /MP4|WEBM|best/);
  // Sound in two formats ("MP3 · best / OGG · smaller"): told apart by size, the type a small label.
  assert.deepEqual(qualityRows([{ ext: 'mp3', bytes: 3.9 * MB }, { ext: 'ogg', bytes: 2.1 * MB }]), [{ words: '3.9 MB', detail: 'MP3' }, { words: '2.1 MB · smaller', detail: 'OGG' }]);
  // …and with no sizes the type is all there is to say: it is the name, with no claim beside it.
  assert.deepEqual(qualityRows([{ ext: 'mp3' }, { ext: 'ogg' }]), [{ words: 'MP3', detail: '' }, { words: 'OGG', detail: '' }]);
  // Three files of the same picture: the smallest is only named when one of them is.
  assert.deepEqual(qualityWords([{ bytes: 9 * MB }, { bytes: 5 * MB }, { bytes: 2 * MB }]), ['9.0 MB', '5.0 MB · smaller', '2.0 MB · smallest']);
  assert.deepEqual(qualityWords([{ bytes: 9 * MB }, { bytes: 2 * MB }, { bytes: 2 * MB }]), ['9.0 MB', '2.0 MB · smaller', '2.0 MB · smaller']);
  // Several files with their picture sizes and types (Commons): the sizes name them, the types stay small.
  assert.deepEqual(qualityRows([{ q: '1080p', ext: 'webm', bytes: 90 * MB }, { q: '480p', ext: 'webm', bytes: 20 * MB }]), [{ words: '1080p · best', detail: 'WEBM' }, { words: '480p · smaller', detail: 'WEBM' }]);
});

test('U8: the button says "Download"; a file that is not an MP4 says its type as a quiet detail', () => {
  assert.equal(fileTypeWord({ kind: 'direct', ext: 'mp4' }), '', 'an MP4 is what everyone expects');
  assert.equal(fileTypeWord({ kind: 'direct', ext: 'ogv' }), 'OGV file');
  assert.equal(fileTypeWord({ kind: 'direct', ext: 'mp3' }), 'MP3 file');
  assert.equal(fileTypeWord({ kind: 'direct', ext: 'WebM' }), 'WEBM file');
  assert.equal(fileTypeWord({ kind: 'hls', ext: 'm3u8' }), '', 'a stream is saved as a video file, not as its playlist');
  assert.equal(fileTypeWord({ kind: 'direct', ext: '' }), '');
  assert.equal(fileTypeWord({ kind: 'direct', ext: 'not a type' }), '');
  // What the type means for the person who opens the file.
  assert.match(fileTypeHint('mp4'), /^MP4 file: plays on almost any/);
  assert.match(fileTypeHint('WEBM'), /^WEBM file: plays in a browser and in the free VLC player\./);
  assert.equal(fileTypeHint('xyz'), 'XYZ file');
  assert.equal(fileTypeHint(''), '');
});

test('E7: a page with caption files and a player that has not started still says "Press play"', () => {
  // en.wikipedia before the player starts: 41 caption files and no video. It used to say nothing at all.
  const wiki = emptyState({ webPage: true, videos: 0, subs: 41, docs: 0, players: 1 });
  assert.equal(wiki.title, 'Press play, then open StreamSnag again.');
  assert.equal(wiki.hint, 'The player on this page has not loaded its video yet. Most players only do once they start. The 41 caption files found here are listed below.');
  // With files too, and with one of each.
  assert.match(emptyState({ videos: 0, subs: 2, docs: 3, players: 1 }).hint, /The 3 files and 2 caption files found here are listed below\.$/);
  assert.match(emptyState({ videos: 0, subs: 1, players: 1 }).hint, /The 1 caption file found here is listed below\.$/);
  // Nothing found beside the player: the hint ends where it did.
  assert.equal(emptyState({ videos: 0, players: 1 }).hint, 'The player on this page has not loaded its video yet. Most players only do once they start.');
  // Something already playing that StreamSnag cannot see: the captions are still pointed at, and it does not say "Press play".
  const hidden = emptyState({ videos: 0, subs: 2, players: 1, playing: 1 });
  assert.match(hidden.hint, /The 2 caption files found here are listed below\.$/);
  assert.doesNotMatch(`${hidden.title} ${hidden.hint}`, /Press play/);
  // No player at all: the page has no video, and the captions are below.
  assert.equal(emptyState({ videos: 0, subs: 2 }).title, 'No video on this page.');
  assert.equal(emptyState({ videos: 0, subs: 2 }).hint, 'Open a lecture to save it. The 2 caption files found here are listed below.');
});

test('first-time user: each flag says what it means and what to do, in the list and on the sheet', () => {
  for (const key of Object.keys(REASONS)) {
    const list = flagWords(key);
    const sheet = flagWords(key, 'sheet');
    assert.ok(list && sheet, `${key} has words`);
    assert.match(list, /"Download all" leaves it unticked: tick it there if you want it\.$/, key);
    assert.match(sheet, /Not ticked: tick it if you want it too\.$/, key);
    assert.doesNotMatch(`${list} ${sheet}`, /flag|dedupe|heuristic|duplicate/i);
  }
  assert.equal(flagWords('copy'), 'A second copy of one listed here. "Download all" leaves it unticked: tick it there if you want it.');
  assert.equal(flagWords('promo', 'sheet'), 'Probably not a lecture. Not ticked: tick it if you want it too.');
  assert.equal(flagWords('noname'), 'The page gave it no name of its own. "Download all" leaves it unticked: tick it there if you want it.');
  assert.equal(flagWords(''), '');
  assert.equal(flagWords('nothing of the kind'), '', 'a key that is no flag gets no sentence');
});

test('U8: a finished download\'s note is plain; what the tool reported is kept for the tooltip', () => {
  const merged = plainNote('ffmpeg: merged video + audio, embedded 2 subtitle tracks');
  assert.equal(merged.text, 'Picture and sound joined into one file. Captions saved inside the video (2 sets).');
  assert.equal(merged.detail, 'ffmpeg: merged video + audio, embedded 2 subtitle tracks');
  assert.equal(plainNote('ffmpeg: merged video + audio').text, 'Picture and sound joined into one file.');
  assert.equal(plainNote('ffmpeg: converted to MP4, embedded 1 subtitle track').text, 'Saved as an MP4 file. Captions saved inside the video.');
  assert.equal(plainNote('ffmpeg: merged video + audio, subtitles kept as separate files').text, 'Picture and sound joined into one file. Captions saved as files next to it.');
  const failed = plainNote('ffmpeg merge failed (exit 1); kept separate files.');
  assert.equal(failed.text, 'The picture and sound could not be joined, so they were saved as two files.');
  assert.match(failed.detail, /exit 1/);
  assert.match(plainNote('Video and audio saved as separate files (install the helper + ffmpeg to merge automatically).').text, /^Picture and sound were saved as two files\. Set up the local helper/);
  assert.equal(plainNote('ffmpeg: merged video + audio · The subtitles could not be downloaded.').text, 'Picture and sound joined into one file. The captions could not be downloaded.');
  for (const raw of ['ffmpeg: merged video + audio, embedded 2 subtitle tracks', 'ffmpeg merge failed (x); kept separate files.', 'Video and audio saved as separate files (install the helper + ffmpeg to merge automatically).']) {
    assert.doesNotMatch(plainNote(raw).text, /ffmpeg|merged|mux|subtitle track/i, raw);
  }
  // A note that is already plain is left alone, with nothing to hide.
  assert.deepEqual(plainNote('Saved 7 files next to the video'), { text: 'Saved 7 files next to the video', detail: '' });
  assert.deepEqual(plainNote(''), { text: '', detail: '' });
  assert.deepEqual(plainNote(undefined), { text: '', detail: '' });
});

test('U1: where a file went, as the folders you would click through', () => {
  const win = 'C:\\Users\\sam\\Downloads\\StreamSnag\\PHYS201\\01 Cardiac output.mp4';
  assert.deepEqual(savedTrail({ path: win, folder: 'StreamSnag/PHYS201' }), ['Downloads', 'StreamSnag', 'PHYS201']);
  assert.equal(savedTo(savedTrail({ path: win, folder: 'StreamSnag/PHYS201' })), 'Saved to Downloads › StreamSnag › PHYS201');
  // Your own save folder is named as it is.
  assert.deepEqual(savedTrail({ path: 'D:\\Lectures\\StreamSnag\\a.mp4', folder: 'StreamSnag' }), ['Lectures', 'StreamSnag']);
  // No subfolder at all: the folder the file is in.
  assert.deepEqual(savedTrail({ path: '/home/sam/Downloads/a.mp4', folder: '' }), ['Downloads']);
  // The subfolder is not known (a file found by the folder check): its last two folders.
  assert.deepEqual(savedTrail({ path: '/home/sam/Videos/Cardio/a.mp4' }), ['Videos', 'Cardio']);
  // The file was moved somewhere the subfolder does not explain: say where it really is.
  assert.deepEqual(savedTrail({ path: 'E:\\Archive\\2026\\a.mp4', folder: 'StreamSnag/PHYS201' }), ['Archive', '2026']);
  // No path yet (a plan): the root and the subfolder.
  assert.deepEqual(savedTrail({ folder: 'StreamSnag/PHYS201', root: 'Downloads' }), ['Downloads', 'StreamSnag', 'PHYS201']);
  assert.deepEqual(savedTrail({}), ['Downloads']);
  assert.equal(savedTo([]), 'Saved');
  assert.equal(savedTo(['Downloads', 'StreamSnag'], '4 saved to'), '4 saved to Downloads › StreamSnag');
});

test('U6: one progress line with a time from the start', () => {
  assert.equal(progressWords({ status: 'running', pct: 0 }), 'Starting…');
  assert.equal(progressWords({ status: 'running', pct: 0.4 }), 'Starting…');
  assert.equal(progressWords({ status: 'running', pct: 42, eta: 'about 20 s left' }), '42% · about 20 s left');
  assert.equal(progressWords({ status: 'running', pct: 42 }), '42%');
  // No size known yet: still "Starting…" until something has arrived; a download that never says its size is then "Downloading…".
  assert.equal(progressWords({ status: 'running', indeterminate: true }), 'Starting…');
  assert.equal(progressWords({ status: 'running', indeterminate: true, begun: true }), 'Downloading…');
  assert.equal(progressWords({ status: 'queued' }), 'Waiting for its turn');
  assert.match(progressWords({ status: 'muxing' }), /^Finishing/);
  assert.equal(progressWords({ status: 'recording' }), 'Recording live…');
  for (const s of ['running', 'queued', 'muxing', 'recording']) assert.doesNotMatch(progressWords({ status: s, pct: 50, eta: 'about 1 min left' }), /KB\/s|MB\/s|ffmpeg|Merging/);
});

test('U10: the captions heading only promises what is true, and each file is named by its language', () => {
  const stream = { kind: 'hls', info: { hasSubtitles: true } };
  const file = { kind: 'direct' };
  const on = { includeSubtitles: true, embedSubtitles: true, useFfmpeg: true };
  assert.equal(captionsTravel([stream], { settings: on, ffmpeg: true }), 'inside');
  assert.equal(captionsTravel([stream], { settings: on, ffmpeg: false }), 'beside', 'without the helper they are saved as files next to it');
  assert.equal(captionsTravel([stream], { settings: { ...on, embedSubtitles: false }, ffmpeg: true }), 'beside');
  assert.equal(captionsTravel([stream], { settings: { ...on, includeSubtitles: false }, ffmpeg: true }), '');
  assert.equal(captionsTravel([file, { kind: 'subtitle' }], { settings: on, ffmpeg: true }), '', 'a plain file\'s caption files are just listed');
  assert.equal(captionsHeading(2, 'inside'), 'Captions (2): saved inside the video when you download it');
  assert.equal(captionsHeading(2, 'beside'), 'Captions (2): saved next to the video when you download it');
  assert.equal(captionsHeading(2, ''), 'Captions (2)');
  assert.equal(languageName('en'), 'English');
  assert.equal(languageName('ja'), 'Japanese');
  assert.equal(languageName('not a language'), '');
  assert.equal(languageName(''), '');
  // Two files in one language that differ only in format (D9, U8: "British English (VTT)" / "(SRT)") are the
  // same captions twice: one name, and the format a quiet detail.
  const labels = captionLabels([{ id: 'a', lang: 'en', ext: 'vtt' }, { id: 'b', lang: 'en', ext: 'srt' }, { id: 'c', lang: 'ar', ext: 'vtt' }, { id: 'd', lang: '', ext: 'vtt', name: '' }]);
  assert.deepEqual([...labels], [['a', { name: 'English', detail: 'VTT file' }], ['b', { name: 'English', detail: 'also as an SRT file' }], ['c', { name: 'Arabic', detail: '' }], ['d', { name: 'Captions', detail: '' }]]);
  for (const l of labels.values()) assert.doesNotMatch(l.name, /VTT|SRT/);
  // Two that even share the format are two different files: numbered.
  assert.deepEqual([...captionLabels([{ id: 'x', lang: 'en', ext: 'vtt' }, { id: 'y', lang: 'en', ext: 'vtt' }]).values()], [{ name: 'English · 1', detail: '' }, { name: 'English · 2', detail: '' }]);
  assert.deepEqual(captionLabels([{ id: 'x', lang: 'en', ext: 'vtt' }]).get('x'), { name: 'English', detail: '' });
  assert.equal(captionLabels([{ id: 'x', lang: 'en-GB', ext: 'srt' }, { id: 'y', lang: 'en-GB', ext: 'vtt' }]).get('y').detail, 'also as a VTT file');
});

test('D9: a caption file is called by its language, else by its lecture: never by a bitrate or a bare dash', () => {
  // What a page calls a caption file, when that says something.
  assert.equal(captionName('300k'), '', 'a bitrate');
  assert.equal(captionName('64 kbps'), '');
  assert.equal(captionName('720p'), '', 'a picture size');
  assert.equal(captionName('2'), '');
  assert.equal(captionName('-'), '', 'a bare dash');
  assert.equal(captionName(' — '), '');
  assert.equal(captionName('- (translated)'), 'Captions (translated)');
  assert.equal(captionName('English (auto-generated)'), 'English (auto-generated)');
  assert.equal(captionName(''), '');
  // archive.org's course: 25 lectures, each with one .srt whose only label is "300k". They read "300k (SRT) · 1" … "· 25".
  const course = Array.from({ length: 25 }, (_, i) => ({ id: `s${i}`, lang: '', ext: 'srt', name: '300k', of: `Lecture ${i + 1}: Probability` }));
  const named = captionLabels(course);
  assert.equal(named.get('s0').name, 'Lecture 1: Probability');
  assert.equal(named.get('s24').name, 'Lecture 25: Probability');
  assert.equal(new Set([...named.values()].map((l) => l.name)).size, 25, 'each row is told apart by its lecture');
  for (const l of named.values()) assert.doesNotMatch(`${l.name} ${l.detail}`, /300k|SRT|· \d+$/);
  // With the language known, both are said: the language first.
  const both = captionLabels([{ id: 'a', lang: 'en', ext: 'vtt', of: 'Lecture 1' }, { id: 'b', lang: 'es', ext: 'vtt', of: 'Lecture 1' }, { id: 'c', lang: 'en', ext: 'vtt', of: 'Lecture 2' }]);
  assert.deepEqual([...both.values()].map((l) => l.name), ['English · Lecture 1', 'Spanish · Lecture 1', 'English · Lecture 2']);
  // One lecture on the page: its name would say nothing, so the language stands alone.
  assert.deepEqual([...captionLabels([{ id: 'a', lang: 'en', ext: 'vtt', of: 'Lecture 1' }, { id: 'b', lang: 'de', ext: 'vtt', of: 'Lecture 1' }]).values()].map((l) => l.name), ['English', 'German']);
  // media.ccc.de: "English" and a track whose language is "-" and whose label is "- (translated)".
  const ccc = captionLabels([{ id: 'a', lang: 'en', ext: 'vtt', name: 'eng' }, { id: 'b', lang: '-', ext: 'vtt', name: '- (translated)' }]);
  assert.deepEqual([...ccc.values()].map((l) => l.name), ['English', 'Captions (translated)']);
  for (const l of ccc.values()) assert.doesNotMatch(l.name, /^[-–—\s]/);
  // Nothing known at all, on a page with one lecture: "Captions", numbered when there are several.
  assert.deepEqual([...captionLabels([{ id: 'a', ext: 'vtt', name: '128k' }, { id: 'b', ext: 'vtt', name: '-' }]).values()].map((l) => l.name), ['Captions · 1', 'Captions · 2']);
});

test('U7: Activity never claims nothing has run from a page whose lecture was saved earlier', () => {
  assert.deepEqual(activityEmpty({ earlier: 2, history: 9 }), { text: 'Nothing running. Saved from this page earlier:', link: true });
  assert.deepEqual(activityEmpty({ earlier: 0, history: 9 }), { text: 'Nothing running. Earlier downloads are in History.', link: true });
  assert.equal(activityEmpty({}).link, false);
  for (const a of [activityEmpty({ earlier: 1, history: 1 }), activityEmpty({ history: 1 }), activityEmpty({})]) assert.doesNotMatch(a.text, /nothing has run/i);
  assert.equal(samePage('https://learn.example.com/l/5#t=30', 'https://learn.example.com/l/5'), true);
  assert.equal(samePage('https://learn.example.com/l/5/', 'https://learn.example.com/l/5'), true);
  assert.equal(samePage('https://learn.example.com/l/6', 'https://learn.example.com/l/5'), false);
  assert.equal(samePage('', ''), false);
});

test('U5: a protected item says the sentence and one line on what still works', () => {
  const m = { kind: 'dash', mediaType: 'stream', protected: true };
  assert.equal(protectedWords(m).text, 'This video is protected by the site, so it can\'t be saved.');
  assert.equal(protectedWords(m).still, 'You can still watch it on the page.');
  assert.equal(protectedWords(m, { captions: true }).still, 'Its transcript can still be saved.');
  assert.equal(protectedWords(m, { files: 2 }).still, 'The 2 files on this page can still be downloaded.');
  assert.equal(protectedWords(m, { captions: true, files: 1 }).still, 'Its transcript can still be saved, and the file on this page can still be downloaded.');
  assert.doesNotMatch(protectedWords(m).text, /not available yet|DRM|encrypted/i);
});

test('U8: an error is one plain sentence plus what to do; what was reported is kept for Details', () => {
  const raw = 'Not an HLS playlist (missing #EXTM3U)';
  const p = plainProblem(raw);
  assert.equal(p.text, 'StreamSnag couldn\'t read this one. Reload the page, press play, then try again.');
  assert.equal(p.detail, raw);
  assert.doesNotMatch(p.text, TECH_WORDS);
  assert.match(plainProblem('ffmpeg exited with code 1: Invalid data found').text, /could not be joined/);
  assert.match(plainProblem('NETWORK_FAILED').text, /connection/i);
  assert.equal(plainProblem('This media is DRM/encrypted and cannot be downloaded.').text, 'This one is protected by the site, so it can\'t be saved.');
  assert.match(plainProblem('FILE_NO_SPACE').text, /room on the disk/);
  // A sentence that is already plain is left alone, with nothing to hide.
  const plain = 'The link expired or the site refused it. Reload the page, press play, and try again.';
  assert.deepEqual(plainProblem(plain), { text: plain, detail: '' });
  // Setup instructions name the tool they install: kept as they are.
  const setup = 'yt-dlp was not found. Install it with "winget install yt-dlp.yt-dlp", then try again.';
  assert.equal(plainProblem(setup).text, setup);
  assert.equal(plainProblem('').text, 'Something went wrong. Try again.');
  assert.doesNotMatch(OTHER_WAY, /yt-dlp/);
});

test('D10: a long list of files is grouped by type with counts, folded past twelve, and gets a find box past twenty', () => {
  const doc = (name, ext, url = `https://x.example/${name}.${ext}`) => ({ id: name, name, ext, url });
  // A short list of one type: the files, no heading, nothing folded.
  const few = docRows([doc('Slides week 1', 'pdf'), doc('Handout', 'pdf')]);
  assert.deepEqual(few.rows.map((r) => r.group || r.name), ['Slides week 1', 'Handout']);
  assert.deepEqual([few.total, few.shown, few.hidden, few.find], [2, 2, 0, false]);
  // A short list of several types stays as the page has it: headings are for long lists.
  const mixed = docRows([doc('Notes', 'pdf'), doc('Deck', 'pptx'), doc('Reading', 'pdf')]);
  assert.deepEqual(mixed.rows.map((r) => r.group || r.name), ['Notes', 'Deck', 'Reading']);
  // 94 files (the Stanford page): twelve are shown, "Show all 94" has the rest, and there is a find box.
  const many = [...Array.from({ length: 90 }, (_, i) => doc(`Handout ${i + 1}`, 'pdf')), doc('All materials', 'zip'), doc('Deck A', 'pptx'), doc('Deck B', 'pptx'), doc('Grades', 'xlsx')];
  const folded = docRows(many);
  assert.equal(DOC_FOLD, 12);
  assert.equal(folded.rows.filter((r) => !r.group).length, 12);
  assert.deepEqual([folded.total, folded.shown, folded.hidden, folded.find], [94, 12, 82, true]);
  assert.equal(folded.rows[0].group, 'PDFs');
  assert.equal(folded.rows[0].n, 90, 'the heading counts the whole group, not just what is shown');
  const open = docRows(many, { all: true });
  assert.equal(open.rows.filter((r) => !r.group).length, 94);
  assert.deepEqual(open.rows.filter((r) => r.group).map((r) => `${r.group} ${r.n}`), ['PDFs 90', 'Slides 2', 'Spreadsheets 1', 'Archives 1']);
  // Finding by name looks through all of them, folded or not.
  assert.deepEqual(docRows(many, { query: 'handout 90' }).rows.filter((r) => !r.group).map((r) => r.name), ['Handout 90']);
  assert.equal(docRows(many, { query: 'handout 9' }).rows.filter((r) => !r.group).length, 10, 'every word is looked for anywhere in the name, as in the video list');
  assert.deepEqual(docRows(many, { query: 'DECK b' }).rows.filter((r) => !r.group).map((r) => r.name), ['Deck B']);
  assert.equal(docRows(many, { query: 'nothing like it' }).rows.length, 0);
  assert.equal(docRows(Array.from({ length: DOC_FIND }, (_, i) => doc(`F${i}`, 'pdf'))).find, false);
  assert.equal(docRows(Array.from({ length: DOC_FIND + 1 }, (_, i) => doc(`F${i}`, 'pdf'))).find, true);
});

test('U16: a file linked only from the page\'s footer or menu is not one of the page\'s files', () => {
  const doc = (name, ext) => ({ id: name, name, ext, url: `https://x.example/${name}.${ext}` });
  const docs = [doc('Slides', 'pdf'), doc('Handout', 'pdf'), doc('Privacy policy', 'pdf'), doc('Press kit', 'zip')];
  const aside = new Set([docs[2].url, docs[3].url]);
  const r = docRows(docs, { aside });
  assert.equal(r.total, 2, 'only the page\'s own files are counted');
  assert.equal(r.aside, 2);
  assert.deepEqual(r.rows.map((x) => x.group || x.name), ['Slides', 'Handout'], 'and only they are listed at first');
  // Opened in full, the others are there under a heading that says what they are.
  const full = docRows(docs, { aside, all: true });
  assert.deepEqual(full.rows.map((x) => (x.group ? `${x.group} ${x.n}` : x.name)), ['Slides', 'Handout', `${ASIDE_GROUP} 2`, 'Privacy policy', 'Press kit']);
  // A page with nothing but such links still lists them, under that heading, counted as no files of its own.
  const only = docRows(docs.slice(2), { aside });
  assert.equal(only.total, 0);
  assert.deepEqual(only.rows.map((x) => x.group || x.name), [ASIDE_GROUP, 'Privacy policy', 'Press kit']);
});
