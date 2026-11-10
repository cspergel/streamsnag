import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeKey, sameMedia, streamFingerprint } from '../extension/lib/detect.js';

test('dedupeKey ignores CDN signatures and expiry, so re-signed links are the same file', () => {
  // CloudFront
  assert.equal(
    dedupeKey('https://d1.cloudfront.net/v/lec2.mp4?Expires=1700000000&Signature=abc~&Key-Pair-Id=K1'),
    dedupeKey('https://d1.cloudfront.net/v/lec2.mp4?Expires=1700009999&Signature=xyz~&Key-Pair-Id=K1'));
  // S3 presigned
  assert.equal(
    dedupeKey('https://b.s3.amazonaws.com/v.mp4?X-Amz-Algorithm=AWS4&X-Amz-Date=1&X-Amz-Signature=aa'),
    dedupeKey('https://b.s3.amazonaws.com/v.mp4?X-Amz-Date=2&X-Amz-Signature=bb&X-Amz-Algorithm=AWS4'));
  // Akamai/Vimeo signed path segment + per-session psid + pathsig query
  assert.equal(
    dedupeKey('https://vod-adaptive-ak.vimeocdn.com/exp=1~acl=%2Fx~hmac=aa/ccfa/psid=111/v2/playlist/av/primary/playlist.m3u8?pathsig=8c~a&r=dXM'),
    dedupeKey('https://vod-adaptive-ak.vimeocdn.com/exp=2~acl=%2Fx~hmac=bb/ccfa/psid=222/v2/playlist/av/primary/playlist.m3u8?pathsig=9d~b&r=dXM'));
  // Fastly-style signature segment
  assert.equal(
    dedupeKey('https://skyfire.vimeocdn.com/1794236234-0xdc47f21f47a07704c28a/ccfa/v2/x.m3u8'),
    dedupeKey('https://skyfire.vimeocdn.com/1794239999-0x0000f21f47a07704ffff/ccfa/v2/x.m3u8'));
  // Parameter order doesn't matter
  assert.equal(dedupeKey('https://a.com/v.mp4?b=2&a=1'), dedupeKey('https://a.com/v.mp4?a=1&b=2'));
});

test('dedupeKey still tells different videos apart', () => {
  assert.notEqual(dedupeKey('https://a.com/play?id=1&token=x'), dedupeKey('https://a.com/play?id=2&token=x'));
  assert.notEqual(dedupeKey('https://cdn.com/exp=1~hmac=a/lec1.mp4'), dedupeKey('https://cdn.com/exp=1~hmac=a/lec2.mp4'));
  assert.notEqual(dedupeKey('https://a.com/v.mp4?v=abc'), dedupeKey('https://a.com/v.mp4?v=abd'));
  // A path segment that merely contains "exp" is not a signature.
  assert.notEqual(dedupeKey('https://a.com/expert/1.mp4'), dedupeKey('https://a.com/expert/2.mp4'));
});

test('sameMedia: identical large files of the same type match; small, different-size or different-type do not', () => {
  const a = { kind: 'direct', ext: 'mp4', size: 5_000_000 };
  assert.equal(sameMedia(a, { kind: 'direct', ext: 'mp4', size: 5_000_000 }), true);
  assert.equal(sameMedia(a, { kind: 'direct', ext: 'mp4', size: 5_000_001 }), false);
  assert.equal(sameMedia(a, { kind: 'direct', ext: 'webm', size: 5_000_000 }), false);
  assert.equal(sameMedia({ kind: 'direct', ext: 'mp4', size: 200_000 }, { kind: 'direct', ext: 'mp4', size: 200_000 }), false);
  assert.equal(sameMedia(a, { kind: 'hls', size: 5_000_000 }), false);
  assert.equal(sameMedia({ kind: 'direct', ext: 'mp4', size: null }, { kind: 'direct', ext: 'mp4', size: null }), false);
  assert.equal(sameMedia({ kind: 'subtitle', size: 9e6 }, { kind: 'subtitle', size: 9e6 }), false);
});

test('stream fingerprints match across hosts and tokens, and differ between videos', () => {
  const v = (host, tok, id) => [`https://${host}/x/${id}/720.m3u8?token=${tok}`, `https://${host}/x/${id}/360.m3u8?token=${tok}`];
  const f1 = streamFingerprint(v('cdn1.com', 'a', 'lec2'), 'hls-master');
  assert.equal(f1, streamFingerprint(v('cdn2.com', 'b', 'lec2'), 'hls-master'));
  assert.notEqual(f1, streamFingerprint(v('cdn1.com', 'a', 'lec3'), 'hls-master'));
  assert.equal(sameMedia({ kind: 'hls', fingerprint: f1 }, { kind: 'hls', fingerprint: f1 }), true);
  assert.equal(sameMedia({ kind: 'hls', fingerprint: '' }, { kind: 'hls', fingerprint: '' }), false);
  assert.equal(streamFingerprint([]), '');
});
