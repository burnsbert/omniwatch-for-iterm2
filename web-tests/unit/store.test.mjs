import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, createAppStore } from '../../omniwatch/web/js/store.js';
import { initialState } from '../../omniwatch/web/js/reducer.js';

test('createStore(): dispatch runs the reducer and notifies subscribers', () => {
  const store = createStore((s, e) => (e.type === 'inc' ? s + e.data : s), 0);
  const seen = [];
  const unsubscribe = store.subscribe((state) => seen.push(state));
  store.dispatch({ type: 'inc', data: 5 });
  store.dispatch({ type: 'inc', data: 2 });
  assert.equal(store.getState(), 7);
  assert.deepEqual(seen, [5, 7]);
  unsubscribe();
  store.dispatch({ type: 'inc', data: 1 });
  assert.deepEqual(seen, [5, 7]); // no longer notified
});

test('createStore(): a no-op reducer (same reference) does not notify subscribers', () => {
  const store = createStore((s) => s, { a: 1 });
  let calls = 0;
  store.subscribe(() => { calls += 1; });
  store.dispatch({ type: 'noop' });
  assert.equal(calls, 0);
});

test('createAppStore(): with no `sse` option, is a plain store seeded with reducer.initialState', () => {
  const store = createAppStore({});
  assert.equal(store.getState(), initialState);
  assert.equal(store.sse, null);
  // connect()/close() are safe no-ops without an sse client.
  assert.doesNotThrow(() => store.connect());
  assert.doesNotThrow(() => store.close());
});

test('createAppStore(): wires a fake EventSource so SSE events reach subscribers via dispatch', () => {
  class FakeEventSource {
    constructor(url) { this.url = url; FakeEventSource.instances.push(this); this._listeners = {}; }
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
    close() {}
    emit(type, data) { (this._listeners[type] || []).forEach((fn) => fn({ data: JSON.stringify(data) })); }
  }
  FakeEventSource.instances = [];

  const store = createAppStore({ sse: { url: '/api/v1/events', EventSourceImpl: FakeEventSource } });
  const seen = [];
  store.subscribe((state) => seen.push(state.version));
  store.connect();
  const es = FakeEventSource.instances[0];
  es.emit('hello', { version: '1.2.3', server_time: 1, demo: false });
  assert.equal(store.getState().version, '1.2.3');
  assert.deepEqual(seen, ['1.2.3']);
});

test('createAppStore(): onOpen/onReconnectScheduled drive connectionStatus through the same dispatch path', () => {
  class FakeEventSource {
    constructor(url) { this.url = url; FakeEventSource.instances.push(this); this._listeners = {}; }
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
    close() {}
    open() { if (this.onopen) this.onopen(); }
    error(e) { if (this.onerror) this.onerror(e); }
  }
  FakeEventSource.instances = [];
  const scheduled = [];

  const store = createAppStore({
    sse: {
      url: '/api/v1/events',
      EventSourceImpl: FakeEventSource,
      setTimeoutImpl: (fn, delay) => { scheduled.push(fn); return scheduled.length - 1; },
      clearTimeoutImpl: () => {},
    },
  });
  const statuses = [];
  store.subscribe((state) => statuses.push(state.connectionStatus));
  store.connect();
  FakeEventSource.instances[0].open();
  assert.deepEqual(statuses, ['connected']);
  FakeEventSource.instances[0].error(new Error('boom'));
  assert.deepEqual(statuses, ['connected', 'reconnecting']);
});
