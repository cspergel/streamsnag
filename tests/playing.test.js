import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickPlaying } from '../extension/lib/util.js';

const media = [
  { id: 'old', kind: 'direct', url: 'https://cdn.example.com/a.mp4', frameId: 0, detectedAt: 100, duration: 600 },
  { id: 'new', kind: 'direct', url: 'https://cdn.example.com/b.mp4', frameId: 0, detectedAt: 200, duration: 900 },
  { id: 'hls', kind: 'hls', url: 'https://cdn.example.com/master.m3u8', frameId: 3, detectedAt: 300, info: { duration: 1325 } },
];

test('pickPlaying: the player whose address is the video wins, even when it is not the newest', () => {
  assert.deepEqual(pickPlaying(media, [{ frameId: 0, src: 'https://cdn.example.com/a.mp4', playing: true, duration: 600 }]), { id: 'old', playing: true });
  // A #t=30 fragment on either side is the same file.
  assert.deepEqual(pickPlaying(media, [{ frameId: 0, src: 'https://cdn.example.com/b.mp4#t=30', playing: false }]), { id: 'new', playing: false });
});

test('pickPlaying: nothing playing, or nothing that matches, gives null', () => {
  assert.equal(pickPlaying(media, []), null);
  assert.equal(pickPlaying(media, [null]), null);
  assert.equal(pickPlaying(media, undefined), null);
  assert.equal(pickPlaying([], [{ frameId: 0, src: 'https://cdn.example.com/a.mp4', playing: true }]), null);
  // An unknown file with an unknown length: no guess.
  assert.equal(pickPlaying(media, [{ frameId: 0, src: 'https://other.example.com/x.mp4', playing: true, duration: 0 }]), null);
});

test('pickPlaying: a stream playing from a blob: address is recognised by its length', () => {
  assert.deepEqual(pickPlaying(media, [{ frameId: 3, src: 'blob:https://player.example.com/1', playing: true, duration: 1325.4 }]), { id: 'hls', playing: true });
  // 1.5 s is the limit: 1326.5 still matches 1325, 1326.6 does not.
  assert.equal(pickPlaying(media, [{ frameId: 9, src: 'blob:x', playing: true, duration: 1326.5 }])?.id, 'hls');
  assert.equal(pickPlaying(media, [{ frameId: 9, src: 'blob:x', playing: true, duration: 1326.6 }]), null);
});

test('pickPlaying: two videos of the same length are told apart by the frame they play in', () => {
  const twins = [
    { id: 'top', kind: 'hls', url: 'https://a/1.m3u8', frameId: 0, detectedAt: 500, info: { duration: 300 } },
    { id: 'framed', kind: 'hls', url: 'https://a/2.m3u8', frameId: 4, detectedAt: 100, info: { duration: 300 } },
  ];
  assert.equal(pickPlaying(twins, [{ frameId: 4, src: 'blob:x', playing: true, duration: 300 }]).id, 'framed');
  assert.equal(pickPlaying(twins, [{ frameId: 0, src: 'blob:x', playing: true, duration: 300 }]).id, 'top');
  // From a third frame it could be either: no guess.
  assert.equal(pickPlaying(twins, [{ frameId: 7, src: 'blob:x', playing: true, duration: 300 }]), null);
});

test('pickPlaying: a playing player beats a paused one, and among paused ones the last started wins', () => {
  const reports = [
    { frameId: 0, src: 'https://cdn.example.com/b.mp4', playing: false, at: 9000 },
    { frameId: 0, src: 'https://cdn.example.com/a.mp4', playing: true, at: 10 },
  ];
  assert.deepEqual(pickPlaying(media, reports), { id: 'old', playing: true });
  const paused = [
    { frameId: 0, src: 'https://cdn.example.com/a.mp4', playing: false, at: 10 },
    { frameId: 0, src: 'https://cdn.example.com/b.mp4', playing: false, at: 9000 },
  ];
  assert.deepEqual(pickPlaying(media, paused), { id: 'new', playing: false });
  // A playing player that matches nothing does not hide a paused one that does.
  assert.equal(pickPlaying(media, [{ frameId: 0, src: 'https://nope/x.mp4', playing: true }, paused[0]]).id, 'old');
});

test('pickPlaying: an embedded player is recognised by the video id in its frame address', () => {
  const embeds = [
    { id: 'yt', kind: 'embed', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', frameId: 0, detectedAt: 1 },
    { id: 'vm', kind: 'embed', url: 'https://vimeo.com/76979871', frameId: 0, detectedAt: 2 },
  ];
  assert.equal(pickPlaying(embeds, [{ frameId: 5, src: 'blob:y', page: 'https://www.youtube.com/embed/dQw4w9WgXcQ?rel=0', playing: true }]).id, 'yt');
  assert.equal(pickPlaying(embeds, [{ frameId: 6, src: 'blob:v', page: 'https://player.vimeo.com/video/76979871', playing: true }]).id, 'vm');
  assert.equal(pickPlaying(embeds, [{ frameId: 6, src: 'blob:v', page: 'https://player.vimeo.com/video/11111111', playing: true }]), null);
});

test('pickPlaying: a stream of unknown length is the newest one loaded by the player\'s frame; playlists and subtitles never match', () => {
  const list = [
    { id: 's1', kind: 'hls', url: 'https://a/1.m3u8', frameId: 2, detectedAt: 10 },
    { id: 's2', kind: 'hls', url: 'https://a/2.m3u8', frameId: 2, detectedAt: 20 },
    { id: 'other', kind: 'hls', url: 'https://a/3.m3u8', frameId: 0, detectedAt: 30 },
    { id: 'pl', kind: 'embed', playlist: true, url: 'https://vimeo.com/showcase/12471493', frameId: 2, detectedAt: 40 },
    { id: 'sub', kind: 'subtitle', url: 'https://a/en.vtt', frameId: 2, detectedAt: 50 },
  ];
  assert.equal(pickPlaying(list, [{ frameId: 2, src: 'blob:x', playing: true, duration: 0 }]).id, 's2');
  assert.equal(pickPlaying(list, [{ frameId: 8, src: 'blob:x', playing: true, duration: 0 }]), null);
  assert.equal(pickPlaying(list, [{ frameId: 2, src: 'https://a/en.vtt', playing: true }]), null);
  assert.equal(pickPlaying(list, [{ frameId: 9, src: '', page: 'https://player.vimeo.com/showcase/12471493/embed', playing: true }]), null);
});
