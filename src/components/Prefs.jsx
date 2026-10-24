import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { MotionConfig } from 'framer-motion';
import { prefsApi } from '../api/settings';
import { applyReduceMotion, applyTheme, onSystemThemeChange } from '../theme';

const DEFAULTS = {
  theme: 'system',
  sidebarCollapsed: false,
  reduceMotion: false,
  startupSound: true,
  soundVolume: 0.6,
};

const PrefsContext = createContext({ prefs: DEFAULTS, setPref: () => {} });

/** UI preferences (settings.json). Starts from the values preload received at window creation. */
export function PrefsProvider({ children }) {
  const [prefs, setPrefs] = useState(() => ({ ...DEFAULTS, ...window.api.initialUiPrefs }));

  useEffect(() => {
    applyTheme(prefs.theme);
    if (prefs.theme !== 'system') return undefined;
    return onSystemThemeChange(() => applyTheme('system'));
  }, [prefs.theme]);

  useEffect(() => applyReduceMotion(prefs.reduceMotion), [prefs.reduceMotion]);

  const setPref = useCallback((key, value) => {
    setPrefs((p) => ({ ...p, [key]: value }));
    prefsApi.set({ [key]: value }).catch(() => {
      // Saving a UI preference must never interrupt work; it is retried on the next change.
    });
  }, []);

  const value = useMemo(() => ({ prefs, setPref }), [prefs, setPref]);

  return (
    <PrefsContext.Provider value={value}>
      <MotionConfig reducedMotion={prefs.reduceMotion ? 'always' : 'user'}>{children}</MotionConfig>
    </PrefsContext.Provider>
  );
}

export function usePrefs() {
  return useContext(PrefsContext);
}
