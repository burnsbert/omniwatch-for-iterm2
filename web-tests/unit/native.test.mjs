// Parity target: docs/SHELL_CONTRACT.md §6 (Swift shell <-> web bridge).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNativeBridge } from '../../omniwatch/web/js/native.js';

function fakeHost() {
  const posted = [];
  return {
    window: {
      webkit: { messageHandlers: { omniwatch: { postMessage: (m) => posted.push(m) } } },
    },
    posted,
  };
}

test('in a plain browser/Node (no window.webkit), every post is a no-op returning false', () => {
  const bridge = createNativeBridge({});
  assert.equal(bridge.isAvailable(), false);
  assert.equal(bridge.postMessage({ type: 'theme', value: 'dark' }), false);
  assert.equal(bridge.reportTheme('dark'), false);
  assert.equal(bridge.requestNotifyPermission(), false);
  assert.equal(bridge.setKeepOnTop(true), false);
  assert.equal(bridge.setVisible(['u1']), false);
  assert.equal(bridge.closeWindow(), false);
  assert.equal(bridge.restartBackend(true), false);
  assert.equal(bridge.sendReady(), false);
});

test('inside a WKWebView host, messages are posted to webkit.messageHandlers.omniwatch', () => {
  const { window, posted } = fakeHost();
  const bridge = createNativeBridge(window);
  assert.equal(bridge.isAvailable(), true);
  assert.equal(bridge.reportTheme('dark'), true);
  assert.equal(bridge.requestNotifyPermission(), true);
  assert.equal(bridge.setKeepOnTop(true), true);
  assert.deepEqual(posted, [
    { type: 'theme', value: 'dark' },
    { type: 'notifyPermission' },
    { type: 'keepOnTop', value: true },
  ]);
});

test('setKeepOnTop() coerces its argument to a boolean', () => {
  const { window, posted } = fakeHost();
  const bridge = createNativeBridge(window);
  bridge.setKeepOnTop(0);
  assert.equal(posted[0].value, false);
});

// §6: {type:"visible", uids:[...]} — uids on screen, for notification suppression.
test('setVisible() posts {type:"visible", uids} and accepts any iterable', () => {
  const { window, posted } = fakeHost();
  const bridge = createNativeBridge(window);
  bridge.setVisible(new Set(['u1', 'u2']));
  assert.deepEqual(posted[0], { type: 'visible', uids: ['u1', 'u2'] });
  bridge.setVisible();
  assert.deepEqual(posted[1], { type: 'visible', uids: [] });
});

// §6: {type:"closeWindow"} — 'q' (P-73): hide the window, stay in the menu bar.
test('closeWindow() posts {type:"closeWindow"}', () => {
  const { window, posted } = fakeHost();
  const bridge = createNativeBridge(window);
  bridge.closeWindow();
  assert.deepEqual(posted[0], { type: 'closeWindow' });
});

// §6: {type:"restartBackend", demo:bool} — onboarding "Try the demo".
test('restartBackend() posts {type:"restartBackend", demo} and defaults demo to false', () => {
  const { window, posted } = fakeHost();
  const bridge = createNativeBridge(window);
  bridge.restartBackend(true);
  bridge.restartBackend();
  assert.deepEqual(posted, [
    { type: 'restartBackend', demo: true },
    { type: 'restartBackend', demo: false },
  ]);
});

// §6: {type:"ready"} — required; native queues command/nativeEvent calls until this arrives.
test('sendReady() posts {type:"ready"}', () => {
  const { window, posted } = fakeHost();
  const bridge = createNativeBridge(window);
  bridge.sendReady();
  assert.deepEqual(posted[0], { type: 'ready' });
});

// §6: window.omniwatch.command(id, args?) — native -> web, args must pass through
// (e.g. session.select gets {uid}), and command/nativeEvent must coexist on
// the same window.omniwatch object without clobbering each other.
test('registerCommandHandler() installs window.omniwatch.command(id, args) with args passed through', () => {
  const fakeWindow = {};
  const bridge = createNativeBridge(fakeWindow);
  const calls = [];
  const unregister = bridge.registerCommandHandler((id, args) => calls.push([id, args]));
  assert.equal(typeof fakeWindow.omniwatch.command, 'function');
  fakeWindow.omniwatch.command('view.grid');
  fakeWindow.omniwatch.command('session.select', { uid: 'u1' });
  assert.deepEqual(calls, [['view.grid', undefined], ['session.select', { uid: 'u1' }]]);
  unregister();
  assert.equal(fakeWindow.omniwatch.command, undefined);
});

