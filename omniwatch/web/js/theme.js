// theme.js — resolving and applying the theme pref (§2.6). `system`
// follows prefers-color-scheme; `high-contrast` is its own token set. The
// resolved value is posted to native so the window chrome matches.

export const THEME_VALUES = Object.freeze(['system', 'dark', 'light', 'high-contrast']);

/** The concrete scheme ('dark' | 'light') a theme pref renders as. */
export function resolveScheme(theme, prefersLight) {
  if (theme === 'light') return 'light';
  if (theme === 'dark' || theme === 'high-contrast') return 'dark';
  return prefersLight ? 'light' : 'dark';
}

/** Normalize an unknown pref value to 'system'. */
export function normalizeTheme(theme) {
  return THEME_VALUES.includes(theme) ? theme : 'system';
}

/**
 * Apply to a root element (anything with setAttribute/style.setProperty).
 * @returns {string} the normalized theme applied
 */
export function applyTheme(root, theme, fontScale) {
  const t = normalizeTheme(theme);
  root.setAttribute('data-theme', t);
  const scale = Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
  root.style.setProperty('--ow-font-scale', String(scale));
  return t;
}
