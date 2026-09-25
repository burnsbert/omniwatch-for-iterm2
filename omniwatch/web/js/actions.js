// actions.js — the controller: turns command ids (keymap, palette, native
// menu, buttons) into UI-state changes, API calls, native bridge messages
// and toasts. DOM-independent: every side effect goes through injected
// dependencies, so the toast texts and guards that matter for parity
// (P-57/58/64/65/66/67/68/69/71 …) are unit-tested in Node with fakes.

import { derive, moveSelection, nextView, nextWaitingUid, stepSplit, clampFontScale, sessionTitle, FONT_SCALE_STEP, PROJECT_COLORS, SPLIT_MIN_WIDTH } from './viewmodel.js';
import { nextSort, SORT_CYCLE } from './sort.js';
import { unwindAction } from './uistate.js';
import { replyModel, validateReplyText, replyErrorMessage, normalizeLabel, normalizeProjectName } from './reply.js';

export const VISIT_DEBOUNCE_MS = 150; // P-56
export const THEMES = Object.freeze(['system', 'dark', 'light', 'high-contrast']);
export const HIGH_CONTRAST_KEY = 'omniwatch.highContrast';
export const AUTOMATION_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation';

/** Native menu / hotkey ids (SHELL_CONTRACT §6) → keymap command ids. */
export const NATIVE_ALIASES = Object.freeze({
  'palette.open': 'commandPalette.open',
  'shortcuts.open': 'help.open',
  'usage.open': 'usage.open',
  'font.increase': 'textSize.increase',
  'font.decrease': 'textSize.decrease',
  'font.reset': 'textSize.reset',
  'session.nextWaiting': 'select.nextWaiting',
});

/**
 * @param {object} deps
 * @param {() => object} deps.getServer
 * @param {(event:object) => void} deps.dispatchServer
 * @param {() => object} deps.getUi
 * @param {(action:object) => void} deps.dispatchUi
 * @param {object} deps.api     api.js instance (or a fake)
 * @param {object} deps.native  native.js bridge (or a fake)
 * @param {object} deps.env     {nowMs, nowS, width, gridCols, focusFilter, focusReply, focusRegion, playChime,
 *                               setTimeout, clearTimeout, openUrl, notifyBrowser, requestBrowserPermission}
 */
