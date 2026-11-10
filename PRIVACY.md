# Privacy

StreamSnag has no servers, no accounts, no analytics and no tracking. It works on your computer.

## What stays on your computer

* **Settings, site recipes, site rules, download history and "downloaded" marks** are saved in your
  browser's extension storage (`chrome.storage.local`). They never leave your PC unless you export a backup
  yourself.
* **What StreamSnag sees on a page** (the media links a page loads, the video titles) is kept in memory for
  that tab and cleared when you close it.
* **The local helper** (optional) runs only on your PC. It lists the video files in the folders you choose
  (to tell what you already have) and caches their lengths in `%LOCALAPPDATA%\StreamSnag\durations.json`
  (`~/.local/share/StreamSnag` on Mac/Linux). It writes a small log to your temp folder
  (`streamsnag-helper.log`) with startup lines and errors only.
* **Diagnostic snapshots** are off by default. When you turn them on (Settings → Backup & advanced), the last
  page's detections are saved in extension storage so you can copy them into a bug report. They include that
  page's media URLs, so read the report before sharing it.

## What is sent over the network, and only when you ask

* **Downloads.** StreamSnag requests the video files and stream segments from wherever the page loads them,
  like your browser does when you play them. For sites that need it, it sends the page's address (without
  its query string) as the `Referer`, as the player itself would.
* **Details of what it found.** To show a file's size or a stream's qualities and length, StreamSnag reads
  the first bytes of a detected file or the stream's playlist as soon as it is found, without a click. It
  never does this to local-network addresses (your router, a NAS, `localhost`) from a public web page.
* **Embedded players.** To find the real video behind a Vimeo or Wistia player on a page, StreamSnag reads
  that player's public configuration from Vimeo or Wistia.
* **yt-dlp** (if you use it) contacts the site you point it at, and its update check contacts GitHub when
  you click **Update yt-dlp**.
* **AI features are off by default.** If you turn them on and click **Find with AI**, **Ask AI why**,
  **Summarize**, or enable AI file names, StreamSnag sends Anthropic a summary of the page needed for that
  task: its address and title, the media links it loaded, parts of its HTML/scripts around video players,
  an error message, or a video's captions. With **your Claude subscription** this goes through the Claude
  Code CLI on your PC; with **an API key** it goes straight to the Anthropic API. Anthropic's privacy
  policy applies to that data. Your API key is stored in extension storage and is only sent to Anthropic.

## Permissions and why they are needed

| Permission | Used for |
|---|---|
| Access to all sites, `webRequest` | Seeing which media files a page loads (that is how videos are found) |
| `declarativeNetRequestWithHostAccess` | Adding the page as `Referer` for CDNs that require it, only for StreamSnag's own requests |
| `downloads` | Saving files |
| `scripting`, `webNavigation` | "Scan again": checking every frame of a page without reloading it |
| `storage`, `unlimitedStorage` | Settings, history, recipes, and the list of files in your folders (can exceed the default quota) |
| `offscreen` | Joining stream segments into one file (service workers can't do that) |
| `nativeMessaging` | Talking to the optional local helper |
| `sidePanel`, `contextMenus`, `notifications`, `tabs` | The sidebar, right-click menu, "download finished" notices, and knowing which tab you're on |

Questions or concerns: open an issue on GitHub.
