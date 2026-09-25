// palette.js — ⌘K command palette items and ranking (§2.5). Pure: the
// palette component renders `paletteResults()` and runs the chosen item.
// Items are every keymap command worth offering, a few palette-only
// actions (theme, mute, keep on top, …), and every session ("Go to …").
// Uses the same fuzzy matcher as the filter, with matched characters
// highlighted via `highlightSegments()`.

import { COMMANDS } from './commands.js';
import { formatBindingsFor } from './keymap.js';
import { rankFuzzyMatches } from './fuzzy.js';
import { SORT_CYCLE } from './sort.js';
import { stateLabel, agentLabel } from './viewmodel.js';

export const MAX_RESULTS = 60;

// Keymap commands that make no sense as a palette entry (pure navigation).
const HIDDEN = new Set([
  'move.up', 'move.down', 'move.left', 'move.right', 'focusRegion.next', 'focusRegion.prev',
  'unwind', 'commandPalette.open',
  'reply.send.1', 'reply.send.2', 'reply.send.3', 'reply.send.4', 'reply.send.5',
  'reply.send.6', 'reply.send.7', 'reply.send.8', 'reply.send.9',
]);

/** Palette-only actions (no key binding; ids are handled by actions.js). */
export const EXTRA_ACTIONS = Object.freeze([
  { id: 'theme.system', title: 'Theme: match system', category: 'View' },
  { id: 'theme.dark', title: 'Theme: dark', category: 'View' },
  { id: 'theme.light', title: 'Theme: light', category: 'View' },
  { id: 'theme.high-contrast', title: 'Theme: high contrast', category: 'View' },
  { id: 'session.mute.toggle', title: 'Mute / unmute session', category: 'Act' },
  { id: 'keepOnTop.toggle', title: 'Keep window on top', category: 'System' },
  { id: 'quickReply.toggle', title: 'Turn quick reply on / off', category: 'System' },
  { id: 'hintBar.toggle', title: 'Show / hide shortcut hints', category: 'View' },
  { id: 'usageStrip.toggle', title: 'Collapse / expand usage strip', category: 'View' },
  { id: 'notifications.toggle', title: 'Turn notifications on / off', category: 'System' },
  { id: 'debugRule.toggle', title: 'Show classifier rule in preview', category: 'System' },
  { id: 'onboarding.open', title: 'Setup guide', category: 'System' },
  { id: 'stats.open', title: 'Blocked on you today', category: 'View' },
  { id: 'iterm.launch', title: 'Launch iTerm2', category: 'Act' },
  ...SORT_CYCLE.map((s) => ({ id: `sort.set.${s}`, title: `Sort: ${s}`, category: 'View' })),
]);

/**
 * All palette items for the current state.
 * @param {{sessions:object[], projects?:object[], reply?:object|null, now:number}} ctx
 */
export function paletteItems({ sessions = [], projects = [], reply = null, now = 0 } = {}) {
  const items = [];
  // Waiting sessions first: they're what the palette is most often opened for.
  const byWait = [...sessions].sort((a, b) => {
    const wa = a.state === 'waiting' ? 0 : 1;
    const wb = b.state === 'waiting' ? 0 : 1;
    return wa - wb || (a.state_since || 0) - (b.state_since || 0);
  });
  if (reply) {
    for (const o of reply.options) {
      items.push({
        key: `reply-${o.index}`, kind: 'command', command: `reply.send.${o.index}`,
        title: `Reply: ${o.key}. ${o.label}`, subtitle: reply.question || 'Quick reply', shortcut: o.shortcut,
      });
    }
  }
  for (const s of byWait.filter((x) => x.state === 'waiting')) items.push(sessionItem(s, now));
  for (const c of COMMANDS) {
    if (HIDDEN.has(c.id)) continue;
    let title = c.title;
    const m = /^color\.set\.(\d)$/.exec(c.id);
    if (m) {
      const p = projects.find((x) => x.slot === Number(m[1]));
      if (p) title = `Set tab color: ${p.color}${p.name ? ` (${p.name})` : ''}`;
    }
    items.push({
      key: `cmd-${c.id}`, kind: 'command', command: c.id, title, subtitle: c.category,
      shortcut: formatBindingsFor(c.id)[0] || '',
    });
  }
  for (const c of EXTRA_ACTIONS) {
    items.push({ key: `cmd-${c.id}`, kind: 'command', command: c.id, title: c.title, subtitle: c.category, shortcut: '' });
  }
  for (const s of byWait.filter((x) => x.state !== 'waiting')) items.push(sessionItem(s, now));
  return items;
}

function sessionItem(s, now) {
  const name = s.label || s.display_name || s.name || '';
  const path = s.path_display || '~';
  const title = name ? `Go to ${path} · ${name}` : `Go to ${path}`;
  const bits = [stateLabel(s.state)];
  if (s.state === 'waiting' && s.state_since) bits[0] = `Waiting ${Math.max(0, Math.floor((now - s.state_since) / 60))}m`;
  const agent = agentLabel(s.agent);
  if (agent) bits.push(agent);
  if (s.tab_label) bits.push(`tab ${s.tab_label}`);
  return {
    key: `ses-${s.uid}`, kind: 'session', uid: s.uid, command: 'session.goto', args: { uid: s.uid },
    title, subtitle: bits.join(' · '), shortcut: '⏎', state: s.state || 'unknown', agent: s.agent || '',
  };
}

/** Ranked results for a query; an empty query keeps the natural item order. */
export function paletteResults(query, items, limit = MAX_RESULTS) {
  const q = (query || '').trim();
  if (!q) return items.slice(0, limit).map((item) => ({ item, indices: [] }));
  return rankFuzzyMatches(q, items, (it) => it.title).slice(0, limit)
    .map(({ item, indices }) => ({ item, indices }));
}

/** Split `text` into [{text, match}] runs for highlighting matched characters. */
export function highlightSegments(text, indices) {
  const set = new Set(indices || []);
  const out = [];
  let run = '';
  let runMatch = null;
  Array.from(String(text)).forEach((ch, i) => {
    // fuzzyScore indexes UTF-16 code units; for the BMP text we match these agree.
    const m = set.has(i);
    if (runMatch === null || m === runMatch) {
      run += ch;
      runMatch = m;
    } else {
      out.push({ text: run, match: runMatch });
      run = ch;
      runMatch = m;
    }
  });
  if (run) out.push({ text: run, match: !!runMatch });
  return out;
}

/** Wrap-around palette cursor movement. */
export function moveCursor(index, delta, count) {
  if (count <= 0) return 0;
  return ((index + delta) % count + count) % count;
}
