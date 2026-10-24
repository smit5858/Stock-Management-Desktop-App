// Runs before the first paint (plain script in <head>) so the saved theme never flashes.
// window.api.initialUiPrefs is provided by electron/preload.js.
(function () {
  try {
    var prefs = (window.api && window.api.initialUiPrefs) || {};
    var theme = prefs.theme || 'system';
    var dark =
      theme === 'dark' ||
      (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    var root = document.documentElement;
    if (dark) root.classList.add('dark');
    if (prefs.reduceMotion) root.classList.add('reduce-motion');
  } catch (e) {
    // Fall back to the light theme.
  }
})();
