# Changelog

## 1.4.0

* **New look:** the latest video on the page gets a large card with its qualities and one Download
  button; everything else is a compact list with small download buttons, and videos you already have
  fade back with a ✓. AI tools and yt-dlp sit behind one ✨ button, search and sort behind 🔍, and a bar
  at the bottom shows what's downloading. Light and dark mode are now neutral grey, with orange only in the logo.
  A "Finish setup" card appears when the local helper isn't installed, and an empty page explains what
  to try next.
* **Playlists:** **List videos** asks yt-dlp for every video in a playlist or Vimeo showcase, so you
  don't have to play each one. **Download missing (N)** then fetches only what isn't in your folders.
  Videos you already played show once.
* **Download queue:** set how many downloads run at once; the rest wait their turn. Failed or canceled
  downloads have **Retry**.
* **Site rules:** a different subfolder or file name per site, with new `{number}` and `{name}` tokens for
  numbered lectures ("009: C. diff" → `009 - C. diff.mp4`).
* **Settings:** tool versions and **Update yt-dlp**; **Backup & advanced** to export or import settings,
  recipes, rules, history and marks; opt-in diagnostic snapshots for bug reports.
* **Now playing:** the large card shows the video you are actually watching (or the one you paused),
  not just the newest one found on the page. It no longer swaps to another video while the popup is open
  unless you start playing a different one.
* **Smoother popup:** a download's progress now moves without redrawing its card, so a name you are
  typing, a scrolling title or a click on Cancel is no longer lost on every tick. Stream qualities are
  remembered for a minute instead of being re-read each time the popup opens, and are ranked by picture
  height and then bitrate. The big card's name wraps to two lines (click it for the rest), live streams
  say **Record**, and streams the browser can't save itself offer **Try with yt-dlp**.
* **Fixes:**
  * A row's quality list stayed open after its download started, with no way to close it.
  * Long names in the list were not always detected, so they didn't scroll on hover.
  * A downloaded subtitle file could not be downloaded again.
  * "Download again" on a stream gave no sign it was working, and hid the error when the link had expired.
  * Encrypted and live DASH streams showed a Download button that could not work.
  * The "Finish setup" card could appear a moment after the popup opened and push the Download button down.
  * A remembered filter, search or sort no longer shows its controls on pages with fewer than two videos.
  * Browser pages (settings, new tab) now say that StreamSnag can't look at them, instead of "No media found".
  * Listing a playlist could hang when its listing carried an `id` field.
  * Videos fetched through a playlist marked the whole playlist as saved.

## 1.3.x

* The folder check finds downloads by the video's permanent file ID, by name (lecture number plus
  distinctive words), and by a clearly closest length. A file whose name says it is another lecture
  never counts.
* Players that update their title late (Vimeo showcases) no longer give a video the previous one's name.
* Organised list: search, sort, group by tab/section; subtitle files collapsed; **Mark as downloaded**;
  extra folders to check; the sidebar lists the files in your folders.

## 1.2.0

* Vimeo showcases and live events; **Scan again** without reloading; names from the player frame;
  web-component (shadow DOM) players.

## 1.1.0 and earlier

* Sniffing, HLS/DASH downloads, ffmpeg merging, yt-dlp fallback, AI link finding and site recipes, lecture
  names, duplicate merging, custom save folder, side panel.
