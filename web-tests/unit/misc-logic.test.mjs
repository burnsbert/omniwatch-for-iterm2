import { test } from 'node:test';
import assert from 'node:assert/strict';
import { offsetsFor, indexAt, windowFor, scrollToReveal, VIRTUALIZE_OVER } from '../../omniwatch/web/js/virtual.js';
import { resolveScheme, normalizeTheme, applyTheme, THEME_VALUES } from '../../omniwatch/web/js/theme.js';
import { normalizeKeyEvent, isModifierOnly, isTextFieldLike, zoomKeyAction, usageKeyAction, nextRegion } from '../../omniwatch/web/js/keyboard.js';
import { matchCommand } from '../../omniwatch/web/js/keymap.js';
import { sortMenuItems, contextMenuItems } from '../../omniwatch/web/js/components/menus.js';

test('virtual list: offsets and index lookup', () => {
  const off = offsetsFor([10, 20, 30]);
  assert.deepEqual(off, [0, 10, 30, 60]);
  assert.equal(indexAt(off, 0), 0);
  assert.equal(indexAt(off, 10), 1);
  assert.equal(indexAt(off, 59), 2);
  assert.equal(indexAt([0], 5), 0);
});

test('virtual list renders everything at or under the threshold (§2.1 "over 200 rows")', () => {
  const w = windowFor(new Array(VIRTUALIZE_OVER).fill(40), 1000, 400);
  assert.deepEqual([w.start, w.end, w.padTop, w.padBottom, w.virtual], [0, 200, 0, 0, false]);
});

test('virtual list windows large lists and always keeps the selection rendered', () => {
  const heights = new Array(1000).fill(40);
  const w = windowFor(heights, 4000, 400, { overscan: 5 });
  assert.equal(w.virtual, true);
  assert.equal(w.start, 95);
  assert.equal(w.end, 116);
  assert.equal(w.padTop, 95 * 40);
  assert.equal(w.padBottom, (1000 - 116) * 40);
  const keepLow = windowFor(heights, 4000, 400, { overscan: 0, keep: 3 });
  assert.equal(keepLow.start, 3);
  const keepHigh = windowFor(heights, 0, 400, { overscan: 0, keep: 900 });
  assert.equal(keepHigh.end, 901);
  assert.equal(windowFor(heights, -50, -1).start, 0);
});

test('scrollToReveal returns a new scrollTop only when needed', () => {
  const off = offsetsFor([40, 40, 40, 40]);
  assert.equal(scrollToReveal(off, 0, 50, 80), 0);
  assert.equal(scrollToReveal(off, 3, 0, 80), 80);
  assert.equal(scrollToReveal(off, 1, 0, 80), null);
  assert.equal(scrollToReveal(off, 9, 0, 80), null);
  assert.equal(scrollToReveal(off, -1, 0, 80), null);
});

test('theme resolution (§2.6)', () => {
  assert.equal(resolveScheme('light', false), 'light');
  assert.equal(resolveScheme('dark', true), 'dark');
  assert.equal(resolveScheme('high-contrast', true), 'dark');
  assert.equal(resolveScheme('system', true), 'light');
  assert.equal(resolveScheme('system', false), 'dark');
  assert.equal(normalizeTheme('neon'), 'system');
  assert.deepEqual(THEME_VALUES, ['system', 'dark', 'light', 'high-contrast']);
  const attrs = {};
  const props = {};
  const root = { setAttribute: (k, v) => { attrs[k] = v; }, style: { setProperty: (k, v) => { props[k] = v; } } };
  assert.equal(applyTheme(root, 'light', 1.2), 'light');
  assert.deepEqual([attrs['data-theme'], props['--ow-font-scale']], ['light', '1.2']);
  applyTheme(root, 'bogus', -1);
  assert.deepEqual([attrs['data-theme'], props['--ow-font-scale']], ['system', '1']);
});

test('key normalization: ⌥digit via code, shifted printables, ⌘ letters (P-83)', () => {
  assert.equal(normalizeKeyEvent({ key: '¡', code: 'Digit1', altKey: true }).key, '1');
  assert.equal(matchCommand(normalizeKeyEvent({ key: '¡', code: 'Digit1', altKey: true })), 'reply.send.1');
  assert.equal(matchCommand(normalizeKeyEvent({ key: '$', shiftKey: true })), 'dollars.toggle');
  assert.equal(matchCommand(normalizeKeyEvent({ key: 'A', shiftKey: true })), 'grid.toggleAll');
  assert.equal(matchCommand(normalizeKeyEvent({ key: '?', shiftKey: true })), 'help.open');
  assert.equal(matchCommand(normalizeKeyEvent({ key: 'Tab', shiftKey: true })), 'focusRegion.prev');
  assert.equal(matchCommand(normalizeKeyEvent({ key: '+', shiftKey: true, metaKey: true })), 'textSize.increase');
  assert.equal(matchCommand(normalizeKeyEvent({ key: 'K', metaKey: true })), 'commandPalette.open');
  assert.equal(normalizeKeyEvent({ key: 'x', altKey: true }).key, 'x');
  assert.equal(normalizeKeyEvent({ key: 'x', altKey: true, code: 'KeyX' }).key, 'x');
  assert.equal(isModifierOnly('Shift'), true);
  assert.equal(isModifierOnly('a'), false);
});

