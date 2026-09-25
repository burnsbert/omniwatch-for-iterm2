// main.js — wiring entry point (WP5). Boots the stores (server state from
// SSE via store.js/reducer.js, client UI state via uistate.js), the
// controller (actions.js), the native bridge (native.js), mounts every
// component into index.html's regions, and renders on a rAF-coalesced
// schedule. All derivations live in pure modules (viewmodel.js,
// usage-model.js, reply.js, palette.js, shortcuts.js, keyboard.js); this
// file only routes events and calls component `update()`s.

import { h } from './dom.js';
import { createApi } from './api.js';
import { createAppStore, createStore } from './store.js';
import { nativeBridge } from './native.js';
import { matchCommand } from './keymap.js';
import { reduceUi, initialUi } from './uistate.js';
import { createController, HIGH_CONTRAST_KEY } from './actions.js';
import {
  derive, listItems, rowModel, statusChip, emptyState, summaryModel, windowTitle, matchCountText,
  previewFooter, stateWithAge, colorDotTitle, tileName, visibleUids, nativeThemeValue, clampSplit,
} from './viewmodel.js';
import { usageModel } from './usage-model.js';
import { replyModel } from './reply.js';
import { hintsFor } from './shortcuts.js';
import { applyTheme } from './theme.js';
import { normalizeKeyEvent, isTextFieldLike, zoomKeyAction, usageKeyAction, nextRegion } from './keyboard.js';
import { createToolbar } from './components/toolbar.js';
import { createProjectsPanel } from './components/projects.js';
import { createSessionList } from './components/session-list.js';
import { createPreviewPane } from './components/preview-pane.js';
import { createGridView } from './components/grid-view.js';
import { createUsageStrip, createUsageView } from './components/usage.js';
import { createModalHost } from './components/modal-host.js';
import { createCommandPalette } from './components/command-palette.js';
import { createShortcutSheet, createConfirmDialog, createSettingsSheet, createOnboarding } from './components/sheets.js';
import { createMenuHost } from './components/menus.js';
import { createToastStack, createBanners, renderEmptyState, createHintBar } from './components/feedback.js';
import { cssVar } from './components/patch.js';

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ stores

const api = createApi();
const native = nativeBridge;
const isNative = native.isNativeHost();
let clockOffset = 0; // server_time − local time (s), so ages follow the server clock (demo clock too)
const nowS = () => Date.now() / 1000 + clockOffset;

const server = createAppStore({ sse: { url: '/api/v1/events' } });
const uiStore = createStore(reduceUi, initialUi);
const ui = { get: uiStore.getState, dispatch: uiStore.dispatch };

let grid = null;
let preview = null;
let drawer = null;
let zoom = null;
let toolbar = null;

const ctl = createController({
  getServer: server.getState,
  dispatchServer: server.dispatch,
  getUi: uiStore.getState,
  dispatchUi: uiStore.dispatch,
  api,
  native,
  env: {
    nowMs: () => Date.now(),
    nowS,
    width: () => window.innerWidth,
    gridCols: () => (grid ? grid.columns() : 1),
    focusFilter: () => toolbar && toolbar.focusSearch(),
    focusReply: () => {
      const u = uiStore.getState();
      const pane = u.overlay === 'zoom' ? zoom : (currentLayout === 'split' ? preview : drawer);
      if (pane && !pane.focusReply()) ctl.toast('info', 'Nothing to reply to');
    },
    focusRegion: (dir) => focusRegion(dir),
    playChime,
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (t) => window.clearTimeout(t),
    openUrl: (url) => {
      // App: navigation to x-apple.systempreferences: is handed to NSWorkspace (SHELL_CONTRACT §6).
      if (isNative) window.location.href = url;
      else window.open(url, '_blank', 'noopener');
    },
    notifyBrowser,
    requestBrowserPermission: () => {
      if (typeof Notification === 'undefined') return;
      Notification.requestPermission().then(() => schedule());
    },
    loadDiagnostics,
    localSet: (k, v) => {
      try {
        if (v) window.localStorage.setItem(k, v);
        else window.localStorage.removeItem(k);
      } catch (_) { /* storage unavailable: the override lasts for this page only */ }
    },
    announcePolite: (msg) => announce('ow-live-polite', msg),
    announceAssertive: (msg) => announce('ow-live-assertive', msg),
  },
});

const ctx = {
  run: (id, args) => ctl.run(id, args),
  ctl,
  ui,
  server: { get: server.getState },
  schedule: () => schedule(),
  isNativeHost: () => isNative,
  focusList: () => focusList(),
  openContextMenu: (uid, x, y, opts = {}) => ui.dispatch({ type: 'openMenu', menu: { type: 'context', uid, x, y, ...opts } }),
  openSortMenu: (x, y) => ui.dispatch({ type: 'openMenu', menu: { type: 'sort', x, y } }),
};

