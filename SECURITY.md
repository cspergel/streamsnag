# Security

StreamSnag's local helper can run programs (ffmpeg, yt-dlp, the Claude CLI) and move files on your
computer, so security reports are taken seriously.

## Reporting a vulnerability

Please **don't open a public issue**. Use GitHub's private reporting instead: on the repository page, go to
**Security → Report a vulnerability**. Include what you found, how to reproduce it, and what an attacker could
do with it. You'll get a reply as soon as possible, and credit in the release notes if you'd like.

## What is in scope

* A web page (or its content, URLs, titles, or a site recipe) making the extension or helper run commands,
  write or delete files outside the folders you chose, or reach other sites.
* Leaking your API key, history or file paths to anyone other than you (and, for AI features you turned on,
  Anthropic), or your licence key to anyone but Lemon Squeezy.
* Anything that lets another extension or program talk to the helper.

## Design notes for reviewers

* Web pages (through content scripts) can only *report* what they found. The worker ignores every other
  message unless it comes from StreamSnag's own pages, and it takes the frame from Chrome, not from the page.
* Nothing is fetched automatically from local-network addresses on behalf of a public page. A
  declarativeNetRequest rule blocks the extension's own requests to them (redirects and preview images
  included); hosts are let through only for a page that is itself local or an item you clicked. This goes
  by the address, so a public name that resolves to a local IP is not caught.
* Backups are treated as untrusted: imported folders and history paths must be plain local paths (no
  network shares), history links must be http(s), and recipes are re-validated.
* Copied `yt-dlp`/`ffmpeg` commands percent-encode anything a shell could expand, so pasting them into
  PowerShell, bash or cmd can't run code hidden in a URL.
* The helper only accepts connections from StreamSnag's extension ID (`allowed_origins` in its manifest).
  That ID comes from a public key, so it is not a secret: the helper also validates every request.
* The Windows folder picker gets its start folder through an environment variable, never inside the script.
* "Add a video" / "Add a folder": what the user may work on is recorded only by the helper, and only after
  its own system dialog (`pickOwn`) is answered; the extension cannot add to that list. Every request about
  those files (`checkOwn`, and the worker's study-pack, study-page, reading-edition and transcription
  requests for a file) is refused unless the file's real path (links resolved) is the file that was added,
  or directly inside an added folder (or in its subfolders when that was ticked). A downloaded file is
  allowed only when it is in StreamSnag's own download history (or found by the folder check with exactly a
  download's size). Listing never follows hidden or system folders and is bounded in depth and number.
* Next to a video the helper reads only files it names from the video's own name: captions
  (`<name>.vtt`, `<name>.<language>.vtt`, `<name>.srt`, plain files, at most 5 MB) and slides
  (`<name>.slides.pdf|pptx`, `<name>.pdf|pptx`, plain files, at most 60 MB). The caller names the video,
  never the other file, and the existing video/audio checks (`checkMedia`) apply. Subtitles inside a video
  are written next to it as `<name>.vtt` only when no such file exists.
* "Open StreamSnag in the sidebar" only switches the toolbar button between the popup and the side panel
  (`chrome.action.setPopup`, `chrome.sidePanel.setPanelBehavior`).
* Commands are started without a shell; arguments for `.cmd` shims are quoted and anything cmd.exe could
  interpret is refused (`cmdShimCommandLine`).
* Output folders are validated (`safeFolder`) and subfolders/file names can't leave them (`joinInside`,
  `safeOutputName`, `ytdlpSafeName`).
* Site recipes are data, never code, and their fetches are limited to the page's own site. An AI answer may
  only point at the page's own site or at a server the page itself names or has contacted, never at a
  local-network address from a public page, and what it names is listed only after it answers as a real
  video or caption file. A recipe that ran by itself asks no server the open page has not contacted
  until StreamSnag is opened on that page. Built-in recipes never fetch.
* "Files on this page" only lists and saves a fixed list of document types; the saved extension comes from
  that list, never from the page.
* The speech-to-text engine and models are downloaded only when you ask, over HTTPS, and are used only if
  their size and SHA-256 match values pinned in the code.
* Study guides and study pages are generated HTML files opened from disk. Everything from a lecture
  (titles, transcript, slide text, AI output) is escaped, the data sits in a non-executing JSON block, the
  one script is fixed, and each page carries a strict Content-Security-Policy that allows no network.
* Lecture text is treated as data, not instructions, in every AI prompt, and nothing an AI writes is
  trusted: quotes must be found in the transcript, and unsupported items are dropped by code.
* Opening a saved study page is the one exception to "only http(s) addresses are opened": the worker opens
  only the study page files it saved itself, through Chrome or, when Chrome refuses file addresses, the
  helper's `openPage` request, which accepts only an existing `.study.html` / `.guide.html` file.
* Slide PDFs are read with Mozilla's pdf.js in the offscreen page with script evaluation disabled.
* The Claude Code and Codex CLIs are run with their tools switched off (no shell, no browser, read-only
  sandbox), so text from a web page can only produce an answer.
* StreamSnag never downloads DRM-protected or encrypted streams.
* Pro's licence key is checked with Lemon Squeezy's public licence API, which takes only the key the buyer
  typed: no API key or other secret of the store is in the extension. The worker sends the key, a generic
  name for the copy ("StreamSnag in Chrome on Windows") and the instance id, form-encoded, with
  `credentials: 'omit'`, only to `https://api.lemonsqueezy.com/v1/licenses/{validate,activate,deactivate}`
  (already covered by the extension's host access: no new permission). A key is accepted only when the
  answer names StreamSnag's store (521270) and product (1519030) and one of its three variants. The key and
  the instance id live only in `chrome.storage.local` and are left out of backups.
* Nothing but a stored activation unlocks Pro: there is no setting, address, flag or test switch for it in
  the shipped code (the browser checks answer the licence API themselves, from outside the extension). A
  check dated in the future counts as no check. The lock is a fair-use lock in an open extension, not DRM.
* Settings and the reading pages never block anything free when the key cannot be checked: offline, Pro
  keeps working for 14 days after the last good answer (a lifetime key always), and opening what was made is
  never locked.
* From the review of 2026-11-12 (1.6): a study pack made by itself after a download (Autopilot) waits to be
  made by hand when the lecture is longer than 75 minutes, as one made by hand always asks first; a page
  chooses the caption file and its times, so it cannot start a long run on the user's AI account. The
  local-network guard also covers IPv4 written as IPv6 (any address beginning with `::`, such as
  `[::ffff:c0a8:101]`, and NAT64 `64:ff9b::`), in `isPrivateHost` and in the browser-level block rule alike.
  The offscreen document answers only the extension's own pages and worker. The helper merges only video and
  audio files (it deletes its inputs afterwards), moves only the kinds of file StreamSnag saves (video and
  audio, the page's documents, subtitles, the pages and notes it makes), and takes the file yt-dlp saved only
  from a line yt-dlp prints after StreamSnag's own mark, in UTF-8, and only inside the folder it was told to
  save in. The study desk asks for a cover only of a video StreamSnag knows, as for its other file requests.
