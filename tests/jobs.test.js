import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mediaSnapshot, docSnapshot, plainError, LINK_REFUSED, LINK_EXPIRED_QUEUED, skippedNote, leftoverTracks, traySummary, installHint,
  transcribeOffer,
} from '../extension/lib/jobs.js';

test('mediaSnapshot keeps what a download needs to start without its page, and nothing else', () => {
  const m = {
    id: 'abc', key: 'k1', aliases: ['k0'], url: 'https://cdn.example/v/master.m3u8?sig=1', kind: 'hls', mediaType: 'stream', ext: 'm3u8', size: null,
    contentType: '', title: '003: Valve disease', customName: 'Valves', course: 'Cardio', nameSource: 'player', pageUrl: 'https://school.example/lesson/3',
    fingerprint: 'fp', info: { duration: 480, maxHeight: 720 }, protected: false, poster: 'https://cdn.example/p.jpg', detectedAt: 5, hidden: false,
    library: { path: 'C:\\x.mp4' }, label: 'HLS · up to 720p', source: 'network', seen: 3, mark: null, nameTries: 2,
  };
  const snap = mediaSnapshot(m, { pageUrl: 'https://school.example/lesson/3', pageTitle: 'Cardio course', media: [m], log: ['x'] });
  assert.deepEqual(snap, {
    item: {
      id: 'abc', key: 'k1', aliases: ['k0'], url: m.url, kind: 'hls', mediaType: 'stream', ext: 'm3u8', title: '003: Valve disease', customName: 'Valves',
      course: 'Cardio', nameSource: 'player', pageUrl: 'https://school.example/lesson/3', fingerprint: 'fp', info: { duration: 480, maxHeight: 720 },
    },
    pageUrl: 'https://school.example/lesson/3', pageTitle: 'Cardio course',
  });
  // A copy: the waiting job does not change when the page's item does.
  m.info.duration = 1;
  m.aliases.push('later');
  assert.equal(snap.item.info.duration, 480);
  assert.deepEqual(snap.item.aliases, ['k0']);
  // It is stored, so it must survive being written and read back as JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap);
});

test('mediaSnapshot: a playlist entry keeps how to fetch it; an item with no page still gives a snapshot', () => {
  const entry = { id: 'e1', key: 'k', url: 'https://vimeo.com/5550002', kind: 'embed', title: '002', parentId: 'p1', playlistUrl: 'https://vimeo.com/showcase/1', playlistIndex: 2, provider: 'vimeo' };
  const snap = mediaSnapshot(entry);
  assert.equal(snap.item.playlistUrl, 'https://vimeo.com/showcase/1');
  assert.equal(snap.item.playlistIndex, 2);
  assert.equal(snap.item.parentId, 'p1');
  assert.deepEqual([snap.pageUrl, snap.pageTitle], ['', '']);
  assert.deepEqual(mediaSnapshot(null).item, {});
  // Many links to the same video are capped.
  assert.equal(mediaSnapshot({ id: 'x', aliases: Array.from({ length: 80 }, (_, i) => `a${i}`) }).item.aliases.length, 30);
});

test('docSnapshot keeps the link and the name and folder worked out for it', () => {
  const d = { id: 'd1', key: 'k', url: 'https://x.example/files/a.pdf', ext: 'pdf', name: 'Handout', host: 'x.example', label: 'PDF', kind: 'doc', title: 'Handout' };
  assert.deepEqual(docSnapshot(d, { file: 'Handout.pdf', folder: 'StreamSnag/Cardio', pageUrl: 'https://x.example/lesson' }), {
    doc: { id: 'd1', key: 'k', url: 'https://x.example/files/a.pdf', ext: 'pdf', name: 'Handout' },
    target: { file: 'Handout.pdf', folder: 'StreamSnag/Cardio', pageUrl: 'https://x.example/lesson' },
  });
  assert.deepEqual(docSnapshot(d).target, { file: '', folder: '', pageUrl: '' });
});