// ---------------------------------------------------------------- mounting

const app = $('app');
toolbar = createToolbar(ctx);
$('ow-toolbar').appendChild(toolbar.el);
const banners = createBanners(ctx, $('ow-banners'));
const projects = createProjectsPanel(ctx);
const sidebarList = createSessionList(ctx, { mode: 'sidebar' });
const table = createSessionList(ctx, { mode: 'table' });
grid = createGridView(ctx);
preview = createPreviewPane(ctx, { variant: 'full' });
drawer = createPreviewPane(ctx, { variant: 'drawer' });
zoom = createPreviewPane(ctx, { variant: 'zoom' });
const usageStrip = createUsageStrip(ctx);
const usageView = createUsageView(ctx);
const hintBar = createHintBar();
const toasts = createToastStack(ctx, $('ow-toasts'));
const modals = createModalHost(ctx, $('ow-modals'), {
  palette: createCommandPalette,
  help: createShortcutSheet,
  confirm: createConfirmDialog,
  settings: createSettingsSheet,
  onboarding: createOnboarding,
});
const menus = createMenuHost(ctx, $('ow-modals'));

const sidebar = $('ow-sidebar');
const main = $('ow-main');
const drawerHost = $('ow-drawer');
const overlayHost = $('ow-body-overlay');
const emptyHost = $('ow-empty');
const listEmptyHost = h('div', { class: 'ow-list-empty' });
sidebar.appendChild(projects.el);
sidebar.appendChild(sidebarList.el);
sidebar.appendChild(listEmptyHost);
main.appendChild(preview.el);
drawerHost.appendChild(drawer.el);
$('ow-usage-strip').appendChild(usageStrip.el);
$('ow-hintbar').appendChild(hintBar.el);
overlayHost.appendChild(zoom.el);
overlayHost.appendChild(usageView.el);
wireDivider($('ow-divider'));

// ------------------------------------------------------------------ frame

let currentLayout = 'split';

function buildFrame() {
  const srv = server.getState();
  const u = uiStore.getState();
  const now = nowS();
  const width = window.innerWidth;
  const prefs = srv.prefs || {};
  const d = derive(srv, u, width);
  const nowMs = Date.now();
  const flashes = {};
  for (const [uid, until] of Object.entries(u.flashes)) if (until > nowMs) flashes[uid] = true;
  const memo = new Map();
  const rm = (s) => {
    let m = memo.get(s.uid);
    if (!m) {
      m = rowModel(s, now, srv.projects);
      memo.set(s.uid, m);
    }
    return m;
  };
  const colorCounts = {};
  for (const s of srv.sessions || []) if (s.tab_color) colorCounts[s.tab_color] = (colorCounts[s.tab_color] || 0) + 1;
  const replyFor = (s) => replyModel(s, prefs, srv.capabilities);
  const layout = d.view;
  const showRule = !!(prefs.debug_rule || (srv.capabilities && srv.capabilities.debug_rule));
  return {
    server: srv,
    ui: u,
    prefs,
    now,
    layout,
    sort: d.sort,
    rows: d.rows,
    grid: d.grid,
    active: d.active,
    selectedUid: d.selectedUid,
    selected: d.selected,
    items: listItems(d.rows, d.sort, srv.windows),
    rowModel: rm,
    flashes,
    screens: srv.screens || {},
    summary: summaryModel(srv.summary),
    chip: statusChip(srv.iterm, now),
    empty: emptyState({
      iterm: srv.iterm, sessions: srv.sessions, rows: d.active, filter: u.filter, view: layout, connection: srv.connectionStatus,
    }),
    usage: usageModel(srv.usage, { now, showDollars: !!prefs.show_dollars }),
    reply: d.selected ? replyFor(d.selected) : null,
    replyFor,
    // Freshness: the newer of the backend's last poll and the last data we received.
    footer: (s) => previewFooter({ ...(srv.iterm || {}), last_poll_at: Math.max((srv.iterm && srv.iterm.last_poll_at) || 0, lastDataAt) || null }, s, now, showRule),
    stateWithAge: (s) => stateWithAge(s, now),
    colorTitle: (s) => colorDotTitle(s, srv.projects),
    tileName,
    labelHost: u.overlay === 'zoom' ? 'zoom' : (layout === 'grid' ? 'tile' : (layout === 'split' ? 'full' : 'drawer')),
    fontScale: prefs.font_scale || 1,
    matchText: matchCountText(u.filter, d.rows.length, (srv.sessions || []).length),
    colorCounts,
    projects: srv.projects || [],
    hints: hintsFor({ overlay: u.overlay, view: layout, hasSelection: !!d.selected, reply: !!(d.selected && replyFor(d.selected)) }),
    isNative,
  };
}

