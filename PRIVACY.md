# Privacy

StreamSnag has no servers, no accounts, no analytics and no tracking. It works on your computer. The one
thing sent anywhere for Pro is the licence key (see "Pro's licence key" below).

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
* **Your own videos** ("Add a video", "Add a folder" on the study desk): the helper keeps the list of the
  files and folders you chose in `%LOCALAPPDATA%\StreamSnag\sources.json`, and the desk keeps the list of
  their video files in extension storage. Nothing is moved, renamed or copied; the only files written next to
  them are the ones StreamSnag makes when you ask (captions, transcript, reading edition, study page, study
  pack). Nothing about these files leaves your computer, except the transcript (and slide text) of a
  lecture you send to your own AI account after the sheet that shows what is sent. "Stop listing" removes a
  folder from the list and leaves its files alone.
* **Pro's licence key and the free lecture.** The key you paste, the id Lemon Squeezy gives this copy
  when it is activated, the plan, how many of its computers it is on and when it was last checked are kept
  in extension storage (`chrome.storage.local`) only, never in a backup or a file. Which lecture was your one
  free lecture (the keys StreamSnag already knows it by, and its name) is kept there too.
* **Pack styles** and which style each lecture and course was last made with are kept in extension storage.
* **Diagnostic snapshots** are off by default. When you turn them on (Settings → Backup & advanced), the last
  page's detections are saved in extension storage so you can copy them into a bug report. They include that
  page's media URLs, so read the report before sharing it.

## What is sent over the network, and only when you ask

* **Downloads.** StreamSnag requests the video files and stream segments from wherever the page loads them,
  like your browser does when you play them. For sites that need it, it sends the page's address (without
  its query string) as the `Referer`, as the player itself would.
* **Details of what it found.** To show a file's size or a stream's qualities and length, StreamSnag reads
  the first bytes of a detected file or the stream's playlist as soon as it is found, without a click. It
  never does this to local-network addresses (your router, a NAS, `localhost`) from a public web page:
  Chrome blocks StreamSnag's own requests to them, redirects included, unless the page is itself local or
  you clicked Download on that item.
* **Embedded players.** To find the real video behind a Vimeo or Wistia player on a page, StreamSnag reads
  that player's public configuration from Vimeo or Wistia.
* **yt-dlp** (if you use it) contacts the site you point it at, and its update check contacts GitHub when
  you click **Update yt-dlp**.
* **Files on this page.** A document is downloaded from the address the page links to, when you click it.
* **Transcription setup** (optional). When you click **Set up transcription**, the helper downloads the
  open-source sherpa-onnx speech-to-text program and a model from GitHub and checks them against a known
  fingerprint. Transcribing itself happens on your computer: the audio is never uploaded.
* **Pro's licence key.** StreamSnag Pro is sold by Lemon Squeezy, and the key is checked with Lemon
  Squeezy's public licence API (`https://api.lemonsqueezy.com/v1/licenses`). Exactly three things are
  ever sent, and only to it: the key you pasted, a plain name for this copy ("StreamSnag in Chrome on
  Windows": the browser and the system, never your name or your computer's), and the id Lemon Squeezy gave
  this copy. They are sent when you click **Activate** (the key is looked up, then this copy is activated),
  at most once a day when you start a Pro action, when the browser opens and the last check is more than a
  week old, and when you click **Remove this key from this computer**. No cookies or other identifiers go
  with them, and nothing about your lectures, files or use. Without a key nothing is sent at all; the free
  lecture is counted on your computer. Lemon Squeezy's privacy policy applies to what it receives and to
  your purchase.
* **AI features are off by default.** They use an AI account that you choose in Settings, and nothing is
  sent until you use an AI action (or turn on an "after a download" step that uses AI). What is sent
  depends on the action:
  * **Make study pack**, **Summarize**: the lecture's title, its transcript or captions, and the text of
    its slides when it has them. Slide pictures are never sent. Before a study pack starts, StreamSnag
    shows what will be sent, to which provider, and roughly how much AI use it takes.
  * **Ask your AI to find it** (when no video, or the wrong one, is listed): the page's address, title and
    headings, the addresses of the requests it made (up to 300, including any tokens in them) and the parts
    of its HTML/scripts around video players. Before anything is sent, StreamSnag shows what will be sent
    (the exact text is one click away), to which provider, and that it is one request. When the answer
    finds the video, what worked is saved on your computer as a rule for that site, so the AI is not asked
    there again; StreamSnag says so, with an Undo.
  * **Ask AI why** (on a failed download): the page's address, the video's address, the error message and
    the server's response headers. AI file names (off unless you turn them on): the page's address and
    title and the lecture's name.
* **Where it goes** is the provider you chose, and only that one: Anthropic (Claude), OpenAI (ChatGPT),
  Google (Gemini), DeepSeek (a company based in China, whose servers process the text) or OpenRouter (which
  passes the text on to the provider of the model you picked). With **a Claude or ChatGPT subscription**
  it goes through that company's own command-line tool on your PC (Claude Code or Codex, run with their
  tools switched off); with **an API key** it goes straight to that provider's API. The provider's privacy
  policy applies to the data. An API key is stored in extension storage and is only sent to its own
  provider. API keys are left out of backups unless you tick the box.
* **Your university may have rules** about putting lecture recordings or transcripts into AI tools. That
  applies to your own AI account too. Using these features is your choice and your responsibility.
* **Study materials and review progress stay on your computer.** Study guides, transcripts, flashcards and
  study pages are files next to your videos. Your flashcard decks and review history are kept in the
  extension's storage. StreamSnag has no servers, so none of it can go to us.

## Permissions and why they are needed

| Permission | Used for |
|---|---|
| Access to all sites, `webRequest` | Seeing which media files a page loads (that is how videos are found) |
| `declarativeNetRequestWithHostAccess` | Adding the page as `Referer` for CDNs that require it, only for StreamSnag's own requests |
| `downloads` | Saving files |
| `scripting`, `webNavigation` | "Scan again": checking every frame of a page without reloading it |
| `storage`, `unlimitedStorage` | Settings, history, recipes, flashcard decks and review progress, unfinished study packs (so they can resume), and the list of files in your folders (can exceed the default quota) |
| `offscreen` | Joining stream segments into one file, and reading the text of slide PDFs (service workers can't do that) |
| `nativeMessaging` | Talking to the optional local helper |
| `sidePanel`, `contextMenus`, `notifications`, `tabs` | The sidebar, right-click menu, "download finished" notices, and knowing which tab you're on |

Questions or concerns: open an issue on GitHub.