test('plainError: a server that says no becomes one sentence that says what to do, and the raw report is kept', () => {
  for (const raw of [
    'HTTP 403 for https://cdn.example/seg0.ts?token=abc', 'HTTP 401 fetching https://cdn.example/master.m3u8', 'HTTP 404 fetching https://x/y',
    'HTTP 410 for https://x/y', 'Download failed: SERVER_FORBIDDEN', 'Download failed: SERVER_UNAUTHORIZED', 'Download failed: SERVER_BAD_CONTENT',
  ]) {
    assert.deepEqual(plainError(raw), { text: LINK_REFUSED, detail: raw }, raw);
  }
  // The status alone is enough (the offscreen page reports it next to the message).
  assert.deepEqual(plainError('Something odd', { status: 403 }), { text: LINK_REFUSED, detail: 'Something odd' });
  assert.equal(LINK_REFUSED, 'The link expired or the site refused it. Reload the page, press play, and try again.');
});

test('plainError: other failures are left as they are', () => {
  for (const raw of ['Canceled', 'Download failed: NETWORK_FAILED', 'HTTP 500 for https://x/y', 'HTTP 429 for https://x/y', 'This stream is encrypted (AES-128) and cannot be downloaded.',
    'yt-dlp failed: ERROR: unable to download video data: HTTP Error 403: Forbidden', 'Failed to fetch', 'port 4031 is closed', '']) {
    assert.deepEqual(plainError(raw), { text: raw, detail: '' }, raw);
  }
  assert.deepEqual(plainError(null), { text: '', detail: '' });
  assert.deepEqual(plainError('HTTP 500 for x', { status: 500 }), { text: 'HTTP 500 for x', detail: '' });
  // Saying it twice changes nothing.
  assert.deepEqual(plainError(plainError('HTTP 403 for x').text), { text: LINK_REFUSED, detail: '' });
});

test('plainError: a link that expired while the download waited in the queue says to press Download all again', () => {
  assert.equal(LINK_EXPIRED_QUEUED, 'The link expired. Reload the page and press Download all again.');
  for (const raw of ['HTTP 403 fetching https://x/master.m3u8', 'HTTP 401 fetching https://x/a', 'HTTP 410 fetching https://x/a', 'Download failed: SERVER_FORBIDDEN']) {
    assert.deepEqual(plainError(raw, { queued: true }), { text: LINK_EXPIRED_QUEUED, detail: raw }, raw);
  }
  // Not found is not "expired": the general sentence.
  assert.equal(plainError('HTTP 404 fetching https://x/a', { queued: true }).text, LINK_REFUSED);
  assert.equal(plainError('That media item is gone — reload the page.', { queued: true }).text, 'That media item is gone — reload the page.');
});

test('skippedNote says which steps were skipped for want of captions, and what would make them happen', () => {
  assert.equal(skippedNote({ autoTranscript: true }), 'No captions, so no transcript. Turn on transcription in Settings to make one.');
  assert.equal(skippedNote({ autoStudyPack: true }), 'No captions, so no study pack. Turn on transcription in Settings to make one.');
  assert.equal(skippedNote({ autoTranscript: true, autoStudyPack: true }), 'No captions, so no transcript or study pack. Turn on transcription in Settings to make them.');
  // The switch this one replaced no longer counts: a setting is migrated before it gets here.
  assert.equal(skippedNote({ autoNotes: true }), '');
  // A study page is lined up with the captions too.
  assert.equal(skippedNote({ autoStudyPage: true }), 'No captions, so no study page. Turn on transcription in Settings to make one.');
  assert.equal(skippedNote({ autoStudyPack: true, autoStudyPage: true }), 'No captions, so no study pack or study page. Turn on transcription in Settings to make them.');
  assert.equal(skippedNote({ autoTranscript: true, autoStudyPack: true, autoStudyPage: true }),
    'No captions, so no transcript, study pack or study page. Turn on transcription in Settings to make them.');
  assert.equal(skippedNote({ autoStudyPage: true, autoTranscribe: true }), '');
  // With transcription on, the captions get made (or that step says why not): nothing to add.
  assert.equal(skippedNote({ autoTranscript: true, autoStudyPack: true, autoTranscribe: true }), '');
  assert.equal(skippedNote({ autoTranscribe: true }), '');
  assert.equal(skippedNote({}), '');
  assert.equal(skippedNote(), '');
});