// ----------------------------------------------------------------- render

let scheduled = false;
let rendering = false;
function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    renderNow();
  });
}

/** Render synchronously (UI-state changes must land before the next key), unless re-entered. */
function renderNow() {
  if (rendering) {
    schedule();
    return;
  }
  rendering = true;
  try {
    render();
  } finally {
    rendering = false;
  }
}

let lastThemeSent = null;
let lastVisible = '';
let lastTitle = '';
let onboardingShown = false;

function place(el, host, before = null) {
  if (el.parentNode !== host) host.insertBefore(el, before);
}

function render() {
  ctl.syncSelection();
  const f = buildFrame();
  const { prefs } = f;
  currentLayout = f.layout;

  // theme + scale (§2.6); resolved value posted to native once per change
  const theme = f.ui.highContrast ? 'high-contrast' : prefs.theme;
  applyTheme(document.documentElement, theme, prefs.font_scale);
  const nt = nativeThemeValue(theme || 'system');
  if (theme && nt !== lastThemeSent) {
    lastThemeSent = nt;
    native.reportTheme(nt);
  }

  app.dataset.layout = f.layout;
  app.dataset.overlay = f.ui.overlay || '';
  app.dataset.empty = f.empty && isBodyEmpty(f.empty.kind) ? f.empty.kind : '';
  cssVar(app, '--ow-split', String(clampSplit(prefs.split_ratio)));

  toolbar.update(f);
  banners.update(f);

  // Projects live in the sidebar (split/compact) or above the table/grid.
  if (f.layout === 'split' || f.layout === 'compact') place(projects.el, sidebar, sidebar.firstChild);
  else place(projects.el, main, main.firstChild);
  projects.update(f);

  const bodyEmpty = f.empty && isBodyEmpty(f.empty.kind);
  const listEmpty = f.empty && !bodyEmpty ? f.empty : null;

  // body-level empty states (§2.9)
  if (emptyHost.__owKind !== (bodyEmpty ? JSON.stringify(f.empty) : '')) {
    emptyHost.__owKind = bodyEmpty ? JSON.stringify(f.empty) : '';
    while (emptyHost.firstChild) emptyHost.removeChild(emptyHost.firstChild);
    if (bodyEmpty) emptyHost.appendChild(renderEmptyState(ctx, f.empty));
  }
  emptyHost.hidden = !bodyEmpty;

  // list-level empty states (filter no match, grid no agents)
  const listEmptyKey = listEmpty ? JSON.stringify(listEmpty) : '';
  if (listEmptyHost.__owKey !== listEmptyKey) {
    listEmptyHost.__owKey = listEmptyKey;
    while (listEmptyHost.firstChild) listEmptyHost.removeChild(listEmptyHost.firstChild);
    if (listEmpty) listEmptyHost.appendChild(renderEmptyState(ctx, listEmpty));
  }
  listEmptyHost.hidden = !listEmpty;

  if (f.layout === 'split' || f.layout === 'compact') {
    place(listEmptyHost, sidebar);
    sidebarList.el.hidden = !!listEmpty;
    sidebarList.update(f);
  }
  if (f.layout === 'split') {
    place(preview.el, main);
    preview.update(f, f.selected);
  }
  table.el.hidden = f.layout !== 'list' || !!listEmpty;
  grid.el.hidden = f.layout !== 'grid' || !!listEmpty;
  preview.el.hidden = f.layout !== 'split';
  if (f.layout === 'list') {
    place(table.el, main);
    place(listEmptyHost, main);
    table.update(f);
  }
  if (f.layout === 'grid') {
    place(grid.el, main);
    place(listEmptyHost, main);
    grid.update(f);
  }
  const drawerOn = (f.layout === 'list' || f.layout === 'compact') && !bodyEmpty;
  drawerHost.hidden = !drawerOn;
  if (drawerOn) drawer.update(f, f.selected);

  // overlays covering the body (toolbar stays): zoom (P-47) and usage (P-51)
  overlayHost.hidden = !f.ui.overlay;
  zoom.el.hidden = f.ui.overlay !== 'zoom';
  usageView.el.hidden = f.ui.overlay !== 'usage';
  if (f.ui.overlay === 'zoom') {
    if (!f.selected) ui.dispatch({ type: 'closeOverlay' });
    else zoom.update(f, f.selected);
  }
  if (f.ui.overlay === 'usage') usageView.update(f);

  usageStrip.update(f);
  $('ow-usage-strip').hidden = f.usage.empty && f.layout === 'compact';
  hintBar.update(f);
  toasts.update(f);
  modals.update(f);
  menus.update(f);

  // title carries the waiting count (§2.1)
  const title = windowTitle(f.summary.waiting);
  if (title !== lastTitle) {
    lastTitle = title;
    document.title = title;
  }

  // visible uids → native, for notification suppression (SHELL_CONTRACT §6)
  const vis = visibleUids({
    view: f.layout === 'compact' || f.layout === 'list' ? 'split' : f.layout,
    selectedUid: f.selectedUid,
    overlay: f.ui.overlay,
    gridUids: f.grid.map((s) => s.uid),
    windowFocused: document.hasFocus() && !document.hidden,
  });
  const visKey = vis.join(',');
  if (visKey !== lastVisible) {
    lastVisible = visKey;
    native.setVisible(vis);
  }

  // first run: onboarding sheet (§2.10)
  if (!onboardingShown && prefs.onboarding_done === false && !f.ui.modal && f.server.connectionStatus === 'connected') {
    onboardingShown = true;
    ctl.run('onboarding.open');
  }
}

