import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createController, NATIVE_ALIASES, AUTOMATION_SETTINGS_URL, VISIT_DEBOUNCE_MS } from '../../omniwatch/web/js/actions.js';
import { reduce, initialState } from '../../omniwatch/web/js/reducer.js';
import { reduceUi, initialUi } from '../../omniwatch/web/js/uistate.js';
import { COMMANDS } from '../../omniwatch/web/js/commands.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/state.json', import.meta.url), 'utf8'));
const byLabel = (st, l) => st.sessions.find((s) => s.tab_label === l);

function setup({ width = 1400, native = false, server: serverPatch = {}, ui: uiPatch = {}, apiOverrides = {} } = {}) {
  let server = reduce(initialState, { type: 'state', data: { ...JSON.parse(JSON.stringify(fixture)), ...serverPatch } });
  let ui = { ...initialUi, ...uiPatch };
  const calls = [];
  const nativeCalls = [];
  const timers = [];
  const envCalls = [];
  const local = {};
  const api = new Proxy({}, {
    get: (_t, name) => (...args) => {
      calls.push([name, ...args]);
      if (apiOverrides[name]) return apiOverrides[name](...args);
      return Promise.resolve({ ok: true });
    },
  });
  const nativeBridge = {
    isNativeHost: () => native,
    closeWindow: () => nativeCalls.push(['closeWindow']),
    setKeepOnTop: (v) => nativeCalls.push(['keepOnTop', v]),
    requestNotifyPermission: () => nativeCalls.push(['notifyPermission']),
    restartBackend: (d) => nativeCalls.push(['restartBackend', d]),
  };
  let nowMs = 1_000_000;
  const env = {
    nowMs: () => nowMs,
    nowS: () => fixture.server_time,
    width: () => width,
    gridCols: () => 3,
    focusFilter: () => envCalls.push('focusFilter'),
    focusReply: () => envCalls.push('focusReply'),
    focusRegion: (d) => envCalls.push(`region${d}`),
    playChime: (test_) => envCalls.push(test_ ? 'chime-test' : 'chime'),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
    openUrl: (u) => envCalls.push(`open:${u}`),
    notifyBrowser: (d) => envCalls.push(`notify:${d.uid}`),
    requestBrowserPermission: () => envCalls.push('browserPermission'),
    loadDiagnostics: () => envCalls.push('diagnostics'),
    localSet: (k, v) => { local[k] = v; },
    announcePolite: (m) => envCalls.push(`polite:${m}`),
    announceAssertive: (m) => envCalls.push(`assertive:${m}`),
  };
  const ctl = createController({
    getServer: () => server,
    dispatchServer: (e) => { server = reduce(server, e); },
    getUi: () => ui,
    dispatchUi: (a) => { ui = reduceUi(ui, a); },
    api,
    native: nativeBridge,
    env,
  });
  return {
    ctl,
    calls,
    nativeCalls,
    envCalls,
    timers,
    local,
    get server() { return server; },
    get ui() { return ui; },
    toasts: () => ui.toasts.map((t) => t.message),
    advance: (ms) => { nowMs += ms; },
    runTimers: () => { for (const t of timers.splice(0)) if (t.fn) t.fn(); },
  };
}

test('every keymap command id has a handler', () => {
  const t = setup();
  for (const c of COMMANDS) assert.ok(t.ctl.has(c.id), `no handler for ${c.id}`);
  assert.equal(t.ctl.run('no.such.command'), false);
  assert.ok(t.ctl.commandIds().length > COMMANDS.length);
});

test('native menu ids alias onto keymap commands (SHELL_CONTRACT §6)', () => {
  const t = setup();
  for (const id of Object.keys(NATIVE_ALIASES)) assert.ok(t.ctl.has(id), id);
  t.ctl.run('palette.open');
  assert.equal(t.ui.modal.type, 'palette');
  t.ctl.run('shortcuts.open');
  assert.equal(t.ui.modal.type, 'help');
  t.ctl.run('usage.open');
  assert.equal(t.ui.overlay, 'usage');
});

