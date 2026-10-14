import { useEffect } from 'react';
import { api } from '../api';
import { normalizeThemeMode, readStoredThemeMode, type ThemeMode } from './theme';

export function useDesktopTheme(enabled: boolean, onTheme: (mode: ThemeMode) => void, page: string) {
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const sync = () => {
      void api.theme().then(result => {
        if (active && readStoredThemeMode() === null) onTheme(normalizeThemeMode((result as { source?: unknown }).source));
      }).catch(() => undefined);
    };
    const onVisibility = () => { if (document.visibilityState === 'visible') sync(); };
    sync();
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', onVisibility);
    return () => { active = false; window.removeEventListener('focus', sync); document.removeEventListener('visibilitychange', onVisibility); };
  }, [enabled, onTheme, page]);
}
