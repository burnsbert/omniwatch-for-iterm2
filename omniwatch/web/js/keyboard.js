// keyboard.js — pure keyboard-event normalization and the per-overlay key
// rules (zoom P-47, usage P-51), so main.js's keydown handler is a thin
// router over tested functions.

const MODIFIER_KEYS = new Set(['Shift', 'Meta', 'Alt', 'Control', 'CapsLock', 'Fn', 'OS', 'Hyper', 'Super']);

/**
 * Normalize a KeyboardEvent-like object for keymap.matchCommand:
 * - ⌥+digit on macOS reports `¡™£…` in `.key`; use `.code` (DigitN) instead.
 * - Printable single characters already include Shift in `.key` ('A', '$',
 *   '?', '>'), so Shift is cleared for them (keymap.js only sets `shift` for
 *   keys like Tab whose `.key` doesn't change).
 * - ⌘ + letter reports the lowercase letter; keep it.
 */
export function normalizeKeyEvent(e) {
  let key = e.key;
  if (e.altKey && typeof e.code === 'string') {
    const m = /^Digit(\d)$/.exec(e.code);
    if (m) key = m[1];
  }
  if (e.metaKey && typeof key === 'string' && key.length === 1 && /[A-Z]/.test(key) && !e.shiftKey) key = key.toLowerCase();
  const printable = typeof key === 'string' && key.length === 1;
  return {
    key,
    shiftKey: printable ? false : !!e.shiftKey,
    altKey: !!e.altKey,
    metaKey: !!e.metaKey,
    ctrlKey: !!e.ctrlKey,
  };
}

export function isModifierOnly(key) {
  return MODIFIER_KEYS.has(key);
}

/** True for inputs that take typed text (bare shortcuts are suppressed there). */
export function isTextFieldLike({ tagName = '', type = '', isContentEditable = false } = {}) {
  if (isContentEditable) return true;
  const tag = String(tagName).toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const t = String(type || 'text').toLowerCase();
  return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(t);
}

/**
 * Zoom overlay (P-47): ↑/↓ (and j/k) change session, ⏎/g go to it, ⌥N and
 * `i` still reply, chords fall through to the keymap; any other
 * non-modifier key exits zoom.
 * @returns {'move-up'|'move-down'|'goto'|'passthrough'|'exit'|'ignore'}
 */
export function zoomKeyAction(ev) {
  if (isModifierOnly(ev.key)) return 'ignore';
  if (ev.metaKey || ev.ctrlKey) return 'passthrough';
  if (ev.altKey && /^\d$/.test(ev.key)) return 'passthrough';
  if (ev.key === 'ArrowUp' || ev.key === 'k') return 'move-up';
  if (ev.key === 'ArrowDown' || ev.key === 'j') return 'move-down';
  if (ev.key === 'Enter' || ev.key === 'g' || ev.key === 'G') return 'goto';
  if (ev.key === 'i' || ev.key === 'Tab' || ev.key === '?') return 'passthrough';
  return 'exit';
}

/**
 * Usage overlay (P-51): `$` toggles dollars, `r` refreshes, `u`/`q`/Esc go
 * back; chords fall through; other bare keys are swallowed.
 * @returns {'dollars'|'refresh'|'close'|'passthrough'|'ignore'}
 */
export function usageKeyAction(ev) {
  if (isModifierOnly(ev.key)) return 'ignore';
  if (ev.metaKey || ev.ctrlKey) return 'passthrough';
  if (ev.key === '$') return 'dollars';
  if (ev.key === 'r' || ev.key === 'R') return 'refresh';
  if (ev.key === 'u' || ev.key === 'U' || ev.key === 'q' || ev.key === 'Escape') return 'close';
  if (ev.key === '?' || ev.key === 'Tab') return 'passthrough';
  return 'ignore';
}

/** Focus regions cycled by Tab / ⇧Tab (§2.5), skipping hidden ones. */
export function nextRegion(regions, current, dir) {
  const list = regions.filter(Boolean);
  if (!list.length) return null;
  const i = list.indexOf(current);
  if (i < 0) return dir > 0 ? list[0] : list[list.length - 1];
  return list[(i + dir + list.length) % list.length];
}
