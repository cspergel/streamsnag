// B1/B2 (real-site test): the files a stream is made of are read from its manifests, so they are never
// listed as videos of their own. Manifests here have the shape of the ones the real pages served.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMPD } from '../extension/lib/dash.js';
import { parseM3U8 } from '../extension/lib/hls.js';
import { dedupeKey } from '../extension/lib/detect.js';
import { dashParts, hlsParts, isPart, addParts, emptyParts } from '../extension/lib/parts.js';

const key = (u) => dedupeKey(u);

// dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd: one SegmentTemplate per adaptation set, numbered .m4v / .m4a files.
const BBB = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT0H10M34.60S" xmlns="urn:mpeg:dash:schema:mpd:2011">
 <Period>
  <AdaptationSet mimeType="video/mp4" contentType="video">
   <SegmentTemplate media="$RepresentationID$/$RepresentationID$_$Number$.m4v" initialization="$RepresentationID$/$RepresentationID$_0.m4v" startNumber="1" timescale="90000" duration="360000"/>
   <Representation id="bbb_30fps_3840x2160_12000k" bandwidth="14931538" width="3840" height="2160"/>
   <Representation id="bbb_30fps_320x180_200k" bandwidth="254320" width="320" height="180"/>
  </AdaptationSet>
  <AdaptationSet mimeType="audio/mp4" contentType="audio" lang="en">
   <SegmentTemplate media="$RepresentationID$/$RepresentationID$_$Number$.m4a" initialization="$RepresentationID$/$RepresentationID$_0.m4a" startNumber="1" timescale="48000" duration="192000"/>
   <Representation id="bbb_a64k" bandwidth="67071"/>
  </AdaptationSet>
 </Period>
