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
