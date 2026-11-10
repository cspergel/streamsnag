// HLS (.m3u8) playlist parser — master and media playlists.
import { resolveUrl } from './util.js';

/** Parse an attribute list: KEY=VALUE,KEY="quoted, value",... */
export function parseAttributes(str) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
  let m;
  while ((m = re.exec(str))) {
    let v = m[2];
    if (v.startsWith('"')) v = v.slice(1, -1);
    out[m[1].toUpperCase()] = v;
  }
  return out;
}

function parseByteRange(str, prevEnd) {
  // "length[@offset]"
  const m = /^(\d+)(?:@(\d+))?$/.exec(String(str).trim());
  if (!m) return null;
  const length = Number(m[1]);
  const offset = m[2] != null ? Number(m[2]) : prevEnd ?? 0;
  return { offset, length, end: offset + length - 1 };
}

/** True when an EXT-X-KEY/EXT-X-SESSION-KEY line means the stream is encrypted/DRM'd. */
function isProtectedKey(attrs) {
  const method = String(attrs.METHOD || 'NONE').toUpperCase();
  return method !== 'NONE';
}

/**
 * @returns {{type:'master', variants:any[], audio:any[], subtitles:any[], protected:boolean}
 *         | {type:'media', segments:any[], init:any, targetDuration:number, mediaSequence:number,
 *            endList:boolean, protected:boolean, keyMethod:string|null, totalDuration:number, segmentExt:string}}
 */
export function parseM3U8(text, baseUrl) {
  const raw = String(text || '').replace(/^﻿/, '');
  if (!/^\s*#EXTM3U/.test(raw)) throw new Error('Not an HLS playlist (missing #EXTM3U)');
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) return parseMaster(lines, baseUrl);
  return parseMedia(lines, baseUrl);
}

function parseMaster(lines, baseUrl) {
  const variants = [];
  const audio = [];
  const subtitles = [];
  let isProtected = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-SESSION-KEY')) {
      if (isProtectedKey(parseAttributes(line.slice(line.indexOf(':') + 1)))) isProtected = true;
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttributes(line.slice(13));
      const r = {
        groupId: a['GROUP-ID'] || '',
        name: a.NAME || a.LANGUAGE || '',
        language: a.LANGUAGE || '',
        isDefault: a.DEFAULT === 'YES',
        url: a.URI ? resolveUrl(a.URI, baseUrl) : null,
      };
      if (a.TYPE === 'AUDIO') audio.push(r);
      else if (a.TYPE === 'SUBTITLES') subtitles.push(r);
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttributes(line.slice(18));
      // The URI is the next non-tag line.
      let j = i + 1;
      while (j < lines.length && lines[j].startsWith('#')) j++;
      if (j >= lines.length) break;
      const res = /^(\d+)x(\d+)$/i.exec(a.RESOLUTION || '');
      variants.push({
        url: resolveUrl(lines[j], baseUrl),
        bandwidth: Number(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH) || 0,
        width: res ? Number(res[1]) : 0,
        height: res ? Number(res[2]) : 0,
        codecs: a.CODECS || '',
        frameRate: Number(a['FRAME-RATE']) || 0,
        audioGroup: a.AUDIO || '',
        subtitleGroup: a.SUBTITLES || '',
      });
      i = j;
    }
  }
  variants.sort((x, y) => y.height - x.height || y.bandwidth - x.bandwidth);
  return { type: 'master', variants, audio, subtitles, protected: isProtected };
}

function parseMedia(lines, baseUrl) {
  const segments = [];
  let init = null;
  let targetDuration = 0;
  let mediaSequence = 0;
  let endList = false;
  let isProtected = false;
  let keyMethod = null;
  let pendingDuration = null;
  let pendingRange = null;
  let prevEnd = null;
  let playlistType = '';

  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      pendingDuration = parseFloat(line.slice(8)) || 0;
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number(line.slice(22)) || 0;
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number(line.slice(22)) || 0;
    } else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
      playlistType = line.slice(21).toUpperCase();
    } else if (line === '#EXT-X-ENDLIST') {
      endList = true;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttributes(line.slice(11));
      if (isProtectedKey(a)) {
        isProtected = true;
        keyMethod = String(a.METHOD).toUpperCase();
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttributes(line.slice(11));
      if (a.URI) {
        init = { url: resolveUrl(a.URI, baseUrl), range: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null };
      }
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = parseByteRange(line.slice(17), prevEnd);
    } else if (!line.startsWith('#')) {
      const seg = {
        url: resolveUrl(line, baseUrl),
        duration: pendingDuration ?? 0,
        sequence: mediaSequence + segments.length,
      };
      if (pendingRange) {
        seg.range = pendingRange;
        prevEnd = pendingRange.end + 1;
      }
      segments.push(seg);
      pendingDuration = null;
      pendingRange = null;
    }
  }
  if (playlistType === 'VOD') endList = true;
  const totalDuration = segments.reduce((s, x) => s + x.duration, 0);
  const firstExt = segments.length ? (/\.([a-z0-9]{1,5})(?:$|[?#])/i.exec(segments[0].url)?.[1] || '').toLowerCase() : '';
  return {
    type: 'media', segments, init, targetDuration, mediaSequence, endList,
    protected: isProtected, keyMethod, totalDuration, segmentExt: firstExt,
  };
}

/** Pick the output container for a media playlist. */
export function outputExtForMedia(media, role = 'video') {
  if (media.init) return role === 'audio' ? 'm4a' : 'mp4';
  if (['aac', 'mp3', 'ac3', 'ec3'].includes(media.segmentExt)) return media.segmentExt;
  if (media.segmentExt === 'vtt' || media.segmentExt === 'webvtt') return 'vtt';
  return 'ts';
}
