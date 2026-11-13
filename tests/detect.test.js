import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyResponse, classifyUrl, totalSize, dedupeKey, isLikelySegment } from '../extension/lib/detect.js';

const KB = 1024;

test('direct mp4 at exactly the size threshold is accepted, one byte below is rejected', () => {
  const min = 300 * KB;
  const at = classifyResponse({ url: 'https://cdn.x.com/v/movie.mp4', contentType: 'video/mp4', contentLength: String(min), status: 200 }, { minSizeBytes: min });
  assert.equal(at.kind, 'direct');
  assert.equal(at.ext, 'mp4');
  assert.equal(at.size, min);
  const below = classifyResponse({ url: 'https://cdn.x.com/v/movie.mp4', contentType: 'video/mp4', contentLength: String(min - 1), status: 200 }, { minSizeBytes: min });
  assert.equal(below, null);
});

test('ranged 206 response uses total size from Content-Range', () => {
  const r = classifyResponse({ url: 'https://a.com/clip.webm', contentType: 'video/webm', contentLength: '1000', contentRange: 'bytes 0-999/52428800', status: 206 });
  assert.equal(r.size, 52428800);
  assert.equal(r.ext, 'webm');
});

test('HLS and DASH detected by content type even without extension', () => {
  assert.equal(classifyResponse({ url: 'https://a.com/play?id=1', contentType: 'application/vnd.apple.mpegurl; charset=utf-8', status: 200 }).kind, 'hls');
  assert.equal(classifyResponse({ url: 'https://a.com/manifest', contentType: 'application/dash+xml', status: 200 }).kind, 'dash');
});

test('stream segments are not reported as videos', () => {
  assert.equal(classifyResponse({ url: 'https://a.com/hls/seg-12.ts', contentType: 'video/mp2t', contentLength: '900000', status: 200 }), null);
  assert.equal(classifyResponse({ url: 'https://a.com/dash/chunk-stream0-00042.m4s', contentType: 'video/iso.segment', contentLength: '900000', status: 200 }), null);
  assert.equal(classifyResponse({ url: 'https://a.com/v/segment_5.mp4', contentType: 'video/mp4', contentLength: String(2 * 1024 * KB), status: 200 }), null);
});

test('non-media and failed responses are ignored', () => {
  assert.equal(classifyResponse({ url: 'https://a.com/app.js', contentType: 'application/javascript', contentLength: '999999', status: 200 }), null);
  assert.equal(classifyResponse({ url: 'https://a.com/movie.mp4', contentType: 'video/mp4', contentLength: '99999999', status: 403 }), null);
  assert.equal(classifyResponse({ url: 'blob:https://a.com/123', contentType: 'video/mp4', status: 200 }), null);
});

test('octet-stream with a media extension counts, without one does not', () => {
  assert.equal(classifyResponse({ url: 'https://a.com/dl/song.mp3', contentType: 'application/octet-stream', contentLength: String(5000 * KB), status: 200 }).mediaType, 'audio');
  assert.equal(classifyResponse({ url: 'https://a.com/dl/file.bin', contentType: 'application/octet-stream', contentLength: String(5000 * KB), status: 200 }), null);
});

test('subtitle files are detected but numbered VTT segments are not', () => {
  assert.equal(classifyResponse({ url: 'https://a.com/subs/en.vtt', contentType: 'text/vtt', status: 200 }).kind, 'subtitle');
  assert.equal(classifyResponse({ url: 'https://a.com/subs/seg-3.vtt', contentType: 'text/vtt', status: 200 }), null);
});

test('totalSize handles missing headers', () => {
  assert.equal(totalSize({}), null);
  assert.equal(totalSize({ contentLength: '0' }), 0);
  assert.equal(totalSize({ contentRange: 'bytes 0-1/*', contentLength: '2' }), 2);
});

test('classifyUrl for DOM URLs', () => {
  assert.equal(classifyUrl('https://a.com/x/master.m3u8?token=1').kind, 'hls');
  assert.equal(classifyUrl('https://a.com/v.mp4').kind, 'direct');
  assert.equal(classifyUrl('https://a.com/page.html'), null);
  assert.equal(classifyUrl('blob:https://a.com/1'), null);
});

test('dedupeKey ignores range/cache-buster params but keeps identity params', () => {
  assert.equal(dedupeKey('https://a.com/v.mp4?id=5&range=0-100'), dedupeKey('https://a.com/v.mp4?id=5&range=100-200'));
  assert.notEqual(dedupeKey('https://a.com/v.mp4?id=5'), dedupeKey('https://a.com/v.mp4?id=6'));
});

test('large file with segment-like name is still a video; a small one is a segment', () => {
  assert.equal(isLikelySegment('https://a.com/part1.mp4', 500 * 1024 * KB), false);
  assert.equal(isLikelySegment('https://a.com/part1.mp4', 3 * 1024 * KB), true);
});

