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
  Anthropic).
* Anything that lets another extension or program talk to the helper.

## Design notes for reviewers

* The helper only accepts connections from StreamSnag's extension ID (`allowed_origins` in its manifest).
* Commands are started without a shell; arguments for `.cmd` shims are quoted and anything cmd.exe could
  interpret is refused (`cmdShimCommandLine`).
* Output folders are validated (`safeFolder`) and subfolders/file names can't leave them (`joinInside`,
  `safeOutputName`, `ytdlpSafeName`).
* Site recipes are data, never code, and their fetches are limited to the page's own site.
* StreamSnag never downloads DRM-protected or encrypted streams.
