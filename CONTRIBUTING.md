# Contributing to StreamSnag

Thanks for helping! Bug reports, site fixes, translations and code are all welcome.

## Reporting a bug

1. Turn on **Settings → Backup & advanced → Keep a diagnostic snapshot of the last page**.
2. Reload the page where it goes wrong and reproduce the problem.
3. Click **Copy diagnostic report** and paste it into a new issue, together with what you expected to see.
   (Read it first: it contains that page's media addresses. Remove anything private.)

## Development setup

```sh
git clone https://github.com/cspergel/streamsnag.git
cd streamsnag
npm install            # dev tools only: the tests and the SDK bundler
npm test               # the unit tests (node:test), a few seconds, no network
npm run install-helper # register your checkout's helper with your browsers (optional)
```

Load `extension/` with **Load unpacked** in `chrome://extensions`. After changing the service worker or a
content script, press the extension's reload button and reload the page you're testing.

## Code guidelines

* **No build step for the extension.** Plain ES modules; only `vendor/` is generated (`npm run build`).
* **Never use `innerHTML` with page data.** The popup's `h()` helper sets text, so a page's titles can't inject markup.
* **Site recipes are data, not code.** Their fetches stay on the page's own site.
* **The helper is a security boundary.** Check everything that comes from the extension. Start programs
  without a shell, and keep file paths inside the folders the user chose (`safeFolder`, `joinInside`).
* **No DRM circumvention.** StreamSnag detects and refuses Widevine, PlayReady, FairPlay and encrypted HLS.
  Pull requests that get round protection won't be accepted.

## Good first contributions

* **Translations**: the interface text is in English inside `popup.*` and `options.*`; moving it to
  `_locales/` with `chrome.i18n` is a welcome project.
* **Site recipes** for sites that need them. Share them as JSON exports in an issue.

## Pull requests

Keep them focused, describe what changed and how you tested it, and run `npm test`.

## Licensing of contributions

StreamSnag's downloader is published under the GNU General Public License, version 3, and is also part of
StreamSnag Pro, which is sold under its own licence. So that a contribution can go into both, by opening a
pull request you confirm that the contribution is your own work, and you agree that it is licensed under
GPL-3.0 and that Spergel Health AI LLC may also distribute it, changed or unchanged, under other terms as
part of StreamSnag.