test('move up/down follows the list; selection visits after 150 ms debounce only when attention (P-55/P-56)', async () => {
  const t = setup();
  t.ctl.syncSelection();
  assert.equal(t.ui.selectedUid, t.server.sessions[0].uid);
  assert.equal(t.timers.length, 0, 'initial/snap-back selection is not a visit');
  t.ctl.run('move.down');
  assert.equal(t.ui.selectedUid, t.server.sessions[1].uid);
  assert.equal(t.timers.at(-1).ms, VISIT_DEBOUNCE_MS);
  t.runTimers();
  assert.deepEqual(t.calls.at(-1), ['visit', t.server.sessions[1].uid]);
  assert.equal(byLabel(t.server, '1.2').attention, false, 'attention cleared locally');
  t.ctl.run('move.down');
  t.runTimers();
  assert.notEqual(t.calls.at(-1)?.[0] === 'visit' && t.calls.at(-1)[1], t.server.sessions[2].uid, 'no visit without attention');
  t.ctl.run('move.up');
  t.ctl.run('move.left'); // no-op outside grid
  assert.equal(t.ui.selectedUid, t.server.sessions[1].uid);
  t.ctl.selectUid(null);
  t.ctl.run('session.select', {});
  assert.equal(t.ui.selectedUid, t.server.sessions[1].uid);
});

test('a debounced visit is cancelled by a quicker second selection', () => {
  const t = setup();
  t.ctl.selectUid(t.server.sessions[1].uid);
  t.ctl.selectUid(t.server.sessions[4].uid);
  t.runTimers();
  const visits = t.calls.filter((c) => c[0] === 'visit').map((c) => c[1]);
  assert.deepEqual(visits, [t.server.sessions[4].uid]);
});

test('grid: ↑/↓ move by the column count, ←/→ by one (P-46)', () => {
  const t = setup({ server: { prefs: { ...fixture.prefs, view: 'grid', grid_all: true } } });
  t.ctl.syncSelection();
  t.ctl.run('move.down');
  assert.equal(t.ui.selectedUid, t.server.sessions[3].uid);
  t.ctl.run('move.left');
  assert.equal(t.ui.selectedUid, t.server.sessions[2].uid);
  t.ctl.run('move.right');
  assert.equal(t.ui.selectedUid, t.server.sessions[3].uid);
});

test('projects focus: ↑ from the top row enters the slots, ↓ past slot 5 returns, ⏎ edits (P-63)', () => {
  const t = setup({ server: { prefs: { ...fixture.prefs, projects_open: true } } });
  t.ctl.syncSelection();
  t.ctl.run('move.up');
  assert.equal(t.ui.projectFocus, 5);
  t.ctl.run('move.up');
  assert.equal(t.ui.projectFocus, 4);
  t.ctl.run('session.goto');
  assert.equal(t.ui.editingProject, 4);
  t.ctl.run('move.down');
  t.ctl.run('move.down');
  t.ctl.run('move.down');
  assert.equal(t.ui.projectFocus, null);
  t.ui.projectFocus = null;
  const t2 = setup({ server: { prefs: { ...fixture.prefs, projects_open: true } }, ui: { projectFocus: 1 } });
  t2.ctl.run('move.up');
  assert.equal(t2.ui.projectFocus, 1, 'no slot above 1');
});

test('go to session toasts "→ tab N" and reports failures (P-57)', async () => {
  const t = setup();
  t.ctl.syncSelection();
  await t.ctl.run('session.goto');
  assert.deepEqual(t.calls.at(-1), ['goto', t.server.sessions[0].uid]);
  assert.equal(t.toasts().at(-1), '→ tab 1.1');
  const f = setup({ apiOverrides: { goto: () => Promise.reject(Object.assign(new Error('nope'), { status: 404 })) } });
  await f.ctl.run('session.goto', { uid: f.server.sessions[2].uid });
  assert.equal(f.toasts().at(-1), 'goto failed: session not found');
  const g = setup({ apiOverrides: { goto: () => Promise.reject(new Error('boom')) } });
  await g.ctl.run('session.goto', { uid: g.server.sessions[2].uid });
  assert.equal(g.toasts().at(-1), 'goto failed: boom');
  assert.ok(g.envCalls.includes('assertive:goto failed: boom'), 'errors are announced assertively');
  const n = setup({ server: { sessions: [] } });
  await n.ctl.run('session.goto');
  assert.equal(n.calls.length, 0);
});

test('next waiting cycles longest first; clears a hiding filter; none → toast (P-58)', () => {
  const t = setup({ ui: { filter: 'api-gateway' } });
  t.ctl.run('select.nextWaiting');
  assert.equal(t.ui.selectedUid, byLabel(t.server, '2.1').uid);
  assert.equal(t.ui.filter, '');
  t.ctl.run('session.nextWaiting');
  assert.equal(t.ui.selectedUid, byLabel(t.server, '1.2').uid);
  const n = setup({ server: { sessions: fixture.sessions.filter((s) => s.state !== 'waiting') } });
  n.ctl.run('select.nextWaiting');
  assert.equal(n.toasts().at(-1), 'no sessions waiting');
});