test('leftoverTracks: the files already saved by a download that stopped before its last one', () => {
  const video = { role: 'video', status: 'done', downloadId: 7, path: 'C:\\d\\Lecture.video.mp4' };
  assert.deepEqual(leftoverTracks([video, { role: 'audio', status: 'running' }]), [video]);
  assert.deepEqual(leftoverTracks([video, { role: 'audio', status: 'pending' }, { role: 'subtitle', status: 'pending' }]), [video]);
  const audio = { role: 'audio', status: 'done', downloadId: 8 };
  assert.deepEqual(leftoverTracks([video, audio, { role: 'video', status: 'saving', downloadId: 9 }]), [video, audio]);
});

test('leftoverTracks: a finished download is never touched, nor one that saved nothing yet', () => {
  const done = (role, id) => ({ role, status: 'done', downloadId: id });
  assert.deepEqual(leftoverTracks([done('video', 1), done('audio', 2)]), []);
  assert.deepEqual(leftoverTracks([done('video', 1), done('audio', 2), { role: 'subtitle', status: 'skipped' }]), [], 'subtitles that would not load do not make it unfinished');
  assert.deepEqual(leftoverTracks([{ role: 'file', status: 'saving', downloadId: 3 }]), []);
  assert.deepEqual(leftoverTracks([{ role: 'video', status: 'running' }, { role: 'audio', status: 'pending' }]), []);
  assert.deepEqual(leftoverTracks([]), []);
  assert.deepEqual(leftoverTracks(undefined), []);
  // A finished track without a download id (nothing Chrome could remove) is left out.
  assert.deepEqual(leftoverTracks([{ role: 'video', status: 'done' }, { role: 'audio', status: 'running' }]), []);
});

test('traySummary names each kind of running job: conversions and transcriptions are not "downloading"', () => {
  const j = (status, kind = 'hls') => ({ status, kind });
  assert.equal(traySummary([j('running', 'convert')]), '1 converting');
  assert.equal(traySummary([j('running'), j('running', 'direct'), j('running', 'convert'), j('running', 'transcribe'), j('queued'), j('queued'), j('queued')]),
    '2 downloading · 1 converting · 1 transcribing · 3 queued');
  assert.equal(traySummary([j('muxing'), j('recording'), j('running', 'ytdlp')]), '3 downloading');
  assert.equal(traySummary([j('running', 'transcribe'), j('running', 'transcribe')]), '2 transcribing');
  // A study pack being made is not a download either.
  assert.equal(traySummary([j('running', 'studypack')]), '1 making a study pack');
  assert.equal(traySummary([j('running'), j('running', 'studypack'), j('running', 'studypack'), j('queued')]), '1 downloading · 2 making study packs · 1 queued');
  assert.equal(traySummary([j('done', 'studypack'), j('error', 'studypack')]), '');
  assert.equal(traySummary([j('queued', 'doc')]), '1 queued');
  assert.equal(traySummary([j('done'), j('error'), j('canceled', 'convert')]), '');
  assert.equal(traySummary(), '');
});

test('installHint names the installer of the computer it is for', () => {
  assert.equal(installHint('yt-dlp', 'win'), 'Install it with "winget install yt-dlp.yt-dlp"');
  assert.equal(installHint('ffmpeg', 'win'), 'Install it with "winget install Gyan.FFmpeg"');
  assert.equal(installHint('yt-dlp', 'mac'), 'Install it with "brew install yt-dlp"');
  assert.equal(installHint('ffmpeg', 'mac'), 'Install it with "brew install ffmpeg"');
  assert.equal(installHint('ffmpeg', 'linux'), 'Install it with your package manager (for example "sudo apt install ffmpeg")');
  assert.equal(installHint('yt-dlp', 'cros'), 'Install it with your package manager (for example "sudo apt install yt-dlp")');
  assert.equal(installHint('yt-dlp', ''), 'Install it with your package manager (for example "sudo apt install yt-dlp")');
  for (const os of ['mac', 'linux', 'cros', '']) assert.doesNotMatch(installHint('ffmpeg', os), /winget/, os);
  assert.equal(installHint('rm -rf', 'win'), '');
  assert.equal(installHint('constructor', 'win'), '');
});