</MPD>`;
const BBB_URL = 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd';

test('DASH SegmentTemplate: every numbered file of every track is a part of the stream, and nothing else is', () => {
  const parts = dashParts(parseMPD(BBB, BBB_URL));
  const dir = 'https://dash.akamaized.net/akamai/bbb_30fps';
  for (const u of [
    `${dir}/bbb_30fps_3840x2160_12000k/bbb_30fps_3840x2160_12000k_2.m4v`,
    `${dir}/bbb_30fps_3840x2160_12000k/bbb_30fps_3840x2160_12000k_18.m4v`,
    `${dir}/bbb_30fps_3840x2160_12000k/bbb_30fps_3840x2160_12000k_0.m4v`, // the init file
    `${dir}/bbb_30fps_320x180_200k/bbb_30fps_320x180_200k_159.m4v`,
    `${dir}/bbb_a64k/bbb_a64k_7.m4a`,
  ]) assert.ok(isPart(parts, key(u)), u);
  for (const u of [
    BBB_URL,
    `${dir}/trailer.m4v`,
    `${dir}/bbb_30fps_3840x2160_12000k/bbb_30fps_3840x2160_12000k_x.m4v`,
    `${dir}/other_rep/other_rep_3.m4v`,
    'https://example.com/akamai/bbb_30fps/bbb_30fps_320x180_200k/bbb_30fps_320x180_200k_3.m4v',
  ]) assert.ok(!isPart(parts, key(u)), u);
  // A ten-minute stream is not stored as hundreds of addresses.
  assert.ok(parts.keys.length + parts.patterns.length <= 12, `${parts.keys.length} keys, ${parts.patterns.length} patterns`);
});

test('DASH live (no length, so no segment list): the template still names the stream\'s files', () => {
  const live = BBB.replace('type="static" mediaPresentationDuration="PT0H10M34.60S"', 'type="dynamic" availabilityStartTime="1970-01-01T00:00:00Z"');
  const parts = dashParts(parseMPD(live, 'https://livesim2.example/testpic_2s/Manifest.mpd'));
  assert.ok(isPart(parts, key('https://livesim2.example/testpic_2s/bbb_30fps_320x180_200k/bbb_30fps_320x180_200k_881234567.m4v')));
});

test('DASH $Time$ addressing and a signed link: later segments and a fresh signature are still the stream\'s own', () => {
  const mpd = `<MPD type="static" mediaPresentationDuration="PT20S"><Period><AdaptationSet mimeType="video/mp4">
    <SegmentTemplate media="chunk-$RepresentationID$-$Time$.mp4?token=abc" initialization="init-$RepresentationID$.mp4?token=abc" timescale="1000">
      <SegmentTimeline><S t="0" d="5000" r="3"/></SegmentTimeline></SegmentTemplate>
    <Representation id="v1" bandwidth="800000" height="360"/></AdaptationSet></Period></MPD>`;
  const parts = dashParts(parseMPD(mpd, 'https://cdn.example/a/manifest.mpd'));
  assert.ok(isPart(parts, key('https://cdn.example/a/chunk-v1-15000.mp4?token=zzz')));
  assert.ok(isPart(parts, key('https://cdn.example/a/init-v1.mp4?token=other')));
  assert.ok(!isPart(parts, key('https://cdn.example/a/chunk-v2-15000.mp4')));
});

// storage.googleapis.com/shaka-demo-assets/angel-one-widevine/dash.mpd: each track is one whole file (BaseURL + SegmentBase).
const ANGEL = `<MPD type="static" mediaPresentationDuration="PT60S"><Period>
  <AdaptationSet contentType="video"><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
    <Representation id="1" bandwidth="1000000" height="576" mimeType="video/webm" codecs="vp9"><BaseURL>v-0576p-1000k-vp9.webm</BaseURL><SegmentBase indexRange="300-500"><Initialization range="0-299"/></SegmentBase></Representation>
    <Representation id="2" bandwidth="750000" height="480" mimeType="video/mp4" codecs="avc1.4d401e"><BaseURL>v-0480p-0750k-libx264.mp4</BaseURL><SegmentBase indexRange="800-900"><Initialization range="0-799"/></SegmentBase></Representation>
  </AdaptationSet>
  <AdaptationSet contentType="audio" lang="en"><Representation id="3" bandwidth="128000" mimeType="audio/mp4"><BaseURL>a-eng-0128k-aac-2c.mp4</BaseURL><SegmentBase indexRange="700-800"/></Representation></AdaptationSet>
  <AdaptationSet contentType="text" lang="en"><Representation id="4" mimeType="text/vtt"><BaseURL>t-en.vtt</BaseURL></Representation></AdaptationSet>