test('session.select from native clears a filter that hides the uid', () => {
  const t = setup({ ui: { filter: 'qqqq', projectFocus: 2 } });
  t.ctl.run('session.select', { uid: byLabel(t.server, '1.2').uid });
  assert.deepEqual([t.ui.filter, t.ui.projectFocus, t.ui.selectedUid], ['', null, byLabel(t.server, '1.2').uid]);
});

test('tab colors: 1–5 set, 0 clears, unavailable links to setup (P-64)', async () => {
  const t = setup();
  t.ctl.syncSelection();
  await t.ctl.run('color.set.1');
  assert.deepEqual(t.calls.at(-1), ['setColor', t.server.sessions[0].uid, 1]);
  assert.equal(t.toasts().at(-1), 'tab 1.1 → blue (api)');
  await t.ctl.run('color.set.3');
  assert.equal(t.toasts().at(-1), 'tab 1.1 → green');
  await t.ctl.run('color.clear');
  assert.deepEqual(t.calls.at(-1), ['setColor', t.server.sessions[0].uid, null]);
  assert.equal(t.toasts().at(-1), 'tab 1.1: color cleared');
  const off = setup({ server: { capabilities: { tab_colors: false, reply: true } } });
  off.ctl.syncSelection();
  await off.ctl.run('color.set.2');
  assert.equal(off.calls.length, 0);
  assert.equal(off.toasts().at(-1), 'tab colors unavailable — see setup');
  assert.equal(off.ui.toasts.at(-1).command, 'onboarding.open');
  const e503 = setup({ apiOverrides: { setColor: () => Promise.reject(Object.assign(new Error('x'), { code: 'tab_colors_unavailable' })) } });
  e503.ctl.syncSelection();
  await e503.ctl.run('color.set.4');
  assert.equal(e503.toasts().at(-1), 'tab colors unavailable — see setup');
  const eOther = setup({ apiOverrides: { setColor: () => Promise.reject(new Error('down')) } });
  await eOther.ctl.run('color.set.5', { uid: eOther.server.sessions[2].uid });
  assert.equal(eOther.toasts().at(-1), 'color failed: down');
  const none = setup({ server: { sessions: [] } });
  await none.ctl.run('color.set.1');
  assert.equal(none.calls.length, 0);
});

test('mute toggles and updates the session locally (§3 P0)', async () => {
  const t = setup();
  const uid = byLabel(t.server, '1.2').uid;
  await t.ctl.run('session.mute.toggle', { uid });
  assert.deepEqual(t.calls.at(-1), ['setMuted', uid, true]);
  assert.equal(byLabel(t.server, '1.2').muted, true);
  assert.equal(t.toasts().at(-1), 'refactor muted');
  await t.ctl.run('session.mute.toggle', { uid, muted: false });
  assert.equal(t.toasts().at(-1), 'refactor unmuted');
  await t.ctl.run('session.mute.toggle', { uid: 'gone' });
  const f = setup({ apiOverrides: { setMuted: () => Promise.reject(new Error('x')) } });
  await f.ctl.run('session.mute.toggle', { uid });
  assert.equal(f.toasts().at(-1), 'mute failed: x');
  const none = setup({ server: { sessions: [] } });
  assert.equal(none.ctl.run('session.mute.toggle'), true);
});

test('labels: edit, save (normalized, optimistic), empty removes, failure reverts (P-61)', async () => {
  const t = setup();
  t.ctl.syncSelection();
  t.ctl.run('label.edit');
  assert.equal(t.ui.editingLabel, t.server.sessions[0].uid);
  const uid = t.server.sessions[0].uid;
  await t.ctl.run('label.save', { uid, label: '  deploy ✨  ' });
  assert.equal(t.ui.editingLabel, null);
  assert.deepEqual(t.calls.at(-1), ['setLabel', uid, 'deploy ✨']);
  assert.equal(t.server.sessions[0].display_name, 'deploy ✨');
  await t.ctl.run('label.save', { uid, label: 'deploy ✨' });
  assert.equal(t.calls.filter((c) => c[0] === 'setLabel').length, 1, 'unchanged label is not sent');
  await t.ctl.run('label.save', { uid, label: '' });
  assert.equal(t.server.sessions[0].display_name, t.server.sessions[0].name);
  const f = setup({ apiOverrides: { setLabel: () => Promise.reject(new Error('no')) } });
  const fu = byLabel(f.server, '1.2').uid;
  await f.ctl.run('label.save', { uid: fu, label: 'new' });
  assert.equal(byLabel(f.server, '1.2').label, 'refactor', 'reverted');
  assert.equal(f.toasts().at(-1), 'label failed: no');
  t.ctl.run('label.edit', { uid: 'x' });
  assert.equal(t.ui.editingLabel, 'x');
});

