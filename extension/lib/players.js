// A player in a frame (Vimeo, Wistia) and the video it has loaded itself are one thing to list, never two:
// which frames are a player's own, which listed item is its video, and which listed item is only its
// placeholder. Pure helpers shared by the service worker and tests.

/** Host and path of an address ("player.vimeo.com/video/1"), or '' for none: what a player's frame is known by. */
export function playerAt(url) {
  try {
    const x = new URL(String(url || ''));
    return /^https?:$/.test(x.protocol) ? `${x.host}${x.pathname}` : '';
  } catch {
    return '';
  }
}

/**
 * The ids of the frames that are the player's own: the frame at the player's address and every frame
 * inside it (a player may play in a frame of its own). `frames`: [{ frameId, parentFrameId, url }], as the
 * browser lists a tab's frames. The page itself (frame 0) is never a player's frame.
 */
export function playerFrames(frames, playerUrl) {
  const want = playerAt(playerUrl);
  const out = new Set();
  if (!want || !Array.isArray(frames)) return out;
  const byId = new Map(frames.map((f) => [f.frameId, f]));
  for (const f of frames) {
    let at = f;
    for (let i = 0; at && at.frameId > 0 && i < 6; i++) {
      if (playerAt(at.url) === want) { out.add(f.frameId); break; }
      at = byId.get(at.parentFrameId);
    }
  }
  return out;
}

/**
 * The video a player has loaded itself: an item seen on the network from inside one of the player's own
 * frames (a stream or a file; never a caption file, a hidden part of a stream, or another player). Null
 * when the player has loaded nothing that is listed.
 */
export function playerVideo(media, frames, playerUrl) {
  const own = playerFrames(frames, playerUrl);
  if (!own.size) return null;
  return (media || []).find((m) => m.frameId > 0 && own.has(m.frameId) && m.source === 'network'
    && m.kind !== 'subtitle' && m.kind !== 'embed' && !m.hidden) || null;
}

/**
 * The placeholder of the player at `playerUrl`, if one is listed: the player itself as an item (kind
 * 'embed'), never a showcase of many videos. `mayJoin(m)`: is this the kind of player whose video
 * StreamSnag lists (so a player it cannot see inside is never taken for one).
 */
export function playerPlaceholder(media, playerUrl, mayJoin = () => true) {
  const want = playerAt(playerUrl);
  if (!want) return null;
  return (media || []).find((m) => m.kind === 'embed' && !m.playlist && playerAt(m.url) === want && mayJoin(m)) || null;
}

/**
 * The placeholder gives way to the player's video: it leaves the list, and what it alone knew goes to the
 * video (a name you gave it, the part of the page it is in). Returns the list without the placeholder.
 */
export function joinPlayer(media, placeholder, video) {
  if (!placeholder || !video || placeholder === video) return media;
  if (placeholder.customName && !video.customName) video.customName = placeholder.customName;
  if (placeholder.section && !video.section) video.section = placeholder.section;
  return media.filter((m) => m !== placeholder);
}