test('text-field detection', () => {
  assert.equal(isTextFieldLike({ tagName: 'input', type: 'search' }), true);
  assert.equal(isTextFieldLike({ tagName: 'INPUT' }), true);
  assert.equal(isTextFieldLike({ tagName: 'INPUT', type: 'checkbox' }), false);
  assert.equal(isTextFieldLike({ tagName: 'TEXTAREA' }), true);
  assert.equal(isTextFieldLike({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isTextFieldLike({ tagName: 'BUTTON' }), false);
  assert.equal(isTextFieldLike(), false);
});

test('zoom keys: ↑/↓ change session, ⏎ goes, anything else exits (P-47)', () => {
  const k = (key, extra = {}) => zoomKeyAction({ key, ...extra });
  assert.equal(k('ArrowUp'), 'move-up');
  assert.equal(k('k'), 'move-up');
  assert.equal(k('ArrowDown'), 'move-down');
  assert.equal(k('j'), 'move-down');
  assert.equal(k('Enter'), 'goto');
  assert.equal(k('g'), 'goto');
  assert.equal(k('Shift'), 'ignore');
  assert.equal(k('k', { metaKey: true }), 'passthrough');
  assert.equal(k('1', { altKey: true }), 'passthrough');
  assert.equal(k('i'), 'passthrough');
  assert.equal(k(' '), 'exit');
  assert.equal(k('Escape'), 'exit');
  assert.equal(k('x'), 'exit');
});

test('usage keys: $, r, u/q/Esc back (P-51)', () => {
  const k = (key, extra = {}) => usageKeyAction({ key, ...extra });
  assert.equal(k('$'), 'dollars');
  assert.equal(k('r'), 'refresh');
  assert.equal(k('R'), 'refresh');
  assert.equal(k('u'), 'close');
  assert.equal(k('q'), 'close');
  assert.equal(k('Escape'), 'close');
  assert.equal(k('?'), 'passthrough');
  assert.equal(k('k', { metaKey: true }), 'passthrough');
  assert.equal(k('Meta'), 'ignore');
  assert.equal(k('s'), 'ignore');
});

test('focus regions cycle and skip hidden ones (§2.5 Tab)', () => {
  const regions = ['toolbar', null, 'list', 'preview'];
  assert.equal(nextRegion(regions, 'toolbar', 1), 'list');
  assert.equal(nextRegion(regions, 'preview', 1), 'toolbar');
  assert.equal(nextRegion(regions, 'toolbar', -1), 'preview');
  assert.equal(nextRegion(regions, null, 1), 'toolbar');
  assert.equal(nextRegion(regions, null, -1), 'preview');
  assert.equal(nextRegion([null], 'x', 1), null);
});

test('sort menu marks the current sort (P-60)', () => {
  const items = sortMenuItems('attention');
  assert.deepEqual(items.map((i) => i.id), ['sort.set.natural', 'sort.set.attention', 'sort.set.agents', 'sort.set.activity', 'sort.set.path']);
  assert.deepEqual(items.filter((i) => i.checked).map((i) => i.label), ['Attention']);
});

test('context menu: go to, zoom, label, mute, 5 projects + clear, close (P-64/P-67)', () => {
  const projects = [1, 2, 3, 4, 5].map((slot) => ({ slot, name: slot === 1 ? 'api' : '', color: ['blue', 'purple', 'green', 'red', 'yellow'][slot - 1] }));
  const s = { uid: 'u', tab_color: 'blue', label: '', muted: false };
  const items = contextMenuItems(s, { projects, tabColors: true, reply: true });
  const ids = items.filter((i) => !i.sep).map((i) => i.id);
  assert.deepEqual(ids, ['session.goto', 'zoom.toggle', 'reply.focus', 'history.open', 'reveal.editor', 'reveal.finder', 'reveal.copyPath', 'label.edit', 'session.mute.toggle', 'color.set.1', 'color.set.2', 'color.set.3', 'color.set.4', 'color.set.5', 'color.clear', 'tab.close']);
  assert.ok(items.filter((i) => /^reveal\./.test(i.id || '')).every((i) => i.disabled), 'open-in needs a known path');
  assert.ok(contextMenuItems({ ...s, path: '/x' }, { projects }).filter((i) => /^reveal\./.test(i.id || '')).every((i) => !i.disabled));
  assert.equal(items.find((i) => i.id === 'color.set.1').checked, true);
  assert.equal(items.find((i) => i.id === 'color.set.1').label, 'api');
  assert.equal(items.find((i) => i.id === 'color.set.2').label, 'purple');
  assert.equal(items.find((i) => i.id === 'label.edit').label, 'Add label…');
  assert.equal(items.find((i) => i.id === 'session.mute.toggle').label, 'Mute');
  const off = contextMenuItems({ ...s, label: 'x', muted: true, tab_color: null }, { projects, tabColors: false });
  assert.ok(off.filter((i) => /^color\./.test(i.id || '')).every((i) => i.disabled));
  assert.equal(off.find((i) => i.id === 'session.mute.toggle').label, 'Unmute');
  assert.equal(off.find((i) => i.id === 'label.edit').label, 'Edit label…');
  assert.ok(!off.some((i) => i.id === 'reply.focus'));
  assert.equal(contextMenuItems(s).filter((i) => /^color\.set/.test(i.id || '')).length, 0);
});
