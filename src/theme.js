const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

export function resolveTheme(theme) {
  return theme === 'dark' || (theme === 'system' && darkQuery.matches) ? 'dark' : 'light';
}

/** Applies the theme class; `animate` adds a short colour transition while switching. */
export function applyTheme(theme, { animate = true } = {}) {
  const root = document.documentElement;
  const dark = resolveTheme(theme) === 'dark';
  if (dark === root.classList.contains('dark')) return;
  if (animate && !root.classList.contains('reduce-motion')) {
    root.classList.add('theme-transition');
    setTimeout(() => root.classList.remove('theme-transition'), 260);
  }
  root.classList.toggle('dark', dark);
}

export function applyReduceMotion(on) {
  document.documentElement.classList.toggle('reduce-motion', Boolean(on));
}

/** Calls back when the OS theme changes. Returns an unsubscribe function. */
export function onSystemThemeChange(callback) {
  darkQuery.addEventListener('change', callback);
  return () => darkQuery.removeEventListener('change', callback);
}
