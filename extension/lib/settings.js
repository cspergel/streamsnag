// Default settings shared by the service worker and the options page.
export const DEFAULT_MODEL = 'claude-opus-5-5';

export const DEFAULT_SETTINGS = {
  aiProvider: 'off', // 'off' | 'subscription' (Claude plan) | 'api' (Anthropic key) | 'chatgpt' (ChatGPT plan) | 'openai' (OpenAI key) | 'gemini' (Google Gemini key, has a free allowance) | 'deepseek' (DeepSeek key) | 'openrouter' (OpenRouter key, any model)
  apiKey: '',
  model: DEFAULT_MODEL,
  effort: 'medium',
  subscriptionModel: '',
  openaiKey: '', // OpenAI API key (provider 'openai')
  openaiModel: 'gpt-6-astra',
  deepseekKey: '', // DeepSeek API key (provider 'deepseek'): the cheapest pay-as-you-go route
  deepseekModel: 'deepseek-flash',
  openrouterKey: '', // OpenRouter API key (provider 'openrouter'): one key, any model
  openrouterModel: '', // "vendor/model", chosen by the user
  geminiKey: '', // Google Gemini API key (provider 'gemini')
  geminiModel: 'gemini-3.6-flash',
  chatgptModel: '', // model override for the ChatGPT subscription route (Codex CLI); empty = its default
  minSizeKB: 300,
  concurrency: 6,
  includeSubtitles: true,
  useFfmpeg: true,
  embedSubtitles: true, // put downloaded subtitles inside the merged MP4/MKV
  keepSubtitleFiles: false, // also keep the .vtt files next to it
  transcriptFormat: 'md', // "Save transcript": 'md' (Markdown with timestamps) | 'txt' (plain text)
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
  showEverything: false, // "Always show everything": copies, previews and short clips stay in the list (otherwise one line at its end)
  sttModel: 'small', // transcription on this computer: 'tiny' (English, smallest download) | 'small' (English, the default) | 'best' (25 European languages)
  // After a download finishes (all off until you turn them on):
  autoTranscript: false, // save a transcript when the video has captions
  autoTranscribe: false, // no captions: transcribe it on this computer (needs transcription set up)
  autoStudyPack: false, // make a study pack with AI (sends the transcript and slide text to your AI provider); was "autoNotes"
  autoStudyPage: false, // make a study page (video, slides and transcript in step) when the page links its slides (PDF or PowerPoint)
  autoRead: false, // make a reading edition (the lecture as an article); without AI unless a study pack with that part is made
  // Study pack (Settings → AI → Study pack):
  packCardsPerHour: 24, // flashcards per hour of lecture: 12 | 24 | 36 | 48 (the engine keeps its own cap)
  packDepth: 'standard', // 'brief' | 'standard' | 'detailed'
  // The parts of a pack. A part that is off is not made, and none of its AI use is spent (each run can be trimmed again before it starts).
  packGuide: true, // the study guide: big picture and key ideas
  packSheets: true, // deeper review sheets
  packQuiz: true, // the practice quiz and self-test
  packCards: true, // flashcards (the Anki file, and "Review cards")
  packFigures: true, // key figures from the slides
  packTranscript: true, // the cleaned transcript (no AI)
  packRead: true, // the reading edition: the lecture as an article (AI only when "tidy with AI" is not off)
  readTidy: 'ask', // "Read the lecture": have AI tidy the wording? 'off' | 'ask' (each time) | 'always'
  packBeyond: 'auto', // explanations beyond the lecture, always marked as such: 'off' | 'auto' (when they add something) | 'always' (a simpler explanation under every key idea)
  packEffort: 'balanced', // 'balanced' (reading and checking on the provider's faster model) | 'best' (your model for every step)
  reviewNewPerDay: 20, // "Review cards": new flashcards shown a day
  sidebarOnClick: false, // clicking the toolbar icon opens StreamSnag in the side panel instead of the popup
};

/** The speech models transcription can use, smallest first. */
export const STT_MODEL_IDS = ['tiny', 'small', 'best'];
/** The default model: the most dependable on lectures (the helper's STT_DEFAULT). */
export const STT_MODEL_DEFAULT = 'small';

/** The model chosen in Settings; anything else (nothing stored, a name from another version) is the default. */
export function sttModelOf(settings) {
  const chosen = settings?.sttModel;
  return typeof chosen === 'string' && STT_MODEL_IDS.includes(chosen) ? chosen : STT_MODEL_DEFAULT;
}

/**
 * Settings stored by an older version, brought up to date (a new object; nothing is written here):
 * "Make study notes after a download" became "Make a study pack", so its switch carries over once.
 */
export function migrateSettings(stored) {
  const s = { ...(stored && typeof stored === 'object' ? stored : {}) };
  if ('autoNotes' in s) {
    if (typeof s.autoStudyPack !== 'boolean') s.autoStudyPack = s.autoNotes === true;
    delete s.autoNotes;
  }
  // "Add short explanations beyond the lecture" was a switch before it became a choice of three.
  if (typeof s.packBeyond === 'boolean') s.packBeyond = s.packBeyond ? 'auto' : 'off';
  return s;
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...migrateSettings(settings) };
}
