import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { reduce, initialState, dismissToast, setConnectionStatus, EVENT_TYPES } from '../../omniwatch/web/js/reducer.js';

const fixture = JSON.parse(readFileSync(
  fileURLToPath(new URL('../fixtures/state.json', import.meta.url)),
  'utf8',
));

test('reducer.EVENT_TYPES covers every §4.4.2 SSE event (plus the local "connection" event)', () => {
  const serverTypes = ['hello', 'state', 'sessions', 'screens', 'usage', 'prefs', 'transition', 'toast', 'action', 'quota', 'capabilities'];
  for (const t of serverTypes) {
    assert.ok(EVENT_TYPES.includes(t), `missing handler for SSE event type "${t}"`);
  }
});

test('unknown event types are a no-op and return the same state reference', () => {
  const next = reduce(initialState, { type: 'not-a-real-event', data: {} });
  assert.equal(next, initialState);
});

test('malformed events (no type) are a no-op', () => {
  assert.equal(reduce(initialState, null), initialState);
  assert.equal(reduce(initialState, {}), initialState);
  assert.equal(reduce(initialState, { data: {} }), initialState);
});

test('"hello" sets version/server_time/demo and marks the connection connected', () => {
  const next = reduce(initialState, { type: 'hello', data: { version: '1.0.0', server_time: 100, demo: true } });
  assert.equal(next.version, '1.0.0');
  assert.equal(next.server_time, 100);
  assert.equal(next.demo, true);
  assert.equal(next.connectionStatus, 'connected');
});

test('"state" replaces the full server-owned document from the §4.4.1 fixture', () => {
  const next = reduce(initialState, { type: 'state', data: fixture });
  assert.equal(next.seq, fixture.seq);
  assert.equal(next.sessions.length, fixture.sessions.length);
  assert.deepEqual(next.summary, fixture.summary);
  assert.deepEqual(next.prefs, fixture.prefs);
  assert.deepEqual(next.projects, fixture.projects);
  assert.deepEqual(next.capabilities, fixture.capabilities);
  // Client-only bookkeeping survives a full "state" replace.
  assert.equal(next.connectionStatus, 'connected');
  assert.deepEqual(next.toasts, []);
});

test('"sessions" updates sessions/summary/windows/iterm without touching screens/usage', () => {
  const seeded = reduce(initialState, { type: 'state', data: fixture });
  const patch = {
    seq: 900,
    sessions: fixture.sessions.slice(0, 1),
    summary: { tabs: 1, agents: 1, waiting: 0, busy: 1, waiting_uids: [] },
    windows: fixture.windows,
    iterm: { ...fixture.iterm, poll_ms: 500 },
  };
  const next = reduce(seeded, { type: 'sessions', data: patch });
  assert.equal(next.sessions.length, 1);
  assert.equal(next.iterm.poll_ms, 500);
  assert.equal(next.seq, 900);
  assert.deepEqual(next.screens, seeded.screens); // untouched
  assert.deepEqual(next.usage, seeded.usage); // untouched
});

test('"screens" merges updated hashes/text and deletes removed uids', () => {
  const seeded = reduce(initialState, { type: 'state', data: fixture });
  const uid = fixture.sessions[0].uid;
  const next = reduce(seeded, {
    type: 'screens',
    data: { seq: 901, screens: { [uid]: { hash: 'newhash', text: 'updated' } }, removed: ['does-not-exist'] },
  });
  assert.equal(next.screens[uid].hash, 'newhash');
  // Every other uid's screen is preserved.
  const otherUid = fixture.sessions[1].uid;
  assert.deepEqual(next.screens[otherUid], seeded.screens[otherUid]);

  const withRemoval = reduce(next, { type: 'screens', data: { seq: 902, screens: {}, removed: [uid] } });
  assert.equal(Object.prototype.hasOwnProperty.call(withRemoval.screens, uid), false);
});

test('"usage" replaces the usage block', () => {
  const next = reduce(initialState, { type: 'usage', data: { seq: 5, usage: fixture.usage } });
  assert.deepEqual(next.usage, fixture.usage);
  assert.equal(next.seq, 5);
});

test('"prefs" replaces prefs and projects together', () => {
  const next = reduce(initialState, { type: 'prefs', data: { seq: 6, prefs: fixture.prefs, projects: fixture.projects } });
  assert.deepEqual(next.prefs, fixture.prefs);
  assert.deepEqual(next.projects, fixture.projects);
});

test('"transition" records the last transition for UI side-effects (pulse/toast/sound)', () => {
  const data = { uid: 'u1', from: 'busy', to: 'waiting', at: 123, title: 't', agent: 'claude', prompt: null, muted: false };
  const next = reduce(initialState, { type: 'transition', data });
  assert.deepEqual(next.lastTransition, data);
});

test('"toast" appends a toast with a deterministic incrementing id', () => {
  let state = initialState;
  state = reduce(state, { type: 'toast', data: { level: 'info', message: 'refreshing…' } });
  state = reduce(state, { type: 'toast', data: { level: 'warn', message: 'stale' } });
  assert.equal(state.toasts.length, 2);
  assert.deepEqual(state.toasts[0], { id: 1, level: 'info', message: 'refreshing…' });
  assert.deepEqual(state.toasts[1], { id: 2, level: 'warn', message: 'stale' });
});

test('dismissToast() removes exactly the toast with that id', () => {
  let state = reduce(initialState, { type: 'toast', data: { level: 'info', message: 'a' } });
  state = reduce(state, { type: 'toast', data: { level: 'info', message: 'b' } });
  const next = dismissToast(state, 1);
  assert.equal(next.toasts.length, 1);
  assert.equal(next.toasts[0].message, 'b');
  // Removing an id that isn't present returns the same reference.
  assert.equal(dismissToast(next, 999), next);
});

test('"action" records the last action result (e.g. reply 409 stale_screen)', () => {
  const data = { id: 'a-1', kind: 'reply', uid: 'u1', ok: false, detail: 'stale_screen' };
  const next = reduce(initialState, { type: 'action', data });
  assert.deepEqual(next.lastAction, data);
});

test('"quota" sets quota_prompt', () => {
  const next = reduce(initialState, { type: 'quota', data: { pct: 92, to: 'me@example.com' } });
  assert.deepEqual(next.quota_prompt, { pct: 92, to: 'me@example.com' });
});

test('"capabilities" replaces the capabilities block', () => {
  const next = reduce(initialState, { type: 'capabilities', data: { tab_colors: false, reply: true, debug_rule: false } });
  assert.deepEqual(next.capabilities, { tab_colors: false, reply: true, debug_rule: false });
});

test('setConnectionStatus() is a no-op when the status is unchanged (same reference)', () => {
  const connected = reduce(initialState, { type: 'connection', data: { status: 'connected' } });
  assert.equal(setConnectionStatus(connected, 'connected'), connected);
  const reconnecting = setConnectionStatus(connected, 'reconnecting');
  assert.equal(reconnecting.connectionStatus, 'reconnecting');
});

test('reduce() never mutates its input state object', () => {
  const before = JSON.parse(JSON.stringify(initialState));
  reduce(initialState, { type: 'hello', data: { version: '1.0.0', server_time: 1, demo: false } });
  assert.deepEqual(initialState, before);
});
