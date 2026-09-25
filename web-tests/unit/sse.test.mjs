import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSseClient, EVENT_TYPES, DEFAULT_BACKOFF_MS } from '../../omniwatch/web/js/sse.js';

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.closed = false;
    this._listeners = {};
    FakeEventSource.instances.push(this);
  }
  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }
  close() { this.closed = true; }
  emit(type, data, lastEventId) {
    (this._listeners[type] || []).forEach((fn) => fn({ data: JSON.stringify(data), lastEventId }));
  }
  open() { if (this.onopen) this.onopen(); }
  error(err) { if (this.onerror) this.onerror(err); }
}
FakeEventSource.instances = [];

function fakeTimers() {
  const scheduled = [];
  return {
    setTimeoutImpl: (fn, delay) => { const id = scheduled.length; scheduled.push({ fn, delay }); return id; },
    clearTimeoutImpl: (id) => { scheduled[id] = null; },
    scheduled,
    fireNext() {
      const entry = scheduled.find(Boolean);
      const idx = scheduled.indexOf(entry);
      scheduled[idx] = null;
      entry.fn();
    },
  };
}

test('EVENT_TYPES covers every §4.4.2 SSE event', () => {
  assert.deepEqual(
    [...EVENT_TYPES].sort(),
    ['action', 'capabilities', 'hello', 'prefs', 'quota', 'screens', 'sessions', 'state', 'toast', 'transition', 'usage'].sort(),
  );
});

test('connect() attaches a listener for every known event type and forwards decoded data', () => {
  FakeEventSource.instances.length = 0;
  const received = [];
  const client = createSseClient({
    url: '/api/v1/events',
    EventSourceImpl: FakeEventSource,
    onEvent: (type, data) => received.push({ type, data }),
  });
  client.connect();
  const es = FakeEventSource.instances[0];
  assert.equal(es.url, '/api/v1/events');
  es.emit('hello', { version: '1.0.0', demo: true });
  es.emit('sessions', { seq: 2, sessions: [] });
  assert.deepEqual(received, [
    { type: 'hello', data: { version: '1.0.0', demo: true } },
    { type: 'sessions', data: { seq: 2, sessions: [] } },
  ]);
});

test('tracks lastEventId and appends it as a query param on reconnect', () => {
  FakeEventSource.instances.length = 0;
  const timers = fakeTimers();
  const client = createSseClient({
    url: '/api/v1/events',
    EventSourceImpl: FakeEventSource,
    onEvent: () => {},
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  client.connect();
  const first = FakeEventSource.instances[0];
  first.emit('state', {}, 'evt-42');
  assert.equal(client.lastEventId, 'evt-42');

  first.error(new Error('boom'));
  assert.equal(first.closed, true);
  timers.fireNext();

  const second = FakeEventSource.instances[1];
  assert.equal(second.url, '/api/v1/events?last_event_id=evt-42');
});

test('reconnect backoff follows DEFAULT_BACKOFF_MS and resets after a clean open', () => {
  FakeEventSource.instances.length = 0;
  const timers = fakeTimers();
  const delays = [];
  const client = createSseClient({
    url: '/api/v1/events',
    EventSourceImpl: FakeEventSource,
    onEvent: () => {},
    onReconnectScheduled: (attempt, delay) => delays.push(delay),
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  client.connect();
  FakeEventSource.instances[0].error(new Error('e1'));
  timers.fireNext();
  FakeEventSource.instances[1].error(new Error('e2'));
  timers.fireNext();
  FakeEventSource.instances[2].error(new Error('e3'));
  timers.fireNext();

  assert.deepEqual(delays, DEFAULT_BACKOFF_MS.slice(0, 3));

  // A clean open resets the attempt counter.
  FakeEventSource.instances[3].open();
  assert.equal(client.attempt, 0);
});

test('close() stops reconnect attempts and closes the live connection', () => {
  FakeEventSource.instances.length = 0;
  const timers = fakeTimers();
  const client = createSseClient({
    url: '/api/v1/events',
    EventSourceImpl: FakeEventSource,
    onEvent: () => {},
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  client.connect();
  const es = FakeEventSource.instances[0];
  client.close();
  assert.equal(es.closed, true);
  assert.equal(client.isClosed, true);

  // Even if an error somehow still fires post-close, no new connection is made.
  es.error(new Error('late'));
  assert.equal(FakeEventSource.instances.length, 1);
});

test('createSseClient() requires a url and an EventSource implementation', () => {
  assert.throws(() => createSseClient({ EventSourceImpl: FakeEventSource }), /url is required/);
  assert.throws(() => createSseClient({ url: '/x', EventSourceImpl: undefined }), /no EventSource implementation/);
});