test('projects: edit opens the panel, save trims, clear asks first (P-63/P-65)', async () => {
  const t = setup();
  t.ctl.run('project.edit', { slot: 3 });
  assert.equal(t.server.prefs.projects_open, true);
  assert.equal(t.ui.editingProject, 3);
  await t.ctl.run('project.save', { slot: 3, name: '  infra ' });
  assert.deepEqual(t.calls.at(-1), ['setProject', 3, 'infra']);
  assert.equal(t.server.projects[2].name, 'infra');
  t.ctl.run('projects.clear');
  assert.equal(t.ui.modal.type, 'confirm');
  assert.equal(t.ui.modal.title, 'Clear all 5 project names?');
  await t.ctl.run('confirm.accept');
  assert.deepEqual(t.calls.at(-1), ['clearProjects']);
  assert.ok(t.server.projects.every((p) => p.name === ''));
  assert.equal(t.toasts().at(-1), 'projects cleared');
  assert.equal(t.ui.modal, null);
  const f = setup({ apiOverrides: { setProject: () => Promise.reject(new Error('e')), clearProjects: () => Promise.reject(new Error('c')) } });
  await f.ctl.run('project.save', { slot: 1, name: 'zzz' });
  assert.equal(f.server.projects[0].name, 'api', 'reverted');
  await f.ctl.run('projects.clear.confirmed');
  assert.equal(f.toasts().at(-1), 'projects failed: c');
  const t2 = setup({ server: { prefs: { ...fixture.prefs, projects_open: true } } });
  t2.ctl.run('project.edit', { slot: 1 });
  assert.equal(t2.calls.length, 0, 'already open → no PATCH');
});

test('close tab: confirm names the tab, closes by uid, toast (P-67)', async () => {
  const t = setup();
  const s = byLabel(t.server, '1.2');
  t.ctl.run('tab.close', { uid: s.uid });
  assert.equal(t.ui.modal.title, 'Close tab 1.2 (refactor)?');
  assert.equal(t.ui.modal.danger, true);
  await t.ctl.run('confirm.accept');
  assert.deepEqual(t.calls.at(-1), ['closeTab', s.uid]);
  assert.equal(t.toasts().at(-1), 'closing tab 1.2…');
  const f = setup({ apiOverrides: { closeTab: () => Promise.reject(new Error('gone')) } });
  f.ctl.syncSelection();
  f.ctl.run('tab.close');
  await f.ctl.run('confirm.accept');
  assert.equal(f.toasts().at(-1), 'close failed: gone');
  assert.equal(f.ctl.run('confirm.accept'), true, 'nothing to confirm');
  const none = setup({ server: { sessions: [] } });
  none.ctl.run('tab.close');
  assert.equal(none.ui.modal, null);
  const plain = setup({ server: { sessions: [{ ...fixture.sessions[0], label: '', display_name: '', path_display: '' }] } });
  plain.ctl.syncSelection();
  plain.ctl.run('tab.close');
  assert.equal(plain.ui.modal.title, 'Close tab 1.1?');
});

test('new tab, refresh (deduped with the server echo), launch, probe (P-66/P-68)', async () => {
  const t = setup();
  await t.ctl.run('tab.new');
  assert.equal(t.toasts().at(-1), 'opening new tab…');
  await t.ctl.run('refresh');
  assert.equal(t.toasts().at(-1), 'refreshing…');
  const before = t.ui.toasts.length;
  t.ctl.onServerEvent({ type: 'toast', data: { level: 'info', message: 'refreshing…' } });
  assert.equal(t.ui.toasts.length, before, 'server echo within 2 s dropped');
  t.advance(3000);
  t.ctl.onServerEvent({ type: 'toast', data: { message: 'refreshing…' } });
  assert.equal(t.ui.toasts.length, before + 1);
  await t.ctl.run('iterm.launch');
  assert.equal(t.toasts().at(-1), 'launching iTerm2…');
  await t.ctl.run('automation.probe');
  assert.deepEqual(t.calls.at(-1), ['probeAutomation']);
  assert.ok(t.envCalls.includes('diagnostics'));
  t.ctl.run('automation.open');
  assert.ok(t.envCalls.includes(`open:${AUTOMATION_SETTINGS_URL}`));
  const f = setup({
    apiOverrides: {
      newTab: () => Promise.reject(new Error('a')), refresh: () => Promise.reject(new Error('b')),
      launchIterm: () => Promise.reject(new Error('c')), probeAutomation: () => Promise.reject(new Error('d')),
    },
  });
  await f.ctl.run('tab.new');
  await f.ctl.run('refresh');
  await f.ctl.run('iterm.launch');
  await f.ctl.run('automation.probe');
  const all = [];
  const f2 = setup({ apiOverrides: { newTab: () => Promise.reject(new Error('a')) } });
  await f2.ctl.run('tab.new');
  all.push(f2.toasts().at(-1), ...f.toasts().slice(-3));
  assert.deepEqual(all, ['new tab failed: a', 'refresh failed: b', 'launch failed: c', 'permission check failed: d']);
});

