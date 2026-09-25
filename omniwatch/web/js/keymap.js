// keymap.js — the physical key -> command-id table (DESIGN.md §2.5), as
// data, plus the pure matching/formatting helpers built on it. Single
// source for the shortcut sheet, command palette hint text, and the hint
// bar (P-53). Includes the P-83 uppercase synonyms (V, S, L, P, N, X, U,
// B, R, C, G) and keeps `A` (grid all) distinct from `a` (select next
// waiting) since P-83 calls out `A` as case-sensitive.
//
// A binding is `{key, shift?, alt?, meta?, ctrl?}`, where `key` matches
// `KeyboardEvent.key` (so shifted letters like 'S' are already
// case-correct; `shift` is only set for keys whose `.key` value doesn't
// change with Shift, e.g. Tab).

import { getCommand } from './commands.js';

/** @typedef {{key:string, shift?:boolean, alt?:boolean, meta?:boolean, ctrl?:boolean}} Binding */

/** @type {Record<string, Binding[]>} commandId -> bindings */
export const BINDINGS = Object.freeze({
  'move.up': [{ key: 'ArrowUp' }, { key: 'k' }],
  'move.down': [{ key: 'ArrowDown' }, { key: 'j' }],
  'move.left': [{ key: 'ArrowLeft' }],
  'move.right': [{ key: 'ArrowRight' }],
  'session.goto': [{ key: 'Enter' }, { key: 'g' }, { key: 'G' }],
  'select.nextWaiting': [{ key: 'a' }],
  'focusRegion.next': [{ key: 'Tab' }],
  'focusRegion.prev': [{ key: 'Tab', shift: true }],

  'zoom.toggle': [{ key: ' ' }],
  'label.edit': [{ key: 'l' }, { key: 'L' }],
  'color.set.1': [{ key: '1' }],
  'color.set.2': [{ key: '2' }],
  'color.set.3': [{ key: '3' }],
  'color.set.4': [{ key: '4' }],
  'color.set.5': [{ key: '5' }],
  'color.clear': [{ key: '0' }],
  'projects.clear': [{ key: 'c' }, { key: 'C' }],
  'tab.new': [{ key: 'n' }, { key: 'N' }],
  'tab.close': [{ key: 'x' }, { key: 'X' }],
  'reply.focus': [{ key: 'i' }],
  'reply.send.1': [{ key: '1', alt: true }],
  'reply.send.2': [{ key: '2', alt: true }],
  'reply.send.3': [{ key: '3', alt: true }],
  'reply.send.4': [{ key: '4', alt: true }],
  'reply.send.5': [{ key: '5', alt: true }],
  'reply.send.6': [{ key: '6', alt: true }],
  'reply.send.7': [{ key: '7', alt: true }],
  'reply.send.8': [{ key: '8', alt: true }],
  'reply.send.9': [{ key: '9', alt: true }],
  refresh: [{ key: 'r' }, { key: 'R' }, { key: 'r', meta: true }],
  // Open in… (API.md reveal): e editor, o Finder, y copy path ("yank"). None collide with §2.5.
  'reveal.editor': [{ key: 'e' }, { key: 'E' }],
  'reveal.finder': [{ key: 'o' }, { key: 'O' }],
  'reveal.copyPath': [{ key: 'y' }, { key: 'Y' }],
  'history.open': [{ key: 't' }, { key: 'T' }],

  'view.cycle': [{ key: 'v' }, { key: 'V' }],
  'view.split': [{ key: '1', meta: true }],
  'view.list': [{ key: '2', meta: true }],
  'view.grid': [{ key: '3', meta: true }],
  'split.grow': [{ key: '>' }, { key: '.' }],
  'split.shrink': [{ key: '<' }, { key: ',' }],
  'filter.focus': [{ key: '/' }, { key: 'f', meta: true }],
  'sort.cycle': [{ key: 's' }, { key: 'S' }],
  'projects.toggle': [{ key: 'p' }, { key: 'P' }],
  'dollars.toggle': [{ key: '$' }],
  'sound.toggle': [{ key: 'b' }, { key: 'B' }],
  'grid.toggleAll': [{ key: 'A' }],
  'usage.toggle': [{ key: 'u' }, { key: 'U' }, { key: 'u', meta: true }],
  'textSize.increase': [{ key: '+', meta: true }, { key: '=', meta: true }],
  'textSize.decrease': [{ key: '-', meta: true }],
  'textSize.reset': [{ key: '0', meta: true }],

  unwind: [{ key: 'Escape' }],
  'window.close': [{ key: 'q' }],
  'commandPalette.open': [{ key: 'k', meta: true }],
  'settings.open': [{ key: ',', meta: true }],
  'help.open': [{ key: '?' }, { key: '/', meta: true }],
});

/** Flat list of {commandId, binding} pairs, in COMMANDS order-ish, for iteration. */
export function allBindings() {
  const out = [];
  for (const [commandId, bindings] of Object.entries(BINDINGS)) {
    for (const binding of bindings) out.push({ commandId, binding });
  }
  return out;
}

function modifiersEqual(a, b) {
  return !!a.shift === !!b.shift && !!a.alt === !!b.alt
    && !!a.meta === !!b.meta && !!a.ctrl === !!b.ctrl;
}

function bindingMatchesEvent(binding, event) {
  if (binding.key !== event.key) return false;
  return modifiersEqual(binding, {
    shift: event.shiftKey,
    alt: event.altKey,
    meta: event.metaKey,
    ctrl: event.ctrlKey,
  });
}

/**
 * Find the command id bound to a normalized keyboard event, honoring
 * "bare keys apply when focus isn't in a text field" (§2.5): a binding
 * with no Meta/Ctrl modifier is suppressed while `inTextField` is true,
 * unless its command opts in via `allowInTextField` (e.g. Escape).
 *
 * @param {{key:string, shiftKey?:boolean, altKey?:boolean, metaKey?:boolean, ctrlKey?:boolean}} event
 * @param {{inTextField?: boolean}} [context]
 * @returns {string|null} the matched command id, or null
 */
export function matchCommand(event, { inTextField = false } = {}) {
  for (const [commandId, bindings] of Object.entries(BINDINGS)) {
    for (const binding of bindings) {
      if (!bindingMatchesEvent(binding, event)) continue;
      const isChord = binding.meta || binding.ctrl;
      if (inTextField && !isChord) {
        const cmd = getCommand(commandId);
        if (!cmd || !cmd.allowInTextField) continue;
      }
      return commandId;
    }
  }
  return null;
}

const KEY_GLYPHS = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Enter: '⏎', Escape: 'Esc', ' ': 'Space', Tab: 'Tab',
};

/** Human-readable label for one binding, e.g. '⌘1', '⇧Tab', '⌥1', 'Esc', 'j'. */
export function formatBinding(binding) {
  let out = '';
  if (binding.ctrl) out += '⌃';
  if (binding.alt) out += '⌥';
  if (binding.shift) out += '⇧';
  if (binding.meta) out += '⌘';
  out += KEY_GLYPHS[binding.key] || binding.key;
  return out;
}

/** All bindings for a command, formatted for display, e.g. ['v', 'V']. */
export function formatBindingsFor(commandId) {
  return (BINDINGS[commandId] || []).map(formatBinding);
}