function isBodyEmpty(kind) {
  return ['not_running', 'not_authorized', 'error', 'connecting', 'no_sessions'].includes(kind);
}

// ------------------------------------------------------------ server hooks

let lastDataAt = 0;
server.subscribe((state, prev, event) => {
  if (event && (event.type === 'sessions' || event.type === 'screens' || event.type === 'state')) lastDataAt = nowS();
  if (event && (event.type === 'state' || event.type === 'hello') && typeof state.server_time === 'number') {
    clockOffset = state.server_time - Date.now() / 1000;
  }
  if (event) ctl.onServerEvent(event);
  schedule();
});
uiStore.subscribe(() => renderNow());

// Toast/flash expiry + ticking ages (P-30) once a second.
setInterval(() => {
  ui.dispatch({ type: 'tick', now: Date.now() });
  schedule();
}, 1000);

window.addEventListener('resize', () => schedule());
window.addEventListener('focus', () => schedule());
window.addEventListener('blur', () => schedule());
document.addEventListener('visibilitychange', () => schedule());
if (window.matchMedia) {
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  if (mq.addEventListener) mq.addEventListener('change', () => schedule());
}

// ---------------------------------------------------------------- keyboard

function focusList() {
  const f = currentLayout;
  if (f === 'grid') grid.el.focus({ preventScroll: true });
  else if (f === 'list') table.listbox.focus({ preventScroll: true });
  else sidebarList.listbox.focus({ preventScroll: true });
}

function focusRegion(dir) {
  const regions = [
    'toolbar',
    server.getState().prefs && server.getState().prefs.projects_open && currentLayout !== 'grid' ? 'projects' : null,
    'list',
    currentLayout === 'grid' ? null : 'preview',
  ];
  const cur = document.activeElement && document.activeElement.closest ? document.activeElement.closest('[data-region]') : null;
  const next = nextRegion(regions, cur ? cur.dataset.region : null, dir);
  if (next === 'toolbar') toolbar.input.focus();
  else if (next === 'projects') {
    const b = projects.el.querySelector('.ow-slot-btn');
    if (b) b.focus();
  } else if (next === 'list') focusList();
  else if (next === 'preview') {
    const pane = currentLayout === 'split' ? preview : drawer;
    pane.focusScreen();
  }
}