test('quick reply: option N sends its key with the screen hash; 409 → warn toast (§3 P0)', async () => {
  const t = setup();
  const s = byLabel(t.server, '1.2');
  t.ctl.selectUid(s.uid);
  await t.ctl.run('reply.send.2');
  assert.deepEqual(t.calls.at(-1), ['reply', s.uid, { text: '2', submit: false, expectHash: s.screen_hash }]);
  assert.equal(t.toasts().at(-1), 'Replied to refactor');
  assert.equal(await t.ctl.run('reply.send.9'), false, 'no option 9');
  const ok = await t.ctl.run('reply.send', { uid: s.uid, text: 'run it with --watch', submit: true });
  assert.equal(ok, true);
  assert.deepEqual(t.calls.at(-1)[2], { text: 'run it with --watch', submit: true, expectHash: s.screen_hash });
  assert.equal(await t.ctl.sendReply(s.uid, '   ', true), false);
  assert.equal(t.toasts().at(-1), 'Reply is empty');
  const stale = setup({ apiOverrides: { reply: () => Promise.reject(Object.assign(new Error('x'), { status: 409, code: 'stale_screen' })) } });
  const su = byLabel(stale.server, '1.2').uid;
  assert.equal(await stale.ctl.sendReply(su, '1', false), false);
  assert.match(stale.toasts().at(-1), /screen changed/);
  assert.equal(stale.ui.toasts.at(-1).level, 'warn');
  const other = setup({ apiOverrides: { reply: () => Promise.reject(Object.assign(new Error('x'), { status: 500 })) } });
  await other.ctl.sendReply(byLabel(other.server, '1.2').uid, '1', false);
  assert.equal(other.ui.toasts.at(-1).level, 'error');
  assert.equal(await t.ctl.sendReply(byLabel(t.server, '1.1').uid, '1', false), false, 'busy session');
  assert.equal(t.toasts().at(-1), 'That session is no longer waiting for a reply');
  const off = setup({ server: { prefs: { ...fixture.prefs, quick_reply: false } } });
  off.ctl.selectUid(byLabel(off.server, '1.2').uid);
  assert.equal(off.ctl.run('reply.send.1'), false);
});

test('reply.focus only when a reply bar exists', () => {
  const t = setup();
  t.ctl.syncSelection();
  t.ctl.run('reply.focus');
  assert.deepEqual(t.envCalls, []);
  t.ctl.selectUid(byLabel(t.server, '1.2').uid);
  t.ctl.run('reply.focus');
  assert.deepEqual(t.envCalls, ['focusReply']);
});

test('view commands persist the view; split needs width; zoom toggles (P-37/P-38/P-47)', async () => {
  const t = setup();
  await t.ctl.run('view.cycle');
  assert.equal(t.server.prefs.view, 'list');
  assert.deepEqual(t.calls.at(-1), ['patchPrefs', { view: 'list' }]);
  await t.ctl.run('view.grid');
  assert.equal(t.server.prefs.view, 'grid');
  await t.ctl.run('view.list');
  await t.ctl.run('view.split');
  assert.equal(t.server.prefs.view, 'split');
  const narrow = setup({ width: 800 });
  await narrow.ctl.run('view.split');
  assert.equal(narrow.toasts().at(-1), 'Split view needs a wider window — showing the list');
  t.ctl.syncSelection();
  t.ctl.run('zoom.toggle');
  assert.equal(t.ui.overlay, 'zoom');
  t.ctl.run('zoom.toggle');
  assert.equal(t.ui.overlay, null);
  const empty = setup({ server: { sessions: [] } });
  empty.ctl.run('zoom.toggle');
  assert.equal(empty.ui.overlay, null);
});

