# Contributing to StreamSnag

Thanks for helping! Bug reports, site fixes, translations and code are all welcome.

## Reporting a bug

1. Turn on **Settings → Backup & advanced → Diagnostic snapshots**.
2. Reload the page where it goes wrong and reproduce the problem.
3. Click **Copy diagnostic report** and paste it into a new issue, together with what you expected to see.
   (Read it first: it contains that page's media URLs. Remove anything private.)

For a download that fails, the popup's **Ask AI why** (if you use AI) or the error text helps too.

## Development setup

```sh
git clone https://github.com/cspergel/streamsnag.git
cd streamsnag
npm install            # dev tools only: tests, the SDK bundler
npm test               # unit tests (node:test), a few seconds
npm run install-helper # register your checkout's helper with your browsers (optional)
node scripts/e2e.js    # end-to-end: loads the extension in a headless Chrome against a local test site
```

Load `extension/` with **Load unpacked** in `chrome://extensions`. After changing the service worker or
content script, click the extension's reload button and reload the page you're testing.

`node scripts/e2e.js` needs Chrome installed. With ffmpeg and the helper registered it also checks real
merging; `E2E_MUX=0` tests the browser-only path. It never contacts real video sites except one public Vimeo
embed (skip with no network: that check fails, the rest still run). Playlist checks use a fake yt-dlp.

## Code guidelines

* **No build step for the extension.** Plain ES modules; only `vendor/` is generated (`npm run build`).
* **Never use `innerHTML` with page data.** The popup's `h()` helper sets text, so page titles can't inject markup.
* **Recipes are data, not code.** Their fetches stay on the page's own site.
* **The helper is a security boundary.** Validate everything that comes from the extension. Start
  programs without a shell, and keep file paths inside the folders the user chose (`safeFolder`, `joinInside`).
* **No DRM circumvention.** StreamSnag detects and refuses Widevine/PlayReady/FairPlay and encrypted HLS.
  Pull requests that bypass protection won't be accepted.
* **Tests that earn their pass.** A new behaviour gets a test that would fail without it. Include the
  boundary and a case that must be rejected, not just the happy path.
* Write user-facing text in plain language; the popup is small, so keep it short.

## Good first contributions

* **Translations**: the interface text is in English inside `popup.*`/`options.*`; moving it to
  `_locales/` with `chrome.i18n` is a welcome project.
* **Firefox support**: the main differences are the offscreen document (Firefox background pages can make
  blob URLs directly), `sidebar_action` instead of `sidePanel`, and the native-messaging manifest location.
* **Site recipes** for sites that need them. Share them as JSON exports in an issue.

## Pull requests

Keep them focused, describe what changed and how you tested it, and run `npm test` (and `node scripts/e2e.js`
if you touched detection, downloads or the popup).
