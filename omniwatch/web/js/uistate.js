// uistate.js — pure reducer for client-only UI state (selection, overlays,
// modals, inline editing, filter, menus, toasts, row flashes). Server
// state stays in reducer.js/store.js; this is the other half of what the
// components render. Times are passed in the action (`now`, epoch ms), so
// the reducer stays deterministic.

export const TOAST_MS = 5000; // P-52 / P-76 (toast 5 s)
export const FLASH_MS = 1500; // P-31 / P-76 (flash 1.5 s)
export const MAX_TOASTS = 4;

export const initialUi = Object.freeze({
  selectedUid: null,
  overlay: null, // null | 'zoom' | 'usage'
  modal: null, // null | {type:'help'|'palette'|'settings'|'onboarding'|'confirm', ...}
  menu: null, // null | {type:'sort'|'context'|'view', uid?, x?, y?}
  filter: '',
  editingLabel: null, // uid being labelled
  editingProject: null, // slot 1..5 being renamed
  projectFocus: null, // slot 1..5 focused by keyboard (P-63)
  toasts: [], // {id, level, message, until, paused}
  toastSeq: 0,
  flashes: {}, // uid -> until (epoch ms)
  drawerLines: 3, // list view preview drawer (P-44)
  notifyPermission: null, // 'granted'|'denied'|'notDetermined'|'error'|null
  diagnostics: null,
  pinnedPreview: true,
  // The backend's `theme` pref is system|dark|light only (API.md §4), so the
  // high-contrast choice is a client-side override on top of it.
  highContrast: false,
});

function withToast(ui, level, message, now, extra = {}) {
  const id = ui.toastSeq + 1;
  const toast = { id, level: level || 'info', message: String(message), until: now + TOAST_MS, ...extra };
  const toasts = [...ui.toasts, toast].slice(-MAX_TOASTS);
  return { ...ui, toastSeq: id, toasts };
}

const HANDLERS = {
  select(ui, a) {
    if (ui.selectedUid === a.uid) return ui;
    return { ...ui, selectedUid: a.uid, editingLabel: null, pinnedPreview: true };
  },
  openOverlay(ui, a) {
    if (ui.overlay === a.overlay) return ui;
    return { ...ui, overlay: a.overlay, menu: null };
  },
  closeOverlay(ui) {
    if (!ui.overlay) return ui;
    return { ...ui, overlay: null };
  },
  toggleOverlay(ui, a) {
    return { ...ui, overlay: ui.overlay === a.overlay ? null : a.overlay, menu: null };
  },
  openModal(ui, a) {
    return { ...ui, modal: a.modal, menu: null };
  },
  updateModal(ui, a) {
    if (!ui.modal) return ui;
    return { ...ui, modal: { ...ui.modal, ...a.patch } };
  },
  closeModal(ui) {
    if (!ui.modal) return ui;
    return { ...ui, modal: null };
  },
  openMenu(ui, a) {
    return { ...ui, menu: a.menu };
  },
  closeMenu(ui) {
    if (!ui.menu) return ui;
    return { ...ui, menu: null };
  },
  setFilter(ui, a) {
    if (ui.filter === a.filter) return ui;
    return { ...ui, filter: a.filter };
  },
  editLabel(ui, a) {
    return { ...ui, editingLabel: a.uid, menu: null };
  },
  stopEditLabel(ui) {
    if (ui.editingLabel === null) return ui;
    return { ...ui, editingLabel: null };
  },
  editProject(ui, a) {
    return { ...ui, editingProject: a.slot, projectFocus: a.slot, menu: null };
  },
  stopEditProject(ui) {
    if (ui.editingProject === null) return ui;
    return { ...ui, editingProject: null };
  },
  focusProject(ui, a) {
    if (ui.projectFocus === a.slot) return ui;
    return { ...ui, projectFocus: a.slot };
  },
  toast(ui, a) {
    return withToast(ui, a.level, a.message, a.now, a.extra);
  },
  dismissToast(ui, a) {
    const toasts = ui.toasts.filter((t) => t.id !== a.id);
    return toasts.length === ui.toasts.length ? ui : { ...ui, toasts };
  },
  pauseToast(ui, a) {
    // Hover pauses the countdown (P-52): remember how much time was left.
    const toasts = ui.toasts.map((t) => (t.id === a.id && !t.paused
      ? { ...t, paused: true, remaining: Math.max(0, t.until - a.now) } : t));
    return { ...ui, toasts };
  },
  resumeToast(ui, a) {
    const toasts = ui.toasts.map((t) => (t.id === a.id && t.paused
      ? { ...t, paused: false, until: a.now + Math.max(1500, t.remaining || 0) } : t));
    return { ...ui, toasts };
  },
  flash(ui, a) {
    return { ...ui, flashes: { ...ui.flashes, [a.uid]: a.now + FLASH_MS } };
  },
  tick(ui, a) {
    // Expire toasts and flashes; returns the same object if nothing changed.
    const toasts = ui.toasts.filter((t) => t.paused || t.until > a.now);
    let flashesChanged = false;
    const flashes = {};
    for (const [uid, until] of Object.entries(ui.flashes)) {
      if (until > a.now) flashes[uid] = until;
      else flashesChanged = true;
    }
    if (toasts.length === ui.toasts.length && !flashesChanged) return ui;
    return { ...ui, toasts, flashes: flashesChanged ? flashes : ui.flashes };
  },
  setDrawerLines(ui, a) {
    const n = Math.max(3, Math.min(40, Math.round(a.lines)));
    return n === ui.drawerLines ? ui : { ...ui, drawerLines: n };
  },
  setNotifyPermission(ui, a) {
    return { ...ui, notifyPermission: a.status };
  },
  setDiagnostics(ui, a) {
    return { ...ui, diagnostics: a.diagnostics };
  },
  setHighContrast(ui, a) {
    return ui.highContrast === !!a.on ? ui : { ...ui, highContrast: !!a.on };
  },
  setPinned(ui, a) {
    return ui.pinnedPreview === a.pinned ? ui : { ...ui, pinnedPreview: a.pinned };
  },
};

/**
 * @param {object} ui
 * @param {{type:string, [k:string]:any}} action
 */
export function reduceUi(ui, action) {
  if (!action || typeof action.type !== 'string') return ui;
  const handler = HANDLERS[action.type];
  return handler ? handler(ui, action) : ui;
}

export const UI_ACTIONS = Object.freeze(Object.keys(HANDLERS));

/**
 * What Esc should undo next (P-73): menu → text entry → modal (confirm,
 * palette, sheets) → overlay (zoom/usage) → filter → project focus. Never
 * quits. Returns the action to dispatch, or null when there's nothing left.
 */
export function unwindAction(ui) {
  if (ui.menu) return { type: 'closeMenu' };
  if (ui.editingLabel !== null) return { type: 'stopEditLabel' };
  if (ui.editingProject !== null) return { type: 'stopEditProject' };
  if (ui.modal) return { type: 'closeModal' };
  if (ui.overlay) return { type: 'closeOverlay' };
  if (ui.filter) return { type: 'setFilter', filter: '' };
  if (ui.projectFocus !== null) return { type: 'focusProject', slot: null };
  return null;
}

/** Whether bare-key shortcuts should be routed to the main keymap right now. */
export function keymapActive(ui) {
  if (ui.modal) return false;
  if (ui.editingLabel !== null || ui.editingProject !== null) return false;
  return true;
}
