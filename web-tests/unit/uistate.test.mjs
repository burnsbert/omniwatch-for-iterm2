import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceUi, initialUi, unwindAction, keymapActive, UI_ACTIONS, TOAST_MS, FLASH_MS, MAX_TOASTS } from '../../omniwatch/web/js/uistate.js';

const r = (ui, a) => reduceUi(ui, a);

test('unknown / malformed actions are no-ops', () => {
  assert.equal(r(initialUi, null), initialUi);
  assert.equal(r(initialUi, { type: 'nope' }), initialUi);
  assert.equal(r(initialUi, {}), initialUi);
  assert.ok(UI_ACTIONS.includes('select'));
});

test('select resets label editing and re-pins the preview; same uid is a no-op', () => {
  const a = r({ ...initialUi, editingLabel: 'x', pinnedPreview: false }, { type: 'select', uid: 'u1' });
  assert.deepEqual([a.selectedUid, a.editingLabel, a.pinnedPreview], ['u1', null, true]);
  assert.equal(r(a, { type: 'select', uid: 'u1' }), a);
});

test('overlays: open / close / toggle', () => {
  let ui = r(initialUi, { type: 'openOverlay', overlay: 'zoom' });
  assert.equal(ui.overlay, 'zoom');
  assert.equal(r(ui, { type: 'openOverlay', overlay: 'zoom' }), ui);
  ui = r(ui, { type: 'toggleOverlay', overlay: 'usage' });
  assert.equal(ui.overlay, 'usage');
  ui = r(ui, { type: 'toggleOverlay', overlay: 'usage' });
  assert.equal(ui.overlay, null);
  assert.equal(r(ui, { type: 'closeOverlay' }), ui);
  assert.equal(r({ ...ui, overlay: 'zoom' }, { type: 'closeOverlay' }).overlay, null);
});

test('modals and menus', () => {
  let ui = r({ ...initialUi, menu: { type: 'sort' } }, { type: 'openModal', modal: { type: 'palette', query: '' } });
  assert.deepEqual([ui.modal.type, ui.menu], ['palette', null]);
  ui = r(ui, { type: 'updateModal', patch: { query: 'x' } });
  assert.equal(ui.modal.query, 'x');
  assert.equal(r(initialUi, { type: 'updateModal', patch: {} }), initialUi);
  ui = r(ui, { type: 'closeModal' });
  assert.equal(ui.modal, null);
  assert.equal(r(ui, { type: 'closeModal' }), ui);
  ui = r(ui, { type: 'openMenu', menu: { type: 'context', uid: 'a' } });
  assert.equal(ui.menu.uid, 'a');
  ui = r(ui, { type: 'closeMenu' });
  assert.equal(ui.menu, null);
  assert.equal(r(ui, { type: 'closeMenu' }), ui);
});

test('filter, label and project editing', () => {
  let ui = r(initialUi, { type: 'setFilter', filter: 'ab' });
  assert.equal(ui.filter, 'ab');
  assert.equal(r(ui, { type: 'setFilter', filter: 'ab' }), ui);
  ui = r(ui, { type: 'editLabel', uid: 'u' });
  assert.equal(ui.editingLabel, 'u');
  ui = r(ui, { type: 'stopEditLabel' });
  assert.equal(ui.editingLabel, null);
  assert.equal(r(ui, { type: 'stopEditLabel' }), ui);
  ui = r(ui, { type: 'editProject', slot: 3 });
  assert.deepEqual([ui.editingProject, ui.projectFocus], [3, 3]);
  ui = r(ui, { type: 'stopEditProject' });
  assert.equal(ui.editingProject, null);
  assert.equal(r(ui, { type: 'stopEditProject' }), ui);
  assert.equal(r(ui, { type: 'focusProject', slot: 3 }), ui);
  assert.equal(r(ui, { type: 'focusProject', slot: null }).projectFocus, null);
});

