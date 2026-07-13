export type ThemeMode = 'system' | 'light' | 'dark';

export function normalizeThemeMode(value: unknown): ThemeMode {
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function readThemeMode(): ThemeMode {
  return 'system';
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
