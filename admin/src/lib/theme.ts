export type ThemeMode = 'system' | 'light' | 'dark';

const THEME_STORAGE_KEY = 'pmbrain.admin.theme-mode';

export function normalizeThemeMode(value: unknown): ThemeMode {
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function readStoredThemeMode(): ThemeMode | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === 'system' || value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

export function readThemeMode(): ThemeMode {
  return readStoredThemeMode() ?? 'system';
}

export function storeThemeMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // The current theme still applies when browser storage is unavailable.
  }
}

export function resolveTheme(mode: ThemeMode, prefersDark: boolean): 'light' | 'dark' {
  return mode === 'system' ? (prefersDark ? 'dark' : 'light') : mode;
}

export function applyThemeMode(mode: ThemeMode): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = () => {
    document.documentElement.dataset.themeMode = mode;
    document.documentElement.dataset.theme = resolveTheme(mode, media.matches);
    document.documentElement.style.colorScheme = resolveTheme(mode, media.matches);
  };
  apply();
  if (mode !== 'system') return () => undefined;
  media.addEventListener('change', apply);
  return () => media.removeEventListener('change', apply);
}
