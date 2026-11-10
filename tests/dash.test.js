import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMPD, parseIsoDuration, fillTemplate, dashExt } from '../extension/lib/dash.js';
import { parseXML } from '../extension/lib/xml.js';

test('ISO durations', () => {
  assert.equal(parseIsoDuration('PT1H2M3.5S'), 3723.5);
  assert.equal(parseIsoDuration('PT30S'), 30);
  assert.equal(parseIsoDuration('P1DT1S'), 86401);
  assert.equal(parseIsoDuration('garbage'), 0);
});

test('template filling with padding and an escaped dollar', () => {
  assert.equal(fillTemplate('seg_$RepresentationID$_$Number%05d$.m4s', { id: 'v1', number: 7 }), 'seg_v1_00007.m4s');
  assert.equal(fillTemplate('t/$Time$/$Bandwidth$' + '$$', { time: 9000, bandwidth: 100 }), 't/9000/100$');
});

const TEMPLATE_MPD = `<?xml version="1.0"?>
<!-- comment -->
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT20S">
  <BaseURL>https://cdn.example.com/movie/</BaseURL>
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <SegmentTemplate timescale="1000" duration="4000" startNumber="1" initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/seg-$Number$.m4s"/>
      <Representation id="720p" bandwidth="2500000" width="1280" height="720" codecs="avc1.64001f"/>
      <Representation id="1080p" bandwidth="5000000" width="1920" height="1080"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="en">
      <Representation id="aud" bandwidth="128000">
        <SegmentTemplate timescale="48000" initialization="a/init.mp4" media="a/$Time$.m4s">
          <SegmentTimeline><S t="0" d="96000" r="2"/><S d="48000"/></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
    <AdaptationSet mimeType="text/vtt" lang="fr"><Representation id="sub-fr" bandwidth="1"><BaseURL>subs/fr.vtt</BaseURL></Representation></AdaptationSet>
  </Period>
</MPD>`;

test('SegmentTemplate with duration: segment count = ceil(period/duration)', () => {
  const mpd = parseMPD(TEMPLATE_MPD, 'https://site.com/manifest.mpd');
  assert.equal(mpd.dynamic, false);
  assert.equal(mpd.protected, false);
  assert.equal(mpd.video.length, 2);
  const best = mpd.video[0];
  assert.equal(best.id, '1080p');
  assert.equal(best.segments.length, 5); // 20s / 4s
  assert.equal(best.init.url, 'https://cdn.example.com/movie/1080p/init.mp4');
  assert.equal(best.segments[0].url, 'https://cdn.example.com/movie/1080p/seg-1.m4s');
  assert.equal(best.segments[4].url, 'https://cdn.example.com/movie/1080p/seg-5.m4s');
  assert.equal(dashExt(best), 'mp4');
});

test('SegmentTimeline expands repeats and tracks $Time$', () => {
  const { audio } = parseMPD(TEMPLATE_MPD, 'https://site.com/manifest.mpd');
  const urls = audio[0].segments.map((s) => s.url.split('/').pop());
  assert.deepEqual(urls, ['0.m4s', '96000.m4s', '192000.m4s', '288000.m4s']);
  assert.equal(audio[0].lang, 'en');
  assert.equal(dashExt(audio[0]), 'm4a');
});

test('subtitle BaseURL-only representation is one whole file', () => {
  const { subtitles } = parseMPD(TEMPLATE_MPD, 'https://site.com/manifest.mpd');
  assert.equal(subtitles.length, 1);
  assert.deepEqual(subtitles[0].segments, [{ url: 'https://cdn.example.com/movie/subs/fr.vtt' }]);
  assert.equal(dashExt(subtitles[0]), 'vtt');
});

test('negative repeat (r=-1) fills until period end', () => {
  const mpd = parseMPD(`<MPD type="static" mediaPresentationDuration="PT10S"><Period><AdaptationSet mimeType="video/mp4">
    <SegmentTemplate timescale="1" media="s$Number$.m4s" startNumber="0"><SegmentTimeline><S t="0" d="2" r="-1"/></SegmentTimeline></SegmentTemplate>
    <Representation id="v" bandwidth="1"/></AdaptationSet></Period></MPD>`, 'https://a.com/m.mpd');
  assert.deepEqual(mpd.video[0].segments.map((s) => s.url.split('/').pop()), ['s0.m4s', 's1.m4s', 's2.m4s', 's3.m4s', 's4.m4s']);
});

test('SegmentList with byte ranges', () => {
  const mpd = parseMPD(`<MPD><Period duration="PT4S"><AdaptationSet mimeType="video/webm"><Representation id="w" bandwidth="1">
    <BaseURL>file.webm</BaseURL><SegmentList><Initialization sourceURL="file.webm" range="0-99"/>
    <SegmentURL media="file.webm" mediaRange="100-199"/><SegmentURL media="file.webm" mediaRange="200-299"/></SegmentList>
    </Representation></AdaptationSet></Period></MPD>`, 'https://a.com/x/m.mpd');
  const v = mpd.video[0];
  assert.deepEqual(v.init.range, { offset: 0, length: 100, end: 99 });
  assert.equal(v.segments.length, 2);
  assert.deepEqual(v.segments[1].range, { offset: 200, length: 100, end: 299 });
  assert.equal(v.segments[0].url, 'https://a.com/x/file.webm');
  assert.equal(dashExt(v), 'webm');
});

test('DRM (ContentProtection) and live (dynamic) are flagged', () => {
  const drm = parseMPD('<MPD><Period><AdaptationSet mimeType="video/mp4"><ContentProtection schemeIdUri="urn:uuid:edef8ba9"/><Representation id="v" bandwidth="1"/></AdaptationSet></Period></MPD>', 'https://a.com/m.mpd');
  assert.equal(drm.protected, true);
  const live = parseMPD('<MPD type="dynamic"><Period/></MPD>', 'https://a.com/m.mpd');
  assert.equal(live.dynamic, true);
  const clean = parseMPD('<MPD><Period><AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1"/></AdaptationSet></Period></MPD>', 'https://a.com/m.mpd');
  assert.equal(clean.protected, false);
});

test('non-MPD XML is rejected', () => {
  assert.throws(() => parseMPD('<html><body/></html>', 'https://a.com/'), /Not a DASH manifest/);
});

test('XML parser: entities, namespaces, CDATA', () => {
  const doc = parseXML('<a:root x:attr="1 &amp; 2"><b><![CDATA[<raw>]]></b><c>&lt;ok&#33;&gt;</c></a:root>');
  assert.equal(doc.name, 'root');
  assert.equal(doc.attrs.attr, '1 & 2');
  assert.equal(doc.children[0].text, '<raw>');
  assert.equal(doc.children[1].text, '<ok!>');
});