test('toasts: 5 s lifetime, capped, hover pauses and resumes (P-52)', () => {
  let ui = initialUi;
  for (let i = 0; i < MAX_TOASTS + 2; i += 1) ui = r(ui, { type: 'toast', level: 'info', message: `m${i}`, now: 1000 });
  assert.equal(ui.toasts.length, MAX_TOASTS);
  assert.equal(ui.toasts[0].message, 'm2');
  assert.equal(ui.toasts[0].until, 1000 + TOAST_MS);
  const id = ui.toasts[0].id;
  ui = r(ui, { type: 'pauseToast', id, now: 2000 });
  assert.equal(ui.toasts[0].paused, true);
  assert.equal(ui.toasts[0].remaining, TOAST_MS - 1000);
  ui = r(ui, { type: 'tick', now: 1000 + TOAST_MS + 1 });
  assert.equal(ui.toasts.length, 1, 'only the paused toast survives');
  ui = r(ui, { type: 'resumeToast', id, now: 10000 });
  assert.equal(ui.toasts[0].until, 10000 + TOAST_MS - 1000);
  assert.equal(r(ui, { type: 'resumeToast', id, now: 1 }).toasts[0].until, ui.toasts[0].until, 'resume only unpauses');
  ui = r(ui, { type: 'dismissToast', id });
  assert.equal(ui.toasts.length, 0);
  assert.equal(r(ui, { type: 'dismissToast', id }), ui);
  const t = r(initialUi, { type: 'toast', message: 'x', now: 0, extra: { command: 'c' } }).toasts[0];
  assert.deepEqual([t.level, t.command], ['info', 'c']);
  const short = r(r(initialUi, { type: 'toast', message: 'x', now: 0 }), { type: 'pauseToast', id: 1, now: 4999 });
  assert.equal(r(short, { type: 'resumeToast', id: 1, now: 100 }).toasts[0].until, 1600, 'resume keeps at least 1.5 s');
});

test('flash lasts 1.5 s and tick expires it (P-31)', () => {
  let ui = r(initialUi, { type: 'flash', uid: 'a', now: 100 });
  assert.equal(ui.flashes.a, 100 + FLASH_MS);
  assert.equal(r(ui, { type: 'tick', now: 200 }), ui, 'nothing expired → same object');
  ui = r(ui, { type: 'tick', now: 100 + FLASH_MS });
  assert.deepEqual(ui.flashes, {});
});

test('drawer lines clamp 3..40; misc setters', () => {
  assert.equal(r(initialUi, { type: 'setDrawerLines', lines: 1 }), initialUi);
  assert.equal(r(initialUi, { type: 'setDrawerLines', lines: 99 }).drawerLines, 40);
  assert.equal(r(initialUi, { type: 'setNotifyPermission', status: 'granted' }).notifyPermission, 'granted');
  assert.deepEqual(r(initialUi, { type: 'setDiagnostics', diagnostics: { a: 1 } }).diagnostics, { a: 1 });
  assert.equal(r(initialUi, { type: 'setPinned', pinned: true }), initialUi);
  assert.equal(r(initialUi, { type: 'setPinned', pinned: false }).pinnedPreview, false);
});

test('Esc unwinds menu → text entry → modal → overlay → filter → project focus, never quits (P-73)', () => {
  const full = {
    ...initialUi, menu: { type: 'sort' }, editingLabel: 'u', editingProject: 2, modal: { type: 'help' }, overlay: 'zoom', filter: 'x', projectFocus: 2,
  };
  const seq = [];
  let ui = full;
  for (;;) {
    const a = unwindAction(ui);
    if (!a) break;
    seq.push(a.type);
    ui = reduceUi(ui, a);
  }
  assert.deepEqual(seq, ['closeMenu', 'stopEditLabel', 'stopEditProject', 'closeModal', 'closeOverlay', 'setFilter', 'focusProject']);
  assert.equal(unwindAction(initialUi), null);
});

test('keymapActive is false while a modal or inline edit is open', () => {
  assert.equal(keymapActive(initialUi), true);
  assert.equal(keymapActive({ ...initialUi, modal: { type: 'help' } }), false);
  assert.equal(keymapActive({ ...initialUi, editingLabel: 'u' }), false);
});
