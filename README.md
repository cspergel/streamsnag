# StreamSnag: a video download helper for Chrome

A personal Chrome extension in the spirit of Video DownloadHelper. It finds the videos, audio, streams and
subtitles a page loads and saves them with one click. It can also use **Claude** (your subscription or
an API key) to find links that plain sniffing misses, and to write reusable **site recipes** so those
sites work without AI next time.

## Features

| | |
|---|---|
| **Sniffing** | Watches network responses and the DOM (`<video>`, `<source>`, `<track>`, `og:video`). It finds progressive files (mp4/webm/mov/mp3/m4a…), HLS `.m3u8`, DASH `.mpd`, and `.vtt`/`.srt` subtitles. It filters out segments and tiny files, and the badge shows the count. |
| **HLS** | Lists qualities best-first. Downloads segments in parallel with retries, then merges them into one `.ts` (or `.mp4` for fMP4). Handles byte ranges, separate audio renditions and subtitle tracks. |
| **Live recording** | Records live HLS until you click **Stop & save**. |
| **DASH** | SegmentTemplate (`$Number$`/`$Time$`/timeline), SegmentList and single-file representations. Video, audio and subtitles are saved as tracks. |
| **Referer handling** | Adds session-scoped `declarativeNetRequest` rules, so CDNs that require the page as Referer/Origin accept the extension's requests. |
| **Subtitles** | Saves stream subtitles next to the video, merges VTT segments and converts SRT. |
| **ffmpeg (via helper)** | Runs automatically when a download finishes. Separate video, audio and subtitles become **one** MP4/MKV with soft subtitles embedded, and `.ts` becomes `.mp4`. Nothing is re-encoded, so it takes seconds. The leftover pieces are deleted. The helper finds ffmpeg/yt-dlp even when Chrome's PATH is older than the install. |
| **yt-dlp (via helper)** | One-click fallback for sites the browser can't handle (popup → **yt-dlp**, or right-click). |
| **Popup & sidebar** | Long names scroll across when you hover (click to show the full name, or hover for a tooltip). Every item is tagged **✓ Downloaded / Not downloaded**, and filters show only one group. The sidebar button opens a side panel that stays open and follows your active tab. It shows type, size, length, where the item was found, when it was saved, the full URL and the download history. |
| **Lecture / episode names** | Files are named after the specific video, not the site-wide tab title. The name comes from the highlighted lesson in a course sidebar, the heading by the player, the player's own label, or the page's video data. It's read when each video is detected, so lectures that load without a page reload keep their own names. Tokens `{title}` (video name), `{course}` and `{page}` work in the file name template. Use **⋯ → Rename** to override. |
| **Duplicates** | The same video seen under several links is shown once. That covers re-signed CDN links (CloudFront, S3, Akamai, Vimeo…), a page link that redirects to the real file, an identical copy on another server, and the same stream listed again. **⋯ → Remove from list** hides anything else, and **Show again** undoes it. |
| **Embedded players** | Finds Vimeo, Wistia, YouTube, Loom and similar players, even in tabs or accordions that were never opened. Vimeo and Wistia are resolved to their real stream and title from the player's public config. Others are offered to yt-dlp. |
| **Vimeo showcases & events** | A showcase (playlist) embed becomes one **Download all** item: yt-dlp saves every video in it into its own folder, numbered in playlist order, and skips any that fail. Live-event recordings work the same way. A video played inside a player frame is named from that player (e.g. the showcase clip), with the page heading as the course. |
| **Scan again** | Re-checks the page and every frame without reloading it. It also looks inside web components (shadow DOM), re-adds StreamSnag to frames opened before the extension was reloaded, re-resolves embedded players, re-runs the site recipe and re-checks your folder. It reports how many new items it found. |
| **Already downloaded?** | When a page loads or reloads, the helper checks your folders: the save folder, Downloads, any folders you add (popup → **Add folder…**, or Settings → Downloads), and wherever StreamSnag saved before, 6 levels deep. A video counts as downloaded if a file there is the one StreamSnag saved (even renamed), has exactly the same size, has the video's id in its name (`… [123456789].mp4`, as yt-dlp names files), has the same length (measured once with ffprobe and cached; a copy saved twice still counts), or carries the video's own name (unless another video on the page shares it, or the file's length says otherwise). Use **⋯ → Mark as downloaded** (or **Mark as not downloaded**) when it still guesses wrong. **Check now** re-checks at once, and the sidebar lists every file it found, searchable. Files you deleted show **File not in folder**. |
| **Organising the list** | Search by name; sort by streams first, order found, name, not-downloaded first or length; or group by the page's tabs/sections. Subtitle files are collapsed into one group under the videos, since stream downloads already include their subtitles. |
| **Save folder** | Settings → Downloads → **Save to**: any folder on your PC (**Browse…** opens a folder picker). Chrome can only save inside Downloads, so the helper moves each finished file there. The subfolder can be nested and use `{site}` `{date}` `{kind}`, e.g. `StreamSnag/{site}`. |
| **Power-user tools** | Copy the URL, a ready-made `yt-dlp` command or an `ffmpeg` command per item. Right-click a video to download it. **Alt+Shift+D** opens the popup. Filename templates, download history, notifications. |

### AI features (optional)

* **Find with AI**: Claude reads the page's network log, video and iframe elements, inline player configs and
  JSON-LD. It returns real media URLs (added to the list), player-iframe pages to open, and advice.
* **Site recipes**: in the same pass, Claude writes a declarative recipe (CSS selectors, regexes, same-site
  fetches). StreamSnag test-runs it immediately. Save it and it runs automatically on that site from then on,
  with no AI needed. You can view, edit, import and export recipes in **Settings → Site recipes**. Recipes are
  data, never code, and fetch rules can only call the page's own site.
* **Ask AI why**: on a failed download, Claude diagnoses the cause (expired signed URL, Referer, login, DRM…)
  and lists fixes.
* **Summarize**: summarizes a video from its captions with timestamped key points. You can save it as `.md`.
* **AI filenames** (opt-in): turns messy page titles into clean file names.

**Two ways to run the AI** (Settings → AI):

1. **Your Claude subscription (Pro/Max)**: goes through the Claude Code CLI on your PC via the local helper.
   No API billing. Each call is lean (custom system prompt, no tools, none of your Claude Code
   plugins or settings), about 1k tokens of overhead.
2. **Anthropic API key**: uses the official `@anthropic-ai/sdk` (bundled into `extension/vendor/`). Default
   model is Claude Opus 5.5, with server-side refusal fallback enabled. You can pick Sonnet/Haiku for lower cost.

## Install

```powershell
npm install          # dev deps: SDK bundler, tests
npm run build        # bundles the Anthropic SDK + generates icons (already done in this repo)
```

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the `extension` folder.
   The manifest has a fixed `key`, so the extension ID is always `belmpcifalnphmlagobkbidoadhdpgkm`.
2. Optional, for subscription AI, ffmpeg and yt-dlp:
   ```powershell
   npm i -g @anthropic-ai/claude-code   # then run `claude` once and sign in
   winget install Gyan.FFmpeg yt-dlp.yt-dlp
   npm run install-helper               # registers the native helper for Chrome/Edge/Brave
   ```
   Restart Chrome, then open **Settings → Local helper → Check helper**.
   To remove it: `npm run uninstall-helper`.

## Use

Open a page and press play (many players only request the stream once playback starts), then click the
StreamSnag icon. Use **Download** on files, or **Download ▾** on streams to pick a quality, audio-only or subtitles.
If nothing shows up, try **Find with AI**, or **yt-dlp** if you have the helper.

## Limits

* **No DRM or encrypted streams.** Widevine/PlayReady/FairPlay, and HLS with `EXT-X-KEY`, are detected and refused.
* Stream downloads are assembled in memory (as Blob parts that Chrome can page to disk). Very long 4K streams are better
  handled by yt-dlp.
* Live DASH isn't supported in-browser (use yt-dlp). Only the first DASH period is downloaded.
* Only download content you have the right to save.

## Develop

```
extension/
  manifest.json      MV3 manifest (fixed key → stable ID for the native helper)
  background.js      service worker: sniffing, per-tab state, jobs, AI, helper, context menus
  offscreen.js       parallel segment fetcher → Blob → blob: URL (service workers can't make object URLs)
  content.js         DOM scan + page snapshots for recipes/AI
  popup.*            toolbar UI        options.*   settings, recipes editor, history
  lib/               detect, hls, dash, xml, vtt, recipes, ai (prompts/schemas), ai-transport, headers, util
  vendor/            bundled @anthropic-ai/sdk
native-host/         host.js (claude / ffmpeg / yt-dlp bridge), protocol.js, install.js
scripts/             build-sdk.js, make-icons.js, e2e.js
tests/               node:test unit tests
```

* `npm test`: 77 unit tests (including a real ffmpeg merge when ffmpeg is installed) (parsers, detection thresholds, recipe engine and its same-site guard, AI
  output validation, native-messaging framing, helper process, shell-quoting guard).
* `node scripts/e2e.js`: loads the real extension into an isolated headless Chrome profile against a local test
  site. It checks detection, quality listing, the Referer rule, segment merging, file naming, the popup and the downloaded bytes.
  `E2E_AI=subscription node scripts/e2e.js` also runs the AI flow through your Claude subscription. It checks that
  a video hidden in a player config is found and that the generated recipe works.