// ---------------------------------------------------------------- YouTube's own player (batch 9: each video listed twice)
test('the pieces of YouTube\'s player (picture and sound apart) are recognised, and never taken for files of their own', async () => {
  const { playerPiece, youTubeWatchId, youTubeTitle, classifyResponse: classify } = await import('../extension/lib/detect.js');
  const picture = 'https://rr3---sn-abc.googlevideo.com/videoplayback?expire=1999999999&id=o-AAA&itag=137&source=youtube&mime=video%2Fmp4&clen=9000000&rn=1';
  const sound = 'https://rr3---sn-abc.googlevideo.com/videoplayback?expire=1999999999&id=o-AAA&itag=251&source=youtube&mime=audio%2Fwebm&clen=3000000&rn=2';
  // What used to happen: each piece, answered with its total size, read as a whole file (two per video).
  assert.equal(classify({ url: picture, status: 206, contentType: 'video/mp4', contentRange: 'bytes 0-700000/9000000' })?.kind, 'direct');
  assert.equal(classify({ url: sound, status: 206, contentType: 'audio/webm', contentRange: 'bytes 0-700000/3000000' })?.mediaType, 'audio');
  assert.ok(playerPiece(picture) && playerPiece(sound), 'both are pieces of the player');
  assert.ok(playerPiece('http://127.0.0.1:5000/videoplayback?itag=137&source=youtube'), 'by what it says, wherever it is served from');
  assert.ok(!playerPiece('https://r1---sn-x.c.drive.google.com/videoplayback?source=webdrive&id=1'), 'Google Drive\'s player is not YouTube\'s');
  assert.ok(!playerPiece('https://cdn.example.com/lecture.mp4?source=youtube'));
  assert.equal(youTubeWatchId('https://www.youtube.com/watch?v=kJQP7kiw5Fk&list=PLx&index=2'), 'kJQP7kiw5Fk');
  assert.equal(youTubeWatchId('https://music.youtube.com/watch?v=kJQP7kiw5Fk'), 'kJQP7kiw5Fk');
  assert.equal(youTubeWatchId('https://www.youtube.com/playlist?list=PLx'), '');
  assert.equal(youTubeWatchId('https://www.youtube.com/watch?v=short'), '');
  assert.equal(youTubeTitle('Luis Fonsi - Despacito ft. Daddy Yankee - YouTube'), 'Luis Fonsi - Despacito ft. Daddy Yankee');
});

test('the worker lists a YouTube watch page\'s video once, and lets the one before go when the page moves on', async () => {
  const fs = await import('node:fs');
  const bg = fs.readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  const handle = bg.slice(bg.indexOf('async function handleResponse('), bg.indexOf('async function handleResponse(') + 1800);
  assert.ok(handle.indexOf('playerPiece(r.url)') > 0 && handle.indexOf('playerPiece(r.url)') < handle.indexOf('classifyResponse('), 'a piece is set aside before anything is classified');
  assert.match(bg, /const stay = split\.stay\.filter\(\(m\) => !m\.ytWatch \|\| m\.ytWatch === nowV\)/);
  assert.match(bg, /const left = split\.left\.filter\(\(m\) => !m\.ytWatch\)/);
});

// ---------------------------------------------------------------- the same player, streaming HLS (2026-11-12: one video listed three times)
test('the player\'s HLS playlists and their path-style pieces are the page\'s video again, never streams of their own', async () => {
  const { playerPiece, classifyResponse: classify } = await import('../extension/lib/detect.js');
  // From the owner's diagnostic report (a signed-in session, a watch page in a mix), shortened.
  const variant = 'https://manifest.googlevideo.com/api/manifest/hls_variant/expire/1794557859/ei/Q3P2aq2yBdjby_sPzqizmAM/id/a29f7d350b1ca464/source/youtube/requiressl/yes/playback_host/rr3---sn-fvf-in8l.googlevideo.com/cps/326/file/index.m3u8';
  const playlist = 'https://manifest.googlevideo.com/api/manifest/hls_playlist/expire/1794557859/ei/Q3P2aq2yBdjby_sPzqizmAM/id/a29f7d350b1ca464/itag/312/source/youtube/requiressl/yes/sgovp/clen%3D24190617%3Bdur%3D219.149/file/index.m3u8';
  const piece = 'https://rr3---sn-fvf-in8l.googlevideo.com/videoplayback/id/a29f7d350b1ca464/itag/312/source/youtube/expire/1794557859/requiressl/yes/sgovp/clen%3D24190617/rqh/1/begin/0/len/5000/goap/clen%3D1/file/seg.ts';
  // What used to happen: the playlists read as streams of their own (the second and third rows).
  assert.equal(classify({ url: variant, status: 200, contentType: 'application/vnd.apple.mpegurl' })?.kind, 'hls');
  assert.equal(classify({ url: playlist, status: 200, contentType: 'application/vnd.apple.mpegurl' })?.kind, 'hls');
  for (const u of [variant, playlist, piece]) assert.ok(playerPiece(u), u.slice(0, 70));
  assert.ok(playerPiece('https://manifest.googlevideo.com/api/manifest/dash/expire/1/id/a/source/youtube/file/m.mpd'), 'its DASH manifest too');
  // Not every playlist, nor every /videoplayback/ path: only these.
  assert.ok(!playerPiece('https://cdn.example.com/api/manifest/v1/master.m3u8'));
  assert.ok(!playerPiece('https://cdn.example.com/hls/lecture/index.m3u8'));
  assert.ok(!playerPiece('https://cdn.example.com/videoplayback/lecture-3.mp4'));
  assert.ok(!playerPiece('https://cdn.example.com/videoplayback/itagless/file.mp4'));
  assert.ok(!playerPiece('https://r1---sn-x.c.drive.google.com/videoplayback/id/1/itag/18/source/webdrive/file.mp4'), 'Google Drive\'s player sends whole videos');
});