document.addEventListener('keydown', (e) => {
  if (e.isComposing || e.defaultPrevented) return;
  const u = uiStore.getState();
  const ev = normalizeKeyEvent(e);
  const t = e.target || {};
  const inText = isTextFieldLike({ tagName: t.tagName, type: t.type, isContentEditable: t.isContentEditable });

  if (u.menu) {
    if (e.key === 'Escape') {
      e.preventDefault();
      ui.dispatch({ type: 'closeMenu' });
    }
    return;
  }

  if (u.modal) {
    if (e.key === 'Escape') {
      e.preventDefault();
      ctl.run('unwind');
      return;
    }
    const id = matchCommand(ev, { inTextField: true });
    if (id === 'commandPalette.open') {
      e.preventDefault();
      if (u.modal.type === 'palette') ui.dispatch({ type: 'closeModal' });
      else ctl.run(id);
    } else if (id === 'settings.open' && u.modal.type !== 'settings') {
      e.preventDefault();
      ctl.run(id);
    } else if (u.modal.type === 'help' && !inText && (e.key === '?' || (e.key === '/' && e.metaKey))) {
      e.preventDefault();
      ui.dispatch({ type: 'closeModal' });
    }
    return;
  }

  if (u.overlay === 'zoom' && !inText) {
    const action = zoomKeyAction(ev);
    if (action === 'ignore') return;
    if (action === 'move-up' || action === 'move-down') {
      e.preventDefault();
      ctl.run(action === 'move-up' ? 'move.up' : 'move.down');
      return;
    }
    if (action === 'goto') {
      e.preventDefault();
      ctl.run('session.goto');
      return;
    }
    if (action === 'exit') {
      e.preventDefault();
      ui.dispatch({ type: 'closeOverlay' });
      return;
    }
  }

  if (u.overlay === 'usage' && !inText) {
    const action = usageKeyAction(ev);
    if (action === 'ignore') return;
    if (action !== 'passthrough') {
      e.preventDefault();
      if (action === 'dollars') ctl.run('dollars.toggle');
      else if (action === 'refresh') ctl.run('refresh');
      else ui.dispatch({ type: 'closeOverlay' });
      return;
    }
  }

  // Keys on focused buttons/switches keep their native meaning.
  if (!inText && (e.key === 'Enter' || e.key === ' ') && t.tagName === 'BUTTON') return;
  if (!inText && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && t.getAttribute && t.getAttribute('role') === 'separator') return;

  const id = matchCommand(ev, { inTextField: inText });
  if (!id) return;
  if (id === 'unwind' && inText) {
    // Text fields handle their own Esc; this only runs for fields that don't.
    t.blur();
  }
  e.preventDefault();
  ctl.run(id);
});

// ---------------------------------------------------------------- divider

function wireDivider(div) {
  let dragging = false;
  const body = $('ow-body');
  const onMove = (e) => {
    if (!dragging) return;
    const r = body.getBoundingClientRect();
    const ratio = clampSplit((e.clientX - r.left) / r.width);
    cssVar(app, '--ow-split', String(ratio));
    div.__owRatio = ratio;
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('is-resizing-h');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (div.__owRatio) ctl.run('split.set', { ratio: div.__owRatio });
  };
  div.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    dragging = true;
    document.body.classList.add('is-resizing-h');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
  div.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      ctl.run('split.shrink');
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      ctl.run('split.grow');
    }
  });
  div.addEventListener('dblclick', () => ctl.run('split.set', { ratio: 0.42 }));
}

// ------------------------------------------------------- sound & notices

let audio = null;
function playChime() {
  // WebAudio chime (P-33, browser mode only; the app uses NSSound).
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!audio) audio = new AC();
    const t0 = audio.currentTime;
    [[880, 0], [1318.5, 0.11]].forEach(([freq, delay]) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + delay);
      gain.gain.exponentialRampToValueAtTime(0.18, t0 + delay + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + delay + 0.5);
      osc.connect(gain).connect(audio.destination);
      osc.start(t0 + delay);
      osc.stop(t0 + delay + 0.55);
    });
  } catch (_) {
    // Audio is best-effort.
  }
}

function notifyBrowser(tr) {
  // §2.8.3: Web Notification only while the page is hidden.
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || !document.hidden) return;
  try {
    const n = new Notification(`${tr.title || 'A session'} needs you`, {
      body: (tr.prompt && tr.prompt.question) || 'Waiting for your input',
      tag: `waiting-${tr.uid}`,
    });
    n.onclick = () => {
      window.focus();
      ctl.run('session.select', { uid: tr.uid });
      n.close();
    };
  } catch (_) {
    // Notifications are best-effort.
  }
}

function announce(id, msg) {
  const el = $(id);
  if (!el) return;
  el.textContent = '';
  setTimeout(() => {
    el.textContent = msg;
  }, 30);
}

async function loadDiagnostics() {
  try {
    const d = await api.diagnostics();
    ui.dispatch({ type: 'setDiagnostics', diagnostics: d });
  } catch (_) {
    // Diagnostics are optional in onboarding.
  }
}

// ------------------------------------------------------------ native & go

native.install({
  onCommand: (id, args) => ctl.run(id, args),
  onNativeEvent: (event) => {
    if (event && event.type === 'notifyPermission') ui.dispatch({ type: 'setNotifyPermission', status: event.status });
  },
});
try {
  if (window.localStorage.getItem(HIGH_CONTRAST_KEY)) ui.dispatch({ type: 'setHighContrast', on: true });
} catch (_) { /* no storage */ }
if (!isNative && typeof Notification !== 'undefined') ui.dispatch({ type: 'setNotifyPermission', status: Notification.permission });

server.connect();
schedule();