export function createController({ getServer, dispatchServer, getUi, dispatchUi, api, native, env }) {
  let visitTimer = null;
  const recentToasts = new Map(); // message -> ms, to drop duplicate server echoes

  const nowMs = () => env.nowMs();
  const current = () => derive(getServer(), getUi(), env.width());
  const prefs = () => getServer().prefs || {};
  const selected = () => current().selected;

  function toast(level, message, extra) {
    recentToasts.set(message, nowMs());
    dispatchUi({ type: 'toast', level, message, now: nowMs(), extra });
    const live = level === 'error' ? env.announceAssertive : env.announcePolite;
    if (live) live(message);
  }

  /** Server `toast` events: skip one we just showed locally (e.g. 'refreshing…'). */
  function serverToast(data) {
    const at = recentToasts.get(data.message);
    if (at && nowMs() - at < 2000) return;
    toast(data.level || 'info', data.message);
  }

  function fail(kind, err) {
    toast('error', `${kind} failed: ${(err && err.message) || 'unknown error'}`);
  }

  // ---- prefs -------------------------------------------------------------

  // In-flight pref values: key -> {value, id}. A `prefs` echo of an *earlier*
  // PATCH must not undo a newer optimistic value (fast `s s s` presses), so
  // pending values are re-applied over server prefs until their own PATCH settles.
  const pendingPrefs = new Map();
  let patchSeq = 0;
  const pendingValues = () => Object.fromEntries([...pendingPrefs].map(([k, v]) => [k, v.value]));

  function applyPrefs(prefsObj) {
    const srv = getServer();
    dispatchServer({ type: 'prefs', data: { seq: srv.seq, prefs: { ...prefsObj, ...pendingValues() }, projects: srv.projects } });
  }

  /** Optimistic PATCH /prefs: apply locally, then let the server response win. */
  async function patchPrefs(patch) {
    const id = ++patchSeq;
    const server = getServer();
    const before = { ...(server.prefs || {}) };
    for (const [k, v] of Object.entries(patch)) pendingPrefs.set(k, { value: v, id });
    applyPrefs({ ...before, ...patch });
    const settle = () => {
      for (const k of Object.keys(patch)) if (pendingPrefs.get(k) && pendingPrefs.get(k).id === id) pendingPrefs.delete(k);
    };
    try {
      const res = await api.patchPrefs(patch);
      settle();
      const full = res && (res.prefs || (res.view !== undefined ? res : null));
      applyPrefs({ ...getServer().prefs, ...(full || {}) });
      return true;
    } catch (err) {
      settle();
      // Put back what the server still has (the optimistic value was refused).
      const reverted = { ...(getServer().prefs || {}) };
      for (const k of Object.keys(patch)) if (!pendingPrefs.has(k) && k in before) reverted[k] = before[k];
      applyPrefs(reverted);
      fail('settings', err);
      return false;
    }
  }

  // ---- selection ---------------------------------------------------------

  function selectUid(uid) {
    if (!uid) return;
    const before = getUi().selectedUid;
    dispatchUi({ type: 'select', uid });
    if (before !== uid) scheduleVisit(uid);
  }

  function scheduleVisit(uid) {
    if (visitTimer) env.clearTimeout(visitTimer);
    visitTimer = env.setTimeout(() => {
      visitTimer = null;
      const s = (getServer().sessions || []).find((x) => x.uid === uid);
      if (!s || !s.attention) return;
      const sessions = getServer().sessions.map((x) => (x.uid === uid ? { ...x, attention: false } : x));
      const srv = getServer();
      dispatchServer({
        type: 'sessions',
        data: { seq: srv.seq, sessions, summary: srv.summary, windows: srv.windows, iterm: srv.iterm },
      });
      Promise.resolve(api.visit(uid)).catch(() => {});
    }, VISIT_DEBOUNCE_MS);
  }

  /** Make sure UI selection matches what's on screen (snap-back, P-55). */
  function syncSelection() {
    // Snap-back/initial selection doesn't count as a visit (TUI parity).
    const d = current();
    if (d.selectedUid !== getUi().selectedUid && d.selectedUid) dispatchUi({ type: 'select', uid: d.selectedUid });
  }

  function move(delta, axis) {
    const ui = getUi();
    const d = current();
    const p = prefs();
    // Projects panel keyboard focus (P-63): ↑ from the top row enters the slots.
    if (d.view !== 'grid' && p.projects_open && !ui.overlay) {
      if (ui.projectFocus !== null) {
        const next = ui.projectFocus + delta;
        if (next < 1) return;
        if (next > PROJECT_COLORS.length) {
          dispatchUi({ type: 'focusProject', slot: null });
          if (d.active.length) selectUid(d.active[0].uid);
          return;
        }
        dispatchUi({ type: 'focusProject', slot: next });
        return;
      }
      if (axis === 'row' && delta < 0 && d.active.length && d.active[0].uid === d.selectedUid) {
        dispatchUi({ type: 'focusProject', slot: PROJECT_COLORS.length });
        return;
      }
    }
    if (axis === 'col' && d.view !== 'grid' && ui.overlay !== 'zoom') return;
    let step = delta;
    if (d.view === 'grid' && axis === 'row' && ui.overlay !== 'zoom') step = delta * Math.max(1, env.gridCols());
    const uid = moveSelection(d.active, d.selectedUid, step);
    if (uid) selectUid(uid);
  }

  // ---- session actions ---------------------------------------------------

  async function gotoSession(uid) {
    const s = uid ? (getServer().sessions || []).find((x) => x.uid === uid) : selected();
    if (!s) return;
    try {
      await api.goto(s.uid);
      toast('info', `→ tab ${s.tab_label}`);
    } catch (err) {
      toast('error', `goto failed: ${err && err.status === 404 ? 'session not found' : (err && err.message) || 'unknown error'}`);
    }
  }

  function selectNextWaiting() {
    const d = current();
    const uid = nextWaitingUid(getServer().sessions, d.selectedUid);
    if (!uid) {
      toast('info', 'no sessions waiting');
      return;
    }
    // If the filter hides it, clear the filter so the selection is visible.
    const visible = d.active.some((s) => s.uid === uid);
    if (!visible && getUi().filter) dispatchUi({ type: 'setFilter', filter: '' });
    dispatchUi({ type: 'focusProject', slot: null });
    selectUid(uid);
  }

  async function setColor(n, uid) {
    const s = uid ? (getServer().sessions || []).find((x) => x.uid === uid) : selected();
    if (!s) return;
    const caps = getServer().capabilities || {};
    if (caps.tab_colors === false) {
      toast('warn', 'tab colors unavailable — see setup', { command: 'onboarding.open', args: { step: 2 }, actionLabel: 'Set up' });
      return;
    }
    try {
      if (n === 0) {
        await api.setColor(s.uid, null);
        toast('info', `tab ${s.tab_label}: color cleared`);
      } else {
        const project = (getServer().projects || []).find((x) => x.slot === n);
        const color = (project && project.color) || PROJECT_COLORS[n - 1];
        await api.setColor(s.uid, n);
        toast('info', `tab ${s.tab_label} → ${color}${project && project.name ? ` (${project.name})` : ''}`);
      }
    } catch (err) {
      if (err && err.code === 'tab_colors_unavailable') {
        toast('warn', 'tab colors unavailable — see setup', { command: 'onboarding.open', args: { step: 2 }, actionLabel: 'Set up' });
      } else fail('color', err);
    }
  }

  async function setMuted(uid, muted) {
    const s = (getServer().sessions || []).find((x) => x.uid === uid);
    if (!s) return;
    const want = muted === undefined ? !s.muted : !!muted;
    try {
      await api.setMuted(uid, want);
      updateSessionLocally(uid, { muted: want });
      toast('info', `${sessionTitle(s)} ${want ? 'muted' : 'unmuted'}`);
    } catch (err) {
      fail('mute', err);
    }
  }

  function updateSessionLocally(uid, patch) {
    const srv = getServer();
    const sessions = (srv.sessions || []).map((x) => (x.uid === uid ? { ...x, ...patch } : x));
    dispatchServer({ type: 'sessions', data: { seq: srv.seq, sessions, summary: srv.summary, windows: srv.windows, iterm: srv.iterm } });
  }

  async function saveLabel(uid, raw) {
    const label = normalizeLabel(raw);
    dispatchUi({ type: 'stopEditLabel' });
    const s = (getServer().sessions || []).find((x) => x.uid === uid);
    if (!s || (s.label || '') === label) return;
    updateSessionLocally(uid, {
      label,
      display_name: label || s.name,
      title: label || s.title,
    });
    try {
      await api.setLabel(uid, label);
    } catch (err) {
      updateSessionLocally(uid, { label: s.label, display_name: s.display_name, title: s.title });
      fail('label', err);
    }
  }

  async function saveProject(slot, raw) {
    const name = normalizeProjectName(raw);
    dispatchUi({ type: 'stopEditProject' });
    const srv = getServer();
    const projects = (srv.projects || []).map((p) => (p.slot === slot ? { ...p, name } : p));
    dispatchServer({ type: 'prefs', data: { seq: srv.seq, prefs: srv.prefs, projects } });
    try {
      await api.setProject(slot, name);
    } catch (err) {
      dispatchServer({ type: 'prefs', data: { seq: srv.seq, prefs: srv.prefs, projects: srv.projects } });
      fail('project', err);
    }
  }

  function confirm(modal) {
    dispatchUi({ type: 'openModal', modal: { type: 'confirm', ...modal } });
  }

  function askCloseTab(uid) {
    const s = uid ? (getServer().sessions || []).find((x) => x.uid === uid) : selected();
    if (!s) return;
    const name = s.label || s.display_name || s.path_display || '';
    confirm({
      title: `Close tab ${s.tab_label}${name ? ` (${name})` : ''}?`,
      body: 'The iTerm2 tab and everything running in it will be closed.',
      confirmLabel: 'Close tab',
      danger: true,
      command: 'tab.close.confirmed',
      args: { uid: s.uid, tab: s.tab_label },
    });
  }

  async function closeTabConfirmed(args) {
    dispatchUi({ type: 'closeModal' });
    try {
      await api.closeTab(args.uid);
      toast('info', `closing tab ${args.tab}…`);
    } catch (err) {
      fail('close', err);
    }
  }

  function askClearProjects() {
    confirm({
      title: 'Clear all 5 project names?',
      body: 'Tab colors in iTerm2 are left as they are.',
      confirmLabel: 'Clear projects',
      danger: true,
      command: 'projects.clear.confirmed',
    });
  }

  async function clearProjectsConfirmed() {
    dispatchUi({ type: 'closeModal' });
    try {
      await api.clearProjects();
      const srv = getServer();
      dispatchServer({
        type: 'prefs',
        data: { seq: srv.seq, prefs: srv.prefs, projects: (srv.projects || []).map((p) => ({ ...p, name: '' })) },
      });
      toast('info', 'projects cleared');
    } catch (err) {
      fail('projects', err);
    }
  }

  // ---- quick reply -------------------------------------------------------

  function currentReply() {
    const srv = getServer();
    return replyModel(selected(), srv.prefs, srv.capabilities);
  }

  async function sendReply(uid, text, submit) {
    const srv = getServer();
    const s = (srv.sessions || []).find((x) => x.uid === uid);
    const model = replyModel(s, srv.prefs, srv.capabilities);
    if (!model) {
      toast('warn', 'That session is no longer waiting for a reply');
      return false;
    }
    const v = validateReplyText(text);
    if (!v.ok) {
      toast('warn', v.error);
      return false;
    }
    try {
      await api.reply(uid, { text: v.text, submit: !!submit, expectHash: model.hash });
      toast('info', `Replied to ${sessionTitle(s)}`);
      return true;
    } catch (err) {
      toast(err && (err.status === 409 || err.code === 'stale_screen') ? 'warn' : 'error', replyErrorMessage(err));
      return false;
    }
  }

  function sendOption(index) {
    const model = currentReply();
    if (!model) return false;
    const opt = model.options.find((o) => o.index === index);
    if (!opt) return false;
    return sendReply(model.uid, opt.key, false);
  }

  // ---- view --------------------------------------------------------------

  function setView(view) {
    if (view === 'split' && env.width() < SPLIT_MIN_WIDTH) {
      toast('info', 'Split view needs a wider window — showing the list');
    }
    dispatchUi({ type: 'closeOverlay' });
    return patchPrefs({ view });
  }

  function textSize(delta) {
    const cur = prefs().font_scale || 1;
    const next = delta === 0 ? 1 : clampFontScale(cur + delta * FONT_SCALE_STEP);
    if (next === cur) return undefined;
    return patchPrefs({ font_scale: next });
  }

  function windowClose() {
    const ui = getUi();
    if (ui.overlay) {
      dispatchUi({ type: 'closeOverlay' });
      return;
    }
    if (!native.isNativeHost()) return; // P-73: `q` does nothing in --browser mode
    if (prefs().close_window_on_q === false) return;
    native.closeWindow();
  }

  function setKeepOnTop(value) {
    const want = value === undefined ? !prefs().keep_on_top : !!value;
    native.setKeepOnTop(want);
    if (!native.isNativeHost()) toast('info', 'Keep on top works in the Omniwatch app window');
    return patchPrefs({ keep_on_top: want });
  }

  /**
   * system/dark/light persist in the backend prefs; high contrast is a
   * client-local override (the API only accepts system|dark|light), kept in
   * localStorage where available.
   */
  async function setTheme(theme) {
    if (theme !== 'high-contrast') {
      dispatchUi({ type: 'setHighContrast', on: false });
      if (env.localSet) env.localSet(HIGH_CONTRAST_KEY, '');
      return patchPrefs({ theme });
    }
    // Prefer the real pref; a backend that only knows system|dark|light
    // answers 422, and then high contrast stays a client-side override.
    dispatchUi({ type: 'setHighContrast', on: true });
    try {
      const res = await api.patchPrefs({ theme: 'high-contrast' });
      const srv = getServer();
      const full = res && res.theme ? res : { ...(srv.prefs || {}), theme: 'high-contrast' };
      dispatchServer({ type: 'prefs', data: { seq: srv.seq, prefs: { ...srv.prefs, ...full }, projects: srv.projects } });
      if (env.localSet) env.localSet(HIGH_CONTRAST_KEY, '');
      return true;
    } catch (err) {
      if (err && (err.status === 422 || err.code === 'invalid')) {
        if (env.localSet) env.localSet(HIGH_CONTRAST_KEY, '1');
        return true;
      }
      dispatchUi({ type: 'setHighContrast', on: false });
      fail('settings', err);
      return false;
    }
  }

  // ---- open in… / activity / stats ------------------------------------

  async function reveal(uid, target) {
    const s = uid ? (getServer().sessions || []).find((x) => x.uid === uid) : selected();
    if (!s) return false;
    try {
      await api.reveal(s.uid, target);
      return true; // the result arrives as an `action` event (kind `reveal`)
    } catch (err) {
      toast(err && err.status === 422 ? 'warn' : 'error', err && err.status === 422
        ? (err.message || 'no known path for this session')
        : `reveal failed: ${(err && err.message) || 'unknown error'}`);
      return false;
    }
  }

  function openHistory(uid) {
    const s = uid ? { uid } : selected();
    if (!s) return;
    dispatchUi({ type: 'openModal', modal: { type: 'history', uid: s.uid } });
    if (env.loadHistory) env.loadHistory(s.uid);
  }

  function openPalette() {
    dispatchUi({ type: 'openModal', modal: { type: 'palette', query: '', index: 0 } });
  }

  // ---- the command table -------------------------------------------------

  const table = {
    'move.up': () => move(-1, 'row'),
    'move.down': () => move(1, 'row'),
    'move.left': () => move(-1, 'col'),
    'move.right': () => move(1, 'col'),
    'session.goto': (args) => {
      const ui = getUi();
      if (!args && ui.projectFocus !== null && !ui.overlay) {
        dispatchUi({ type: 'editProject', slot: ui.projectFocus });
        return undefined;
      }
      return gotoSession(args && args.uid);
    },
    'session.select': (args) => {
      if (!args || !args.uid) return;
      const d = current();
      if (!d.active.some((s) => s.uid === args.uid) && getUi().filter) dispatchUi({ type: 'setFilter', filter: '' });
      dispatchUi({ type: 'focusProject', slot: null });
      selectUid(args.uid);
    },
    'select.nextWaiting': () => selectNextWaiting(),
    'focusRegion.next': () => env.focusRegion(1),
    'focusRegion.prev': () => env.focusRegion(-1),

    'zoom.toggle': () => {
      if (getUi().overlay === 'zoom') dispatchUi({ type: 'closeOverlay' });
      else if (selected()) dispatchUi({ type: 'openOverlay', overlay: 'zoom' });
    },
    'label.edit': (args) => {
      const s = args && args.uid ? { uid: args.uid } : selected();
      if (s) dispatchUi({ type: 'editLabel', uid: s.uid });
    },
    'label.save': (args) => saveLabel(args.uid, args.label),
    'color.set.1': (args) => setColor(1, args && args.uid),
    'color.set.2': (args) => setColor(2, args && args.uid),
    'color.set.3': (args) => setColor(3, args && args.uid),
    'color.set.4': (args) => setColor(4, args && args.uid),
    'color.set.5': (args) => setColor(5, args && args.uid),
    'color.clear': (args) => setColor(0, args && args.uid),
    'projects.clear': () => askClearProjects(),
    'projects.clear.confirmed': () => clearProjectsConfirmed(),
    'project.edit': (args) => {
      if (!prefs().projects_open) patchPrefs({ projects_open: true });
      dispatchUi({ type: 'editProject', slot: args.slot });
    },
    'project.save': (args) => saveProject(args.slot, args.name),
    'tab.new': async () => {
      try {
        await api.newTab();
        toast('info', 'opening new tab…');
      } catch (err) {
        fail('new tab', err);
      }
    },
    'tab.close': (args) => askCloseTab(args && args.uid),
    'tab.close.confirmed': (args) => closeTabConfirmed(args),
    'reply.focus': () => {
      if (currentReply()) env.focusReply();
    },
    'reply.send': (args) => sendReply(args.uid, args.text, args.submit),
    refresh: async () => {
      toast('info', 'refreshing…');
      try {
        await api.refresh();
      } catch (err) {
        fail('refresh', err);
      }
    },

    'view.cycle': () => setView(nextView(prefs().view || 'split')),
    'view.split': () => setView('split'),
    'view.list': () => setView('list'),
    'view.grid': () => setView('grid'),
    'split.grow': () => {
      const ratio = stepSplit(prefs().split_ratio, 1);
      toast('info', `list pane ${Math.round(ratio * 100)}% of width`);
      return patchPrefs({ split_ratio: ratio });
    },
    'split.shrink': () => {
      const ratio = stepSplit(prefs().split_ratio, -1);
      toast('info', `list pane ${Math.round(ratio * 100)}% of width`);
      return patchPrefs({ split_ratio: ratio });
    },
    'split.set': (args) => patchPrefs({ split_ratio: args.ratio }),
    'filter.focus': () => env.focusFilter(),
    'filter.clear': () => dispatchUi({ type: 'setFilter', filter: '' }),
    'sort.cycle': () => {
      const sort = nextSort(prefs().sort || 'natural');
      toast('info', `sort: ${sort}`);
      return patchPrefs({ sort });
    },
    'projects.toggle': () => {
      const open = !prefs().projects_open;
      if (!open) dispatchUi({ type: 'focusProject', slot: null });
      return patchPrefs({ projects_open: open });
    },
    'dollars.toggle': () => {
      const show = !prefs().show_dollars;
      toast('info', `Claude monthly dollar limit ${show ? 'shown' : 'hidden'}`);
      return patchPrefs({ show_dollars: show });
    },
    'sound.toggle': () => {
      const sound = !prefs().sound;
      toast('info', `sound on attention ${sound ? 'on' : 'off'}`);
      if (sound && env.playChime && !native.isNativeHost()) env.playChime(true);
      return patchPrefs({ sound });
    },
    'grid.toggleAll': () => {
      if (current().view !== 'grid') return undefined;
      const all = !prefs().grid_all;
      toast('info', all ? 'grid: all sessions' : 'grid: agent sessions');
      return patchPrefs({ grid_all: all });
    },
    'usage.toggle': () => dispatchUi({ type: 'toggleOverlay', overlay: 'usage' }),
    'usage.open': () => dispatchUi({ type: 'openOverlay', overlay: 'usage' }),
    'textSize.increase': () => textSize(1),
    'textSize.decrease': () => textSize(-1),
    'textSize.reset': () => textSize(0),

    unwind: () => {
      const a = unwindAction(getUi());
      if (a) dispatchUi(a);
    },
    'window.close': () => windowClose(),
    'commandPalette.open': () => openPalette(),
    'settings.open': (args) => dispatchUi({ type: 'openModal', modal: { type: 'settings', section: (args && args.section) || 'general' } }),
    'help.open': () => dispatchUi({ type: 'openModal', modal: { type: 'help' } }),
    'onboarding.open': (args) => {
      dispatchUi({ type: 'openModal', modal: { type: 'onboarding', step: (args && args.step) || 1 } });
      if (env.loadDiagnostics) env.loadDiagnostics();
    },
    'onboarding.done': () => {
      dispatchUi({ type: 'closeModal' });
      return patchPrefs({ onboarding_done: true });
    },

    // palette-only / buttons
    'theme.set': (args) => (THEMES.includes(args.theme) ? setTheme(args.theme) : undefined),
    'theme.system': () => setTheme('system'),
    'theme.dark': () => setTheme('dark'),
    'theme.light': () => setTheme('light'),
    'theme.high-contrast': () => setTheme('high-contrast'),
    'session.mute.toggle': (args) => {
      const s = args && args.uid ? { uid: args.uid } : selected();
      return s ? setMuted(s.uid, args && args.muted) : undefined;
    },
    'keepOnTop.toggle': (args) => setKeepOnTop(args && args.value),
    'quickReply.toggle': () => {
      const on = !(prefs().quick_reply !== false);
      toast('info', `quick reply ${on ? 'on' : 'off'}`);
      return patchPrefs({ quick_reply: on });
    },
    'hintBar.toggle': () => patchPrefs({ hint_bar: !(prefs().hint_bar !== false) }),
    'usageStrip.toggle': () => patchPrefs({ usage_strip: prefs().usage_strip === 'collapsed' ? 'expanded' : 'collapsed' }),
    'notifications.toggle': () => {
      const n = prefs().notifications || { enabled: true, click: 'goto' };
      return patchPrefs({ notifications: { ...n, enabled: !n.enabled } });
    },
    'notifications.request': () => {
      if (native.isNativeHost()) native.requestNotifyPermission();
      else if (env.requestBrowserPermission) env.requestBrowserPermission();
    },
    'debugRule.toggle': () => patchPrefs({ debug_rule: !prefs().debug_rule }),
    'prefs.set': (args) => patchPrefs(args),
    'iterm.launch': async () => {
      try {
        await api.launchIterm();
        toast('info', 'launching iTerm2…');
      } catch (err) {
        fail('launch', err);
      }
    },
    'automation.open': () => env.openUrl(AUTOMATION_SETTINGS_URL),
    'automation.probe': async () => {
      try {
        await api.probeAutomation();
        toast('info', 'asking macOS for permission to control iTerm2…');
        if (env.loadDiagnostics) env.loadDiagnostics();
      } catch (err) {
        fail('permission check', err);
      }
    },
    'quota.draft': async () => {
      try {
        await api.quotaEmailDraft();
        dispatchServer({ type: 'quotaCleared' });
      } catch (err) {
        fail('draft email', err);
      }
    },
    'quota.skip': async () => {
      try {
        await api.quotaEmailSkip();
        dispatchServer({ type: 'quotaCleared' });
        toast('info', 'quota email skipped this month');
      } catch (err) {
        fail('skip', err);
      }
    },
    'demo.try': () => {
      if (native.isNativeHost()) native.restartBackend(true);
      else toast('info', 'Run `omniwatch demo` in a terminal to try the demo');
    },
    'reveal.editor': (args) => reveal(args && args.uid, 'editor'),
    'reveal.finder': (args) => reveal(args && args.uid, 'finder'),
    'reveal.copyPath': (args) => reveal(args && args.uid, 'copy_path'),
    'session.reveal': (args) => reveal(args && args.uid, args && args.target),
    'history.open': (args) => openHistory(args && args.uid),
    'stats.open': () => dispatchUi({ type: 'openModal', modal: { type: 'stats' } }),
    'nativeSettings.launchAtLogin': (args) => {
      // Native-only settings (SHELL_CONTRACT §6): never PATCHed; native echoes `nativeSettings`.
      if (native.isNativeHost() && native.setLaunchAtLogin) native.setLaunchAtLogin(!!(args && args.value));
    },
    'nativeSettings.menuBarOnly': (args) => {
      if (native.isNativeHost() && native.setMenuBarOnly) native.setMenuBarOnly(!!(args && args.value));
    },
    'confirm.accept': () => {
      const m = getUi().modal;
      if (m && m.type === 'confirm' && m.command) return run(m.command, m.args);
      return undefined;
    },
  };
  for (let i = 1; i <= 9; i += 1) table[`reply.send.${i}`] = () => sendOption(i);
  for (const s of SORT_CYCLE) {
    table[`sort.set.${s}`] = () => {
      toast('info', `sort: ${s}`);
      return patchPrefs({ sort: s });
    };
  }

  /**
   * Run a command by id. Returns a promise for async commands; `false` when
   * the id is unknown.
   */
  function run(id, args) {
    const cmd = table[NATIVE_ALIASES[id] || id];
    if (!cmd) return false;
    const out = cmd(args);
    return out === undefined ? true : out;
  }

  /**
   * Side effects of server events: flash + toast + sound on a transition to
   * waiting (P-31/32/33), action failure toasts (P-71), server toasts.
   */
  function onServerEvent(event) {
    if (!event) return;
    const data = event.data || {};
    if (event.type === 'transition') {
      if (data.to === 'waiting' && data.from !== 'waiting' && !data.muted) {
        dispatchUi({ type: 'flash', uid: data.uid, now: nowMs() });
        toast('attention', `◉ ${data.title || 'A session'} is waiting for your input`, { command: 'session.select', args: { uid: data.uid }, actionLabel: 'Show' });
        const p = prefs();
        if (!native.isNativeHost()) {
          if (p.sound && env.playChime) env.playChime();
          const n = p.notifications || { enabled: true };
          if (n.enabled && env.notifyBrowser) env.notifyBrowser(data);
        }
      }
    } else if (event.type === 'action') {
      if (data.ok === false) toast('error', `${data.kind || 'action'} failed: ${data.detail || '?'}`);
      else if (data.kind === 'reveal' && data.detail) toast('info', data.detail);
    } else if (event.type === 'stall') {
      // API.md §6: once per episode; the app shell also posts a banner.
      const p = prefs();
      if (!data.muted && p.stall_minutes !== 0) {
        const mins = data.since ? Math.max(1, Math.round((env.nowS() - data.since) / 60)) : data.minutes;
        toast('warn', `${data.title || 'A session'} may be stalled — no screen change for ${mins}m`,
          { command: 'session.select', args: { uid: data.uid }, actionLabel: 'Show' });
      }
    } else if (event.type === 'toast') {
      if (data.message) serverToast(data);
    } else if ((event.type === 'prefs' || event.type === 'state') && pendingPrefs.size) {
      // Re-apply only if the echo actually clobbered a pending value (this
      // dispatch is itself a `prefs` event, so the check also ends the loop).
      const cur = getServer().prefs || {};
      const stale = [...pendingPrefs].some(([k, v]) => JSON.stringify(cur[k]) !== JSON.stringify(v.value));
      if (stale) applyPrefs(cur);
    }
  }

  return {
    run,
    toast,
    patchPrefs,
    selectUid,
    syncSelection,
    sendReply,
    saveLabel,
    saveProject,
    onServerEvent,
    has: (id) => !!table[NATIVE_ALIASES[id] || id],
    commandIds: () => Object.keys(table),
  };
}
