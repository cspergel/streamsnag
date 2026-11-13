# StreamSnag

**A free, open-source video downloader for Chrome, Edge and Brave.** StreamSnag finds the video you're
watching and saves it with one click: ordinary files, HLS and DASH streams, the captions as a readable
transcript, and the PDFs and slides the page links to. "Download all" saves a whole course page after you
have checked the list, and StreamSnag knows which videos you already have. No limits, no account, no ads.

Website: [streamsnag.app](https://streamsnag.app) · License: [GPL-3.0](LICENSE) · [Privacy](PRIVACY.md)

> StreamSnag refuses DRM-protected and encrypted video, and is meant for videos you have the right to keep.

## What is in this repository

This is the free downloader, the whole of it, under the GNU General Public License, version 3.

StreamSnag Pro, the study tools (transcription on your computer, the reading edition, study packs,
review cards, mock exams and the study desk), is a separate product, sold at
[streamsnag.app](https://streamsnag.app). Its code is not in this repository, and the downloader never needs it.

## Run it from the source

1. Download this repository (the green **Code** button, then **Download ZIP**, or `git clone`) and unzip it.
2. Open `chrome://extensions` (or `edge://extensions`), turn on **Developer mode**, click **Load unpacked**
   and choose the `extension` folder.
3. Optional: the local helper, a small program that joins a video's picture and sound into one MP4 with
   ffmpeg, saves into any folder and checks your folders for videos you already have. It needs
   [Node.js](https://nodejs.org) 20 or newer.
   * Windows: double-click `Set up StreamSnag helper.cmd`.
   * macOS and Linux: `sh setup.sh`.
   * Then restart the browser and press **Check helper** in StreamSnag's Settings, under Local helper.

Open a page, press play (many players only load the video once it plays) and click the StreamSnag icon.

To update, replace the folder's files with the new ones and press the reload arrow on StreamSnag's card in
`chrome://extensions`; your settings stay. To remove the helper, run `node native-host/install.js --uninstall`.

## Is it safe?

* **You can read all of it.** The extension is plain JavaScript with no build step: the code here is the
  code that runs. The one bundled library is Anthropic's official SDK, used only if you turn on an AI
  feature with your own account.
* **Nothing phones home.** No servers of ours, no accounts, no analytics. [PRIVACY.md](PRIVACY.md) lists
  everything that goes over the network, and when.
* **Why it asks to read the pages you visit:** a video can be on any site, and seeing which media files a
  page loads is how StreamSnag finds them. [PRIVACY.md](PRIVACY.md) explains each permission.
* **The helper is optional** and only talks to StreamSnag. How it is locked down, and how to report a
  problem privately: [SECURITY.md](SECURITY.md).

## Development

```
npm install
npm test
```

The unit tests (in `tests/`) need no network and no browser. Contributions are welcome: see
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

Copyright © 2026 Spergel Health AI LLC.

StreamSnag is free software: you can redistribute it and/or modify it under the terms of the GNU General
Public License as published by the Free Software Foundation, version 3 of the License. It is distributed
in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE) for the full text.

Versions up to 1.4.0 were published under the MIT License, and those copies stay under it.
Not affiliated with any video platform or with Anthropic.