test('registerNativeEventHandler() installs window.omniwatch.nativeEvent(event)', () => {
  const fakeWindow = {};
  const bridge = createNativeBridge(fakeWindow);
  const events = [];
  const unregister = bridge.registerNativeEventHandler((e) => events.push(e));
  assert.equal(typeof fakeWindow.omniwatch.nativeEvent, 'function');
  fakeWindow.omniwatch.nativeEvent({ type: 'notifyPermission', status: 'granted' });
  assert.deepEqual(events, [{ type: 'notifyPermission', status: 'granted' }]);
  unregister();
  assert.equal(fakeWindow.omniwatch.nativeEvent, undefined);
});

test('command and nativeEvent handlers coexist on the same window.omniwatch object', () => {
  const fakeWindow = {};
  const bridge = createNativeBridge(fakeWindow);
  bridge.registerCommandHandler(() => {});
  bridge.registerNativeEventHandler(() => {});
  assert.equal(typeof fakeWindow.omniwatch.command, 'function');
  assert.equal(typeof fakeWindow.omniwatch.nativeEvent, 'function');
});

test('install() wires both handlers and then sends {type:"ready"} (native queues until ready)', () => {
  const { window, posted } = fakeHost();
  const bridge = createNativeBridge(window);
  const commandCalls = [];
  const eventCalls = [];
  bridge.install({
    onCommand: (id, args) => commandCalls.push([id, args]),
    onNativeEvent: (e) => eventCalls.push(e),
  });
  assert.deepEqual(posted, [{ type: 'ready' }]);
  window.omniwatch.command('refresh');
  window.omniwatch.nativeEvent({ type: 'notifyPermission', status: 'denied' });
  assert.deepEqual(commandCalls, [['refresh', undefined]]);
  assert.deepEqual(eventCalls, [{ type: 'notifyPermission', status: 'denied' }]);
});

test('install() tolerates omitting either handler', () => {
  const { window, posted } = fakeHost();
  const bridge = createNativeBridge(window);
  assert.doesNotThrow(() => bridge.install({ onCommand: () => {} }));
  assert.deepEqual(posted, [{ type: 'ready' }]);
  assert.equal(window.omniwatch.nativeEvent, undefined);
});

test('install()\'s unregister function tears down both handlers', () => {
  const fakeWindow = {};
  const bridge = createNativeBridge(fakeWindow);
  const unregister = bridge.install({ onCommand: () => {}, onNativeEvent: () => {} });
  unregister();
  assert.equal(fakeWindow.omniwatch.command, undefined);
  assert.equal(fakeWindow.omniwatch.nativeEvent, undefined);
});

// §6: window.__OMNIWATCH_NATIVE__ marker (app-mode behaviors: skip WebAudio
// chime/Web Notification API, 'q' posts closeWindow, ...).
test('isNativeHost()/getNativeInfo() read the __OMNIWATCH_NATIVE__ marker', () => {
  const info = Object.freeze({ app: 'Omniwatch', bridge: 1, platform: 'macos', version: '1.0.0' });
  const bridge = createNativeBridge({ __OMNIWATCH_NATIVE__: info });
  assert.equal(bridge.isNativeHost(), true);
  assert.deepEqual(bridge.getNativeInfo(), info);
});

test('isNativeHost()/getNativeInfo() are false/null without the marker', () => {
  const bridge = createNativeBridge({});
  assert.equal(bridge.isNativeHost(), false);
  assert.equal(bridge.getNativeInfo(), null);
});

test('a missing webkit.messageHandlers.omniwatch (partial webkit object) is still treated as unavailable', () => {
  const bridge = createNativeBridge({ webkit: {} });
  assert.equal(bridge.isAvailable(), false);
  assert.equal(bridge.postMessage({ type: 'theme', value: 'light' }), false);
});

test('launchAtLogin / menuBarOnly post the SHELL_CONTRACT §6 messages', async () => {
  const { createNativeBridge } = await import('../../omniwatch/web/js/native.js');
  const sent = [];
  const g = { webkit: { messageHandlers: { omniwatch: { postMessage: (m) => sent.push(m) } } } };
  const b = createNativeBridge(g);
  assert.equal(b.setLaunchAtLogin(1), true);
  assert.equal(b.setMenuBarOnly(false), true);
  assert.deepEqual(sent, [{ type: 'launchAtLogin', value: true }, { type: 'menuBarOnly', value: false }]);
  assert.equal(createNativeBridge({}).setLaunchAtLogin(true), false, 'no-op outside the app');
});