test('split resize steps 0.05 and toasts the percentage (P-38)', async () => {
  const t = setup();
  await t.ctl.run('split.grow');
  assert.equal(t.server.prefs.split_ratio, 0.47);
  assert.equal(t.toasts().at(-1), 'list pane 47% of width');
  await t.ctl.run('split.shrink');
  await t.ctl.run('split.shrink');
  assert.equal(t.server.prefs.split_ratio, 0.37);
  await t.ctl.run('split.set', { ratio: 0.5 });
  assert.equal(t.server.prefs.split_ratio, 0.5);
});

test('sort cycles with toast; sort.set.X sets directly (P-60)', async () => {
  const t = setup();
  await t.ctl.run('sort.cycle');
  assert.equal(t.server.prefs.sort, 'attention');
  assert.equal(t.toasts().at(-1), 'sort: attention');
  await t.ctl.run('sort.set.path');
  assert.equal(t.server.prefs.sort, 'path');
});

test('toggles: projects, dollars, sound, grid all, quick reply, hints, strip, notifications, debug rule (P-33/P-69)', async () => {
  const t = setup({ ui: { projectFocus: 2 } });
  await t.ctl.run('projects.toggle');
  assert.equal(t.server.prefs.projects_open, true);
  await t.ctl.run('projects.toggle');
  assert.equal(t.ui.projectFocus, null);
  await t.ctl.run('dollars.toggle');
  assert.equal(t.toasts().at(-1), 'Claude monthly dollar limit shown');
  await t.ctl.run('dollars.toggle');
  assert.equal(t.toasts().at(-1), 'Claude monthly dollar limit hidden');
  await t.ctl.run('sound.toggle');
  assert.equal(t.toasts().at(-1), 'sound on attention on');
  assert.ok(t.envCalls.includes('chime-test'), 'turning sound on plays a preview in the browser');
  await t.ctl.run('sound.toggle');
  assert.equal(t.toasts().at(-1), 'sound on attention off');
  assert.equal(t.ctl.run('grid.toggleAll'), true, 'A is grid-only');
  assert.equal(t.server.prefs.grid_all, false);
  await t.ctl.run('quickReply.toggle');
  assert.equal(t.server.prefs.quick_reply, false);
  assert.equal(t.toasts().at(-1), 'quick reply off');
  await t.ctl.run('hintBar.toggle');
  assert.equal(t.server.prefs.hint_bar, false);
  await t.ctl.run('usageStrip.toggle');
  assert.equal(t.server.prefs.usage_strip, 'collapsed');
  await t.ctl.run('usageStrip.toggle');
  assert.equal(t.server.prefs.usage_strip, 'expanded');
  await t.ctl.run('notifications.toggle');
  assert.deepEqual(t.server.prefs.notifications, { enabled: false, click: 'goto' });
  await t.ctl.run('debugRule.toggle');
  assert.equal(t.server.prefs.debug_rule, true);
  const g = setup({ server: { prefs: { ...fixture.prefs, view: 'grid' } } });
  await g.ctl.run('grid.toggleAll');
  assert.equal(g.server.prefs.grid_all, true);
  assert.equal(g.toasts().at(-1), 'grid: all sessions');
  await g.ctl.run('grid.toggleAll');
  assert.equal(g.toasts().at(-1), 'grid: agent sessions');
  const np = setup({ server: { prefs: { ...fixture.prefs, notifications: undefined } } });
  await np.ctl.run('notifications.toggle');
  assert.deepEqual(np.server.prefs.notifications, { enabled: false, click: 'goto' });
});

