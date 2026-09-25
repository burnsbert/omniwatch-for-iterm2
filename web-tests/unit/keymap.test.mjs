import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BINDINGS, allBindings, matchCommand, formatBinding, formatBindingsFor } from '../../omniwatch/web/js/keymap.js';
import { COMMANDS, getCommand } from '../../omniwatch/web/js/commands.js';

function evt(key, mods = {}) {
  return { key, shiftKey: !!mods.shift, altKey: !!mods.alt, metaKey: !!mods.meta, ctrlKey: !!mods.ctrl };
}

test('every binding in BINDINGS points at a real command id', () => {
  for (const commandId of Object.keys(BINDINGS)) {
    assert.notEqual(getCommand(commandId), undefined, `BINDINGS has an entry for unknown command "${commandId}"`);
  }
});

test('no two bindings collide on the same key+modifiers', () => {
  const seen = new Map();
  for (const { commandId, binding } of allBindings()) {
    const sig = JSON.stringify([binding.key, !!binding.shift, !!binding.alt, !!binding.meta, !!binding.ctrl]);
    assert.equal(seen.has(sig), false, `key ${sig} bound to both "${seen.get(sig)}" and "${commandId}"`);
    seen.set(sig, commandId);
  }
});

// Table-driven parity check against every row of DESIGN.md §2.5.
const TABLE_ROWS = [
  [evt('ArrowUp'), 'move.up'],
  [evt('k'), 'move.up'],
  [evt('ArrowDown'), 'move.down'],
  [evt('j'), 'move.down'],
  [evt('ArrowLeft'), 'move.left'],
  [evt('ArrowRight'), 'move.right'],
  [evt('Enter'), 'session.goto'],
  [evt('g'), 'session.goto'],
  [evt('G'), 'session.goto'],
  [evt('a'), 'select.nextWaiting'],
  [evt(' '), 'zoom.toggle'],
  [evt('v'), 'view.cycle'],
  [evt('V'), 'view.cycle'],
  [evt('1', { meta: true }), 'view.split'],
  [evt('2', { meta: true }), 'view.list'],
  [evt('3', { meta: true }), 'view.grid'],
  [evt('>'), 'split.grow'],
  [evt('.'), 'split.grow'],
  [evt('<'), 'split.shrink'],
  [evt(','), 'split.shrink'],
  [evt('/'), 'filter.focus'],
  [evt('f', { meta: true }), 'filter.focus'],
  [evt('s'), 'sort.cycle'],
  [evt('S'), 'sort.cycle'],
  [evt('l'), 'label.edit'],
  [evt('L'), 'label.edit'],
  [evt('p'), 'projects.toggle'],
  [evt('P'), 'projects.toggle'],
  [evt('1'), 'color.set.1'],
  [evt('2'), 'color.set.2'],
  [evt('3'), 'color.set.3'],
  [evt('4'), 'color.set.4'],
  [evt('5'), 'color.set.5'],
  [evt('0'), 'color.clear'],
  [evt('c'), 'projects.clear'],
  [evt('C'), 'projects.clear'],
  [evt('n'), 'tab.new'],
  [evt('N'), 'tab.new'],
  [evt('x'), 'tab.close'],
  [evt('X'), 'tab.close'],
  [evt('u'), 'usage.toggle'],
  [evt('U'), 'usage.toggle'],
  [evt('u', { meta: true }), 'usage.toggle'],
  [evt('$'), 'dollars.toggle'],
  [evt('b'), 'sound.toggle'],
  [evt('B'), 'sound.toggle'],
  [evt('r'), 'refresh'],
  [evt('R'), 'refresh'],
  [evt('r', { meta: true }), 'refresh'],
  [evt('?'), 'help.open'],
  [evt('/', { meta: true }), 'help.open'],
  [evt('Escape'), 'unwind'],
  [evt('q'), 'window.close'],
  [evt('k', { meta: true }), 'commandPalette.open'],
  [evt(',', { meta: true }), 'settings.open'],
  [evt('i'), 'reply.focus'],
  [evt('1', { alt: true }), 'reply.send.1'],
  [evt('9', { alt: true }), 'reply.send.9'],
  [evt('+', { meta: true }), 'textSize.increase'],
  [evt('=', { meta: true }), 'textSize.increase'],
  [evt('-', { meta: true }), 'textSize.decrease'],
  [evt('0', { meta: true }), 'textSize.reset'],
  [evt('Tab'), 'focusRegion.next'],
  [evt('Tab', { shift: true }), 'focusRegion.prev'],
  [evt('A'), 'grid.toggleAll'],
];

test('§2.5 key parity table: every listed key resolves to its documented command', () => {
  for (const [event, expected] of TABLE_ROWS) {
    assert.equal(
      matchCommand(event),
      expected,
      `expected key ${JSON.stringify(event)} -> "${expected}", got "${matchCommand(event)}"`,
    );
  }
});

test('every non-modifier command in COMMANDS has at least one binding (nothing is unreachable)', () => {
  // Global app-only hotkeys (⌃⌥⌘O, next-waiting) and ⌘Q are intentionally
  // absent from the web keymap (native-only, §2.5/§4.7); every other
  // command must have a binding.
  for (const cmd of COMMANDS) {
    assert.ok(BINDINGS[cmd.id] && BINDINGS[cmd.id].length > 0, `command "${cmd.id}" has no key binding`);
  }
});

test('bare (non-chord) keys are suppressed while a text field has focus', () => {
  assert.equal(matchCommand(evt('s'), { inTextField: true }), null);
  assert.equal(matchCommand(evt('a'), { inTextField: true }), null);
});

test('Escape (unwind) still fires while a text field has focus', () => {
  assert.equal(matchCommand(evt('Escape'), { inTextField: true }), 'unwind');
});

test('Cmd-chord bindings still fire while a text field has focus', () => {
  assert.equal(matchCommand(evt('k', { meta: true }), { inTextField: true }), 'commandPalette.open');
  assert.equal(matchCommand(evt('1', { meta: true }), { inTextField: true }), 'view.split');
});

test('an unbound key resolves to null', () => {
  assert.equal(matchCommand(evt('z')), null);
});

test('formatBinding(): human-readable glyphs for modifiers and named keys', () => {
  assert.equal(formatBinding({ key: '1', meta: true }), '⌘1');
  assert.equal(formatBinding({ key: 'Tab', shift: true }), '⇧Tab');
  assert.equal(formatBinding({ key: 'Escape' }), 'Esc');
  assert.equal(formatBinding({ key: ' ' }), 'Space');
  assert.equal(formatBinding({ key: '1', alt: true }), '⌥1');
  assert.equal(formatBinding({ key: 'j' }), 'j');
});

test('formatBindingsFor(): every displayable binding for a command, in order', () => {
  assert.deepEqual(formatBindingsFor('view.cycle'), ['v', 'V']);
  assert.deepEqual(formatBindingsFor('does.not.exist'), []);
});
