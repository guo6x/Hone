import { useState, useEffect, useCallback } from 'react';

export type ThemeName = 'dark' | 'light' | 'gold' | 'midnight';

const THEME_KEY = 'hone-theme';

export function getSavedTheme(): ThemeName {
  try {
    return (localStorage.getItem(THEME_KEY) as ThemeName) || 'dark';
  } catch {
    return 'dark';
  }
}

export function useTheme() {
  const [theme, setThemeState] = useState<ThemeName>(getSavedTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {}
  }, [theme]);

  const setTheme = useCallback((t: ThemeName) => setThemeState(t), []);

  const cycleTheme = useCallback(() => {
    const themes: ThemeName[] = ['dark', 'light', 'gold', 'midnight'];
    const idx = themes.indexOf(theme);
    setThemeState(themes[(idx + 1) % themes.length]);
  }, [theme]);

  return { theme, setTheme, cycleTheme };
}