test('usage view, text size, themes, palette, settings, help, onboarding (P-70, §2.5)', async () => {
  const t = setup();
  t.ctl.run('usage.toggle');
  assert.equal(t.ui.overlay, 'usage');
  t.ctl.run('usage.toggle');
  assert.equal(t.ui.overlay, null);
  await t.ctl.run('textSize.increase');
  assert.equal(t.server.prefs.font_scale, 1.1);
  await t.ctl.run('textSize.decrease');
  await t.ctl.run('textSize.decrease');
  assert.equal(t.server.prefs.font_scale, 0.9);
  await t.ctl.run('textSize.reset');
  assert.equal(t.server.prefs.font_scale, 1);
  assert.equal(t.ctl.run('textSize.reset'), true, 'already 1 → no PATCH');
  for (const th of ['dark', 'light', 'system']) {
    await t.ctl.run(`theme.${th}`);
    assert.equal(t.server.prefs.theme, th);
    assert.equal(t.ui.highContrast, false);
  }
  // high contrast is client-local: the API only accepts system|dark|light (API.md §4)
  const patches = t.calls.filter((c) => c[0] === 'patchPrefs').length;
  assert.equal(t.ctl.run('theme.high-contrast'), true);
  assert.equal(t.ui.highContrast, true);
  assert.equal(t.server.prefs.theme, 'system', 'server theme untouched');
  assert.equal(t.calls.filter((c) => c[0] === 'patchPrefs').length, patches, 'no PATCH for high contrast');
  assert.deepEqual(t.local, { 'omniwatch.highContrast': '1' });
  await t.ctl.run('theme.dark');
  assert.equal(t.ui.highContrast, false);
  assert.deepEqual(t.local, { 'omniwatch.highContrast': '' });
  await t.ctl.run('theme.set', { theme: 'light' });
  assert.equal(t.server.prefs.theme, 'light');
  assert.equal(t.ctl.run('theme.set', { theme: 'neon' }), true);
  assert.equal(t.server.prefs.theme, 'light');
  t.ctl.run('commandPalette.open');
  assert.deepEqual(t.ui.modal, { type: 'palette', query: '', index: 0 });
  t.ctl.run('settings.open');
  assert.deepEqual(t.ui.modal, { type: 'settings', section: 'general' });
  t.ctl.run('help.open');
  assert.equal(t.ui.modal.type, 'help');
  t.ctl.run('onboarding.open', { step: 2 });
  assert.deepEqual(t.ui.modal, { type: 'onboarding', step: 2 });
  assert.ok(t.envCalls.includes('diagnostics'));
  await t.ctl.run('onboarding.done');
  assert.equal(t.ui.modal, null);
  assert.equal(t.server.prefs.onboarding_done, true);
  await t.ctl.run('prefs.set', { hint_bar: true });
  assert.equal(t.server.prefs.hint_bar, true);
  t.ctl.run('filter.focus');
  t.ctl.run('focusRegion.next');
  t.ctl.run('focusRegion.prev');
  assert.deepEqual(t.envCalls.slice(-3), ['focusFilter', 'region1', 'region-1']);
});

test('prefs PATCH merges the server response and reports failures', async () => {
  const t = setup({ apiOverrides: { patchPrefs: () => Promise.resolve({ ...fixture.prefs, sort: 'path', view: 'split' }) } });
  await t.ctl.patchPrefs({ sort: 'agents' });
  assert.equal(t.server.prefs.sort, 'path', 'server response wins');
  const f = setup({ apiOverrides: { patchPrefs: () => Promise.reject(new Error('422')) } });
  assert.equal(await f.ctl.patchPrefs({ sort: 'agents' }), false);
  assert.equal(f.toasts().at(-1), 'settings failed: 422');
});

test('unwind (Esc) and q: q closes the window in the app only (P-73)', () => {
  const t = setup({ ui: { filter: 'x' } });
  t.ctl.run('unwind');
  assert.equal(t.ui.filter, '');
  t.ctl.run('unwind');
  t.ctl.run('window.close');
  assert.deepEqual(t.nativeCalls, [], 'browser: q does nothing');
  const app = setup({ native: true });
  app.ctl.run('window.close');
  assert.deepEqual(app.nativeCalls, [['closeWindow']]);
  const off = setup({ native: true, server: { prefs: { ...fixture.prefs, close_window_on_q: false } } });
  off.ctl.run('window.close');
  assert.deepEqual(off.nativeCalls, []);
  const ov = setup({ native: true, ui: { overlay: 'usage' } });
  ov.ctl.run('window.close');
  assert.deepEqual([ov.ui.overlay, ov.nativeCalls.length], [null, 0], 'q inside usage goes back (P-51)');
});

test('keep on top posts to native and PATCHes; browser explains it is app-only (§3 P0)', async () => {
  const app = setup({ native: true });
  await app.ctl.run('keepOnTop.toggle');
  assert.deepEqual(app.nativeCalls, [['keepOnTop', true]]);
  assert.equal(app.server.prefs.keep_on_top, true);
  await app.ctl.run('keepOnTop.toggle', { value: false });
  assert.deepEqual(app.nativeCalls.at(-1), ['keepOnTop', false]);
  const br = setup();
  await br.ctl.run('keepOnTop.toggle');
  assert.equal(br.toasts().at(-1), 'Keep on top works in the Omniwatch app window');
});

test('notification permission and demo go to native in the app, browser APIs otherwise', () => {
  const app = setup({ native: true });
  app.ctl.run('notifications.request');
  app.ctl.run('demo.try');
  assert.deepEqual(app.nativeCalls, [['notifyPermission'], ['restartBackend', true]]);
  const br = setup();
  br.ctl.run('notifications.request');
  br.ctl.run('demo.try');
  assert.ok(br.envCalls.includes('browserPermission'));
  assert.equal(br.toasts().at(-1), 'Run `omniwatch demo` in a terminal to try the demo');
});

