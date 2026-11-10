import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseM3U8, parseAttributes, outputExtForMedia } from '../extension/lib/hls.js';

const MASTER = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio/en.m3u8"',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Deutsch",LANGUAGE="de",URI="subs/de.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="aud",SUBTITLES="subs"',
  'low/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=5000000,AVERAGE-BANDWIDTH=4500000,RESOLUTION=1920x1080,FRAME-RATE=60,AUDIO="aud"',
  'https://other.cdn.com/hi/index.m3u8',
].join('\n');

test('master playlist: variants sorted best-first, relative + absolute URIs resolved', () => {
  const pl = parseM3U8(MASTER, 'https://site.com/vod/master.m3u8?sig=abc');
  assert.equal(pl.type, 'master');
  assert.equal(pl.variants.length, 2);
  assert.equal(pl.variants[0].height, 1080);
  assert.equal(pl.variants[0].bandwidth, 4500000); // AVERAGE-BANDWIDTH preferred
  assert.equal(pl.variants[0].frameRate, 60);
  assert.equal(pl.variants[0].url, 'https://other.cdn.com/hi/index.m3u8');
  assert.equal(pl.variants[1].url, 'https://site.com/vod/low/index.m3u8');
  assert.equal(pl.variants[1].codecs, 'avc1.4d401e,mp4a.40.2'); // quoted comma kept
  assert.equal(pl.audio[0].url, 'https://site.com/vod/audio/en.m3u8');
  assert.equal(pl.audio[0].isDefault, true);
  assert.equal(pl.subtitles[0].language, 'de');
  assert.equal(pl.protected, false);
});

test('media playlist with fMP4 init, byte ranges and ENDLIST', () => {
  const text = [
    '#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXT-X-MEDIA-SEQUENCE:100',
    '#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"',
    '#EXTINF:6.0,', '#EXT-X-BYTERANGE:1000@720', 'video.mp4',
    '#EXTINF:4.5,', '#EXT-X-BYTERANGE:2000', 'video.mp4',
    '#EXT-X-ENDLIST',
  ].join('\n');
  const pl = parseM3U8(text, 'https://a.com/v/main.m3u8');
  assert.equal(pl.type, 'media');
  assert.equal(pl.endList, true);
  assert.deepEqual(pl.init, { url: 'https://a.com/v/init.mp4', range: { offset: 0, length: 720, end: 719 } });
  assert.deepEqual(pl.segments[0].range, { offset: 720, length: 1000, end: 1719 });
  // the second range has no offset, so it continues right after the previous one
  assert.deepEqual(pl.segments[1].range, { offset: 1720, length: 2000, end: 3719 });
  assert.equal(pl.segments[1].sequence, 101);
  assert.equal(pl.totalDuration, 10.5);
  assert.equal(outputExtForMedia(pl, 'video'), 'mp4');
  assert.equal(outputExtForMedia(pl, 'audio'), 'm4a');
});

test('live playlist (no ENDLIST) and TS output', () => {
  const pl = parseM3U8('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nlive1.ts\n#EXTINF:2,\nlive2.ts\n', 'https://a.com/live.m3u8');
  assert.equal(pl.endList, false);
  assert.equal(pl.segments.length, 2);
  assert.equal(outputExtForMedia(pl), 'ts');
});

test('PLAYLIST-TYPE:VOD counts as complete even without ENDLIST', () => {
  const pl = parseM3U8('#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:2,\na.ts\n', 'https://a.com/x.m3u8');
  assert.equal(pl.endList, true);
});

test('encryption is flagged; METHOD=NONE is not', () => {
  const enc = parseM3U8('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST', 'https://a.com/x.m3u8');
  assert.equal(enc.protected, true);
  assert.equal(enc.keyMethod, 'AES-128');
  const drm = parseM3U8('#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://x"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8', 'https://a.com/m.m3u8');
  assert.equal(drm.protected, true);
  const clear = parseM3U8('#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:2,\na.ts\n', 'https://a.com/x.m3u8');
  assert.equal(clear.protected, false);
});

test('rejects non-playlists', () => {
  assert.throws(() => parseM3U8('<html></html>', 'https://a.com/'), /Not an HLS playlist/);
});

test('parseAttributes keeps commas inside quotes', () => {
  assert.deepEqual(parseAttributes('A=1,B="x,y",C=z'), { A: '1', B: 'x,y', C: 'z' });
});
