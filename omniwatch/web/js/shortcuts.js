// shortcuts.js — groups for the keyboard-shortcut sheet (P-48) and the
// context-sensitive hint bar (P-53), both derived from commands.js +
// keymap.js so there is one source of truth for keys.

import { commandsByCategory } from './commands.js';
import { formatBindingsFor } from './keymap.js';

// Families collapsed into one sheet row.
const FAMILIES = [
  { match: /^color\.set\.\d$/, id: 'color.set', title: 'Set tab color to project 1–5', keys: ['1–5'] },
  { match: /^reply\.send\.\d$/, id: 'reply.send', title: 'Send reply option N (waiting)', keys: ['⌥1–⌥9'] },
];

/** @returns {{category:string, entries:{id:string, title:string, keys:string[]}[]}[]} */
export function shortcutSections() {
  const out = [];
  for (const [category, cmds] of commandsByCategory()) {
    const entries = [];
    const seen = new Set();
    for (const c of cmds) {
      const fam = FAMILIES.find((f) => f.match.test(c.id));
      if (fam) {
        if (seen.has(fam.id)) continue;
        seen.add(fam.id);
        entries.push({ id: fam.id, title: fam.title, keys: fam.keys });
        continue;
      }
      entries.push({ id: c.id, title: c.title, keys: dedupeKeys(formatBindingsFor(c.id)) });
    }
    out.push({ category, entries });
  }
  return out;
}

/** Drop pure case variants ('v', 'V' → 'v') so the sheet stays readable. */
export function dedupeKeys(keys) {
  const out = [];
  const lower = new Set();
  for (const k of keys) {
    const l = k.length === 1 ? k.toLowerCase() : k;
    if (k.length === 1 && /[A-Z]/.test(k) && lower.has(l)) continue;
    lower.add(l);
    out.push(k);
  }
  return out;
}

/**
 * Hint bar entries for the current context (P-53).
 * @param {{overlay:string|null, view:string, waiting:boolean, hasSelection:boolean, reply:boolean}} ctx
 */
export function hintsFor({ overlay, view, hasSelection, reply }) {
  if (overlay === 'zoom') return [['↑↓', 'change session'], ['⏎', 'go to'], ['Esc', 'back']];
  if (overlay === 'usage') return [['$', 'dollars'], ['r', 'refresh'], ['u', 'back']];
  const hints = [];
  if (hasSelection) hints.push(['⏎', 'go to'], ['Space', 'zoom']);
  if (reply) hints.push(['⌥1–9', 'reply'], ['i', 'type reply']);
  hints.push(['a', 'next waiting'], ['/', 'filter'], ['s', 'sort'], ['v', 'view']);
  if (view === 'grid') hints.push(['A', 'all / agents']);
  hints.push(['⌘K', 'commands'], ['?', 'keys']);
  return hints;
}
