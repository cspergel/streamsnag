// Default settings shared by the service worker and the options page.
export const DEFAULT_MODEL = 'claude-opus-5-5';

export const DEFAULT_SETTINGS = {
  aiProvider: 'off', // 'off' | 'subscription' (Claude plan) | 'api' (Anthropic key) | 'chatgpt' (ChatGPT plan) | 'openai' (OpenAI key)
  apiKey: '',
  model: DEFAULT_MODEL,
  effort: 'medium',
  subscriptionModel: '',
  openaiKey: '', // OpenAI API key (provider 'openai')
  openaiModel: 'gpt-6-astra',
  chatgptModel: '', // model override for the ChatGPT subscription route (Codex CLI); empty = its default
  minSizeKB: 300,
  concurrency: 6,
  includeSubtitles: true,
  useFfmpeg: true,
  embedSubtitles: true, // put downloaded subtitles inside the merged MP4/MKV
  keepSubtitleFiles: false, // also keep the .vtt files next to it
  aiFilenames: false,
  filenameTemplate: '{title} - {quality}',
  subfolder: 'StreamSnag', // relative, may be nested and use {site} {date} {kind}
  saveFolder: '', // absolute folder anywhere on the PC; empty = Chrome's Downloads folder (needs the helper)
  libraryFolders: [], // more folders to check for videos you already have
  checkDownloads: true, // also check your Downloads folder (where most tools save)
  debugMode: false, // keep a snapshot of the last page's detections, for bug reports
  maxParallel: 2, // downloads running at once; the rest wait in the queue
  preferredQuality: 'best', // the quality picked first: 'best' | '1080' | '720' | '480' | 'smallest'
  siteRules: {}, // per-site overrides: { "example.com": { subfolder, filenameTemplate } }
  notify: true,
  autoRecipes: true,
  showDocuments: true, // list the documents a page links to (PDF, slides…) under "Files on this page"
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}