test('quota banner actions (P-21)', async () => {
  const t = setup({ server: { quota_prompt: { pct: 91, to: 'x' } } });
  await t.ctl.run('quota.draft');
  assert.deepEqual(t.calls.at(-1), ['quotaEmailDraft']);
  assert.equal(t.server.quota_prompt, null);
  await t.ctl.run('quota.skip');
  assert.equal(t.toasts().at(-1), 'quota email skipped this month');
  assert.equal(reduce(t.server, { type: 'quotaCleared' }), t.server, 'already cleared → same state');
  const f = setup({ apiOverrides: { quotaEmailDraft: () => Promise.reject(new Error('a')), quotaEmailSkip: () => Promise.reject(new Error('b')) } });
  await f.ctl.run('quota.draft');
  await f.ctl.run('quota.skip');
  assert.deepEqual(f.toasts().slice(-2), ['draft email failed: a', 'skip failed: b']);
});

test('transition → waiting: flash, toast, chime + browser notification unless muted/native (P-31/32/33)', () => {
  const t = setup({ server: { prefs: { ...fixture.prefs, sound: true } } });
  t.ctl.onServerEvent({ type: 'transition', data: { uid: 'u1', from: 'busy', to: 'waiting', title: 'api', muted: false } });
  assert.ok(t.ui.flashes.u1);
  assert.equal(t.toasts().at(-1), '◉ api is waiting for your input');
  assert.equal(t.ui.toasts.at(-1).command, 'session.select');
  assert.deepEqual(t.envCalls.filter((c) => c === 'chime' || c.startsWith('notify')), ['chime', 'notify:u1']);
  t.ctl.onServerEvent({ type: 'transition', data: { uid: 'u2', from: 'busy', to: 'waiting', muted: true } });
  assert.equal(t.ui.flashes.u2, undefined, 'muted: no flash');
  t.ctl.onServerEvent({ type: 'transition', data: { uid: 'u3', from: 'waiting', to: 'waiting' } });
  t.ctl.onServerEvent({ type: 'transition', data: { uid: 'u4', from: 'waiting', to: 'busy' } });
  assert.equal(Object.keys(t.ui.flashes).length, 1);
  t.ctl.onServerEvent({ type: 'transition', data: { uid: 'u5', from: null, to: 'waiting' } });
  assert.equal(t.toasts().at(-1), '◉ A session is waiting for your input');
  const quiet = setup({ server: { prefs: { ...fixture.prefs, sound: false, notifications: { enabled: false } } } });
  quiet.ctl.onServerEvent({ type: 'transition', data: { uid: 'u1', from: 'busy', to: 'waiting' } });
  assert.deepEqual(quiet.envCalls.filter((c) => c === 'chime' || c.startsWith('notify')), []);
  const app = setup({ native: true, server: { prefs: { ...fixture.prefs, sound: true } } });
  app.ctl.onServerEvent({ type: 'transition', data: { uid: 'u1', from: 'busy', to: 'waiting' } });
  assert.deepEqual(app.envCalls.filter((c) => c === 'chime' || c.startsWith('notify')), [], 'native plays the sound and posts the notification');
  const noNotifPrefs = setup({ server: { prefs: { ...fixture.prefs, notifications: undefined } } });
  noNotifPrefs.ctl.onServerEvent({ type: 'transition', data: { uid: 'u1', from: 'busy', to: 'waiting' } });
  assert.ok(noNotifPrefs.envCalls.includes('notify:u1'));
});

test('action failures toast "{kind} failed: {detail}" (P-71); other events ignored', () => {
  const t = setup();
  t.ctl.onServerEvent({ type: 'action', data: { kind: 'goto', ok: false, detail: 'session not found' } });
  assert.equal(t.toasts().at(-1), 'goto failed: session not found');
  t.ctl.onServerEvent({ type: 'action', data: { ok: false } });
  assert.equal(t.toasts().at(-1), 'action failed: ?');
  const n = t.ui.toasts.length;
  t.ctl.onServerEvent({ type: 'action', data: { kind: 'goto', ok: true } });
  t.ctl.onServerEvent({ type: 'toast', data: {} });
  t.ctl.onServerEvent({ type: 'usage', data: {} });
  t.ctl.onServerEvent(null);
  t.ctl.onServerEvent({ type: 'transition' });
  assert.equal(t.ui.toasts.length, n);
  t.ctl.onServerEvent({ type: 'toast', data: { level: 'warn', message: 'hey' } });
  assert.equal(t.ui.toasts.at(-1).level, 'warn');
});
