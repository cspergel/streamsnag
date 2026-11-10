# Changelog

## 1.4.0

* **Playlists:** **List videos** asks yt-dlp for every video in a playlist or Vimeo showcase, so you
  don't have to play each one. **Download missing (N)** then fetches only what isn't in your folders.
  Videos you already played show once.
* **Download queue:** set how many downloads run at once; the rest wait their turn. Failed or canceled
  downloads have **Retry**.
* **Site rules:** a different subfolder or file name per site, with new `{number}` and `{name}` tokens for
  numbered lectures ("009: C. diff" → `009 - C. diff.mp4`).
* **Settings:** tool versions and **Update yt-dlp**; **Backup & advanced** to export or import settings,
  recipes, rules, history and marks; opt-in diagnostic snapshots for bug reports.
* **Fixes:**
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