</Period></MPD>`;

test('DASH BaseURL / SegmentBase (and a protected stream): each track\'s one file is a part, the text track included', () => {
  const mpd = parseMPD(ANGEL, 'https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine/dash.mpd');
  assert.equal(mpd.protected, true);
  const parts = dashParts(mpd);
  const dir = 'https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine';
  for (const f of ['v-0576p-1000k-vp9.webm', 'v-0480p-0750k-libx264.mp4', 'a-eng-0128k-aac-2c.mp4', 't-en.vtt']) assert.ok(isPart(parts, key(`${dir}/${f}`)), f);
  assert.ok(!isPart(parts, key(`${dir}/poster.mp4`)));
});

test('DASH SegmentList with byte ranges: the file the ranges are cut from is a part', () => {
  const mpd = `<MPD type="static" mediaPresentationDuration="PT8S"><Period><AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1" height="240">
    <SegmentList><Initialization sourceURL="clip/all.mp4" range="0-799"/><SegmentURL media="clip/all.mp4" mediaRange="800-9999"/><SegmentURL media="clip/all.mp4" mediaRange="10000-19999"/></SegmentList>
  </Representation></AdaptationSet></Period></MPD>`;
  const parts = dashParts(parseMPD(mpd, 'https://x.example/m.mpd'));
  assert.deepEqual(parts.keys, [key('https://x.example/clip/all.mp4')]);
});

// devstreaming-cdn.apple.com/…/img_bipbop_adv_example_fmp4: each quality is one main.mp4 read by byte ranges.
const FMP4 = ['#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXT-X-VERSION:7', '#EXT-X-MEDIA-SEQUENCE:1', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS',
  '#EXT-X-MAP:URI="main.mp4",BYTERANGE="719@0"', '#EXTINF:6.00000,', '#EXT-X-BYTERANGE:1508000@719', 'main.mp4', '#EXTINF:6.00000,', '#EXT-X-BYTERANGE:1510244@1508719', 'main.mp4', '#EXT-X-ENDLIST'].join('\n');

test('HLS fMP4 with EXT-X-MAP and byte ranges: the one file behind the playlist is a part', () => {
  const pl = parseM3U8(FMP4, 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/v9/prog_index.m3u8');
  const parts = hlsParts(pl);
  assert.deepEqual(parts.keys, [key('https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/v9/main.mp4')]);
  assert.ok(!isPart(parts, key('https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/v4/main.mp4')), 'another quality is in its own playlist');
});

test('HLS with numbered fMP4 pieces: the init file and every piece, also ones that come later in a live stream', () => {
  const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:120', '#EXT-X-MAP:URI="init.mp4"'];
  for (let i = 120; i < 150; i++) lines.push('#EXTINF:4.0,', `seg-${i}.mp4?sig=a${i}`);
  const parts = hlsParts(parseM3U8(lines.join('\n'), 'https://live.example/ch1/video.m3u8'));
  assert.ok(isPart(parts, key('https://live.example/ch1/init.mp4')));
  assert.ok(isPart(parts, key('https://live.example/ch1/seg-121.mp4?sig=zz')));
  assert.ok(isPart(parts, key('https://live.example/ch1/seg-9001.mp4')), 'a later piece of the same run');
  assert.ok(!isPart(parts, key('https://live.example/ch1/trailer.mp4')));
  assert.ok(!isPart(parts, key('https://live.example/ch2/seg-121.mp4')));
  assert.ok(parts.keys.length + parts.patterns.length <= 3, 'thirty pieces are kept as one pattern');
});

test('an HLS master\'s parts are its playlists (video, sound, subtitles); pieces that can never be listed are not stored', () => {
  const master = ['#EXTM3U', '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",URI="a1/prog_index.m3u8"', '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="English",LANGUAGE="en",URI="s1/en/prog_index.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=960x540,AUDIO="a",SUBTITLES="s"', 'v5/prog_index.m3u8'].join('\n');
  const m = hlsParts(parseM3U8(master, 'https://x.example/master.m3u8'));
  assert.deepEqual([...m.keys].sort(), ['https://x.example/a1/prog_index.m3u8', 'https://x.example/s1/en/prog_index.m3u8', 'https://x.example/v5/prog_index.m3u8']);
  const ts = ['#EXTM3U', '#EXT-X-TARGETDURATION:4', ...Array.from({ length: 500 }, (_, i) => `#EXTINF:4,\nhash${(i * 7919).toString(36)}x.ts`), '#EXT-X-ENDLIST'].join('\n');
  const t = hlsParts(parseM3U8(ts, 'https://x.example/v/1.m3u8'));
  assert.equal(t.keys.length + t.patterns.length, 0, '.ts pieces are never classified as a video, so nothing is kept for them');
});

test('parts add up across manifests, once each, and stay within their caps', () => {
  const into = emptyParts();
  addParts(into, { keys: ['a', 'b'], patterns: [['p', '.m4s']] });
  addParts(into, { keys: ['b', 'c'], patterns: [['p', '.m4s'], ['q', '.mp4']] });
  assert.deepEqual([...into.keys], ['a', 'b', 'c']);
  assert.deepEqual(into.patterns, [['p', '.m4s'], ['q', '.mp4']]);
  assert.ok(isPart(into, 'p12.m4s') && !isPart(into, 'p.m4s') && !isPart(into, 'p1a.m4s'));
});
