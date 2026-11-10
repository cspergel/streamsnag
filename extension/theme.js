// Chooses light or dark before the page paints. Loaded as a plain script in <head> by the popup,
// the sidebar and the settings page. The choice ("system", "light" or "dark") lives in localStorage,
// which those pages share, so changing it in one updates the others straight away.
(() => {
  const KEY = 'ss-theme';
  const root = document.documentElement;
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const get = () => {
    try {
      const v = localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : 'system';
    } catch {
      return 'system';
    }
  };
  const apply = () => {
    const choice = get();
    root.dataset.theme = choice === 'system' ? (dark.matches ? 'dark' : 'light') : choice;
  };
  const set = (choice) => {
    try {
      if (choice === 'light' || choice === 'dark') localStorage.setItem(KEY, choice);
      else localStorage.removeItem(KEY);
    } catch { /* private mode: the choice lasts until the page closes */ }
    apply();
  };
  apply();
  dark.addEventListener('change', apply);
  addEventListener('storage', (e) => { if (e.key === KEY || e.key === null) apply(); });
  window.ssTheme = { get, set };
})();
