/**
 * Theme selection (opt-in dark; DESIGN-DIRECTION.md). Persisted locally
 * and applied by toggling `data-theme="dark"` on <html> — dark redefines only the
 * existing token names, so no component CSS is theme-aware. First-paint is handled
 * by a tiny inline script in index.html to avoid a flash; this module drives the
 * runtime toggle.
 */
const KEY = 'ccp.theme.v1';
export type Theme = 'light' | 'dark';

export function getTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function applyTheme(theme: Theme): void {
  const el = document.documentElement;
  if (theme === 'dark') el.setAttribute('data-theme', 'dark');
  else el.removeAttribute('data-theme');
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* ignore — falls back to session default */
  }
  applyTheme(theme);
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}