test('transcribeOffer: the menu entry in each state, with the reason when it cannot run yet', () => {
  const ready = { ok: true, stt: { supported: true, ready: true } };
  const notSetUp = { ok: true, stt: { supported: true, ready: false } };
  // Captions on the page, nothing downloaded: "Save transcript" is there, no second entry is needed.
  assert.equal(transcribeOffer({ hasCaptions: true, downloaded: false, helper: ready }), null);
  // No captions and not downloaded yet: shown, greyed out, with what to do first.
  assert.deepEqual(transcribeOffer({ hasCaptions: false, downloaded: false, helper: ready }),
    { state: 'download', label: 'Transcribe on this computer', enabled: false, reason: 'Download it first, then transcribe it on this computer.' });
  assert.equal(transcribeOffer({ downloaded: false, helper: null }).state, 'download', 'whatever the helper says');
  // Downloaded, no helper.
  for (const helper of [null, undefined, { ok: false, error: 'not installed' }]) {
    const o = transcribeOffer({ downloaded: true, file: '', helper });
    assert.deepEqual([o.state, o.enabled, o.reason], ['helper', false, 'This needs the local helper. Set it up in Settings, on the Local helper tab.']);
  }
  // Downloaded, helper there, but it cannot run on this kind of computer.
  assert.deepEqual(transcribeOffer({ downloaded: true, file: 'C:\\v.mp4', helper: { ok: true, stt: { supported: false } } }),
    { state: 'unsupported', label: 'Transcribe on this computer', enabled: false, reason: 'Transcription can\'t run on this kind of computer.' });
  assert.equal(transcribeOffer({ downloaded: true, file: 'C:\\v.mp4', helper: { ok: true } }).state, 'unsupported', 'an old helper that says nothing about it');
  // Downloaded (marked, or by its history), but the file was not found in the folders.
  assert.equal(transcribeOffer({ downloaded: true, file: '', helper: ready }).state, 'nofile');
  assert.equal(transcribeOffer({ downloaded: true, file: '', helper: ready }).enabled, false);
  // Downloaded, transcription not set up: the entry works, and opens Settings.
  assert.deepEqual(transcribeOffer({ downloaded: true, file: 'C:\\v.mp4', helper: notSetUp }), {
    state: 'setup', label: 'Transcribe on this computer (needs setup)', enabled: true, opens: 'settings',
    reason: 'Turns speech into text on this computer. It needs a one-time setup in Settings first.',
  });
  // Downloaded and set up.
  const go = transcribeOffer({ downloaded: true, file: 'C:\\v.mp4', helper: ready });
  assert.deepEqual([go.state, go.label, go.enabled, go.opens], ['ready', 'Transcribe on this computer', true, undefined]);
});

test('transcribeOffer: with captions to read, only the entries that work are shown; none once captions sit next to the file', () => {
  const ready = { ok: true, stt: { supported: true, ready: true } };
  // A video that has captions never gets a greyed-out entry: "Save transcript" already answers it.
  assert.equal(transcribeOffer({ hasCaptions: true, downloaded: true, file: '', helper: null }), null);
  assert.equal(transcribeOffer({ hasCaptions: true, downloaded: true, file: '', helper: ready }), null);
  assert.equal(transcribeOffer({ hasCaptions: true, downloaded: true, file: 'C:\\v.mp4', helper: { ok: true, stt: { supported: false } } }), null);
  assert.equal(transcribeOffer({ hasCaptions: true, downloaded: true, file: 'C:\\v.mp4', helper: ready }).state, 'ready');
  assert.equal(transcribeOffer({ hasCaptions: true, downloaded: true, file: 'C:\\v.mp4', helper: { ok: true, stt: { supported: true, ready: false } } }).state, 'setup');
  // Transcribed already.
  assert.equal(transcribeOffer({ hasCaptions: true, localCaptions: true, downloaded: true, file: 'C:\\v.mp4', helper: ready }), null);
  assert.equal(transcribeOffer({ localCaptions: true, downloaded: true, file: 'C:\\v.mp4', helper: ready }), null);
  assert.equal(transcribeOffer().state, 'download');
});
