// preview.js — screen-text tail/chrome-stripping, ported verbatim from
// `ultrawatch_lib/ui/draw.py:tail_lines`/`_is_chrome`. Shared fixtures with
// the Python side (textutil.py) keep behavior identical; used by the Grid
// view's chrome-stripped tiles (P-45) and the List view's mini-preview
// strip (P-44). The main Preview pane (P-42) does NOT strip chrome or
// truncate width — it shows the full screen text pinned to the bottom — so
// that behavior lives in WP5, not here.

const CHROME_PREFIXES = ['⏵⏵'];

/** True if `line` is agent-CLI chrome (input-box rule, bare prompt, footer). */
export function isChrome(line) {
  const s = line.trim();
  if (!s || s === '❯') return true;
  if (/^[─━]+$/.test(s)) return true;
  if (CHROME_PREFIXES.some((p) => s.startsWith(p))) return true;
  if (s.includes('% remaining]')) return true;
  return false;
}

/**
 * Last `n` non-trailing-blank screen lines, each clipped to `width`.
 * `stripChrome` drops up to 8 trailing chrome lines (input box dividers,
 * bare prompt, `⏵⏵` status lines, `% remaining]` footers) so small
 * previews show real content instead of CLI furniture.
 *
 * @param {string} text
 * @param {number} n
 * @param {number} width
 * @param {{stripChrome?: boolean}} [opts]
 * @returns {string[]}
 */
export function tailLines(text, n, width, { stripChrome = false } = {}) {
  let lines = (text || '').split('\n').map((l) => l.replace(/\s+$/u, ''));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  if (stripChrome) {
    let stripped = 0;
    while (lines.length && stripped < 8 && isChrome(lines[lines.length - 1])) {
      lines.pop();
      stripped += 1;
    }
    while (lines.length && !lines[lines.length - 1]) lines.pop();
  }
  if (n <= 0) return [];
  const tail = lines.slice(Math.max(0, lines.length - n));
  return tail.map((l) => l.slice(0, Math.max(0, width)));
}
