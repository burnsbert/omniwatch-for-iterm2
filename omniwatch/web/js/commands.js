// commands.js — the full list of keyboard-driven commands (DESIGN.md
// §2.5), as data: id, human title, and the category used to group the
// shortcut sheet (§2.9: "grouped Navigate/Act/View/System") and rank the
// command palette (§2.5). No behavior lives here — WP5 wires each id to an
// actual handler (store dispatch / api.js call). keymap.js maps physical
// key combinations to these ids; this is the single source both read from.
//
// Excluded on purpose (native/app-only, not reachable from the web page):
// the global show/hide hotkey (default ⌃⌥⌘O), the global "next waiting in
// iTerm2" hotkey, and ⌘Q (Quit) — those are registered by the Swift shell
// (§2.5, §4.7), not by this web keymap.

export const CATEGORIES = Object.freeze(['Navigate', 'Act', 'View', 'System']);

/**
 * @typedef {object} Command
 * @property {string} id
 * @property {string} title
 * @property {'Navigate'|'Act'|'View'|'System'} category
 * @property {boolean} [paletteHidden]     not offered as a command-palette entry
 * @property {boolean} [allowInTextField]  fires even while a text input has focus
 */

/** @type {Command[]} */
export const COMMANDS = Object.freeze([
  // Navigate
  { id: 'move.up', title: 'Move selection up', category: 'Navigate' },
  { id: 'move.down', title: 'Move selection down', category: 'Navigate' },
  { id: 'move.left', title: 'Move selection left (grid)', category: 'Navigate' },
  { id: 'move.right', title: 'Move selection right (grid)', category: 'Navigate' },
  { id: 'session.goto', title: 'Go to session', category: 'Navigate' },
  { id: 'select.nextWaiting', title: 'Select next waiting session', category: 'Navigate' },
  { id: 'focusRegion.next', title: 'Cycle focus region forward', category: 'Navigate' },
  { id: 'focusRegion.prev', title: 'Cycle focus region backward', category: 'Navigate' },

  // Act
  { id: 'zoom.toggle', title: 'Zoom selection', category: 'Act' },
  { id: 'label.edit', title: 'Edit label', category: 'Act' },
  { id: 'color.set.1', title: 'Set tab color: project 1', category: 'Act' },
  { id: 'color.set.2', title: 'Set tab color: project 2', category: 'Act' },
  { id: 'color.set.3', title: 'Set tab color: project 3', category: 'Act' },
  { id: 'color.set.4', title: 'Set tab color: project 4', category: 'Act' },
  { id: 'color.set.5', title: 'Set tab color: project 5', category: 'Act' },
  { id: 'color.clear', title: 'Clear tab color', category: 'Act' },
  { id: 'projects.clear', title: 'Clear all projects', category: 'Act' },
  { id: 'tab.new', title: 'New iTerm2 tab', category: 'Act' },
  { id: 'tab.close', title: 'Close tab', category: 'Act' },
  { id: 'reply.focus', title: 'Focus reply field', category: 'Act' },
  { id: 'reply.send.1', title: 'Send reply option 1', category: 'Act' },
  { id: 'reply.send.2', title: 'Send reply option 2', category: 'Act' },
  { id: 'reply.send.3', title: 'Send reply option 3', category: 'Act' },
  { id: 'reply.send.4', title: 'Send reply option 4', category: 'Act' },
  { id: 'reply.send.5', title: 'Send reply option 5', category: 'Act' },
  { id: 'reply.send.6', title: 'Send reply option 6', category: 'Act' },
  { id: 'reply.send.7', title: 'Send reply option 7', category: 'Act' },
  { id: 'reply.send.8', title: 'Send reply option 8', category: 'Act' },
  { id: 'reply.send.9', title: 'Send reply option 9', category: 'Act' },
  { id: 'refresh', title: 'Refresh', category: 'Act' },

  // View
  { id: 'view.cycle', title: 'Cycle view', category: 'View' },
  { id: 'view.split', title: 'View: split', category: 'View' },
  { id: 'view.list', title: 'View: list', category: 'View' },
  { id: 'view.grid', title: 'View: grid', category: 'View' },
  { id: 'split.grow', title: 'Grow split (sidebar wider)', category: 'View' },
  { id: 'split.shrink', title: 'Shrink split (sidebar narrower)', category: 'View' },
  { id: 'filter.focus', title: 'Filter sessions', category: 'View' },
  { id: 'sort.cycle', title: 'Cycle sort', category: 'View' },
  { id: 'projects.toggle', title: 'Toggle projects panel', category: 'View' },
  { id: 'dollars.toggle', title: 'Toggle dollar amounts', category: 'View' },
  { id: 'sound.toggle', title: 'Toggle sound on attention', category: 'View' },
  { id: 'grid.toggleAll', title: 'Grid: all sessions / agents only', category: 'View' },
  { id: 'usage.toggle', title: 'Toggle usage view', category: 'View' },
  { id: 'textSize.increase', title: 'Increase text size', category: 'View' },
  { id: 'textSize.decrease', title: 'Decrease text size', category: 'View' },
  { id: 'textSize.reset', title: 'Reset text size', category: 'View' },

  // System
  { id: 'unwind', title: 'Cancel / close top overlay', category: 'System', allowInTextField: true },
  { id: 'window.close', title: 'Close window', category: 'System' },
  { id: 'commandPalette.open', title: 'Command palette', category: 'System', allowInTextField: true },
  { id: 'settings.open', title: 'Settings', category: 'System', allowInTextField: true },
  { id: 'help.open', title: 'Keyboard shortcuts', category: 'System' },
]);

const BY_ID = new Map(COMMANDS.map((c) => [c.id, c]));

/** @param {string} id @returns {Command|undefined} */
export function getCommand(id) {
  return BY_ID.get(id);
}

/** Commands eligible for the ⌘K command palette (everything except paletteHidden). */
export function paletteCommands() {
  return COMMANDS.filter((c) => !c.paletteHidden);
}

/** Commands grouped by category, in CATEGORIES order (for the shortcut sheet). */
export function commandsByCategory() {
  const groups = new Map(CATEGORIES.map((c) => [c, []]));
  for (const cmd of COMMANDS) {
    groups.get(cmd.category).push(cmd);
  }
  return groups;
}
