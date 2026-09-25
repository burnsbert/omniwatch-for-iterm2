// sse.js — SSE client for GET /api/v1/events (DESIGN.md §4.4.2), with
// exponential-backoff reconnect (§2.9: "Reconnecting..." banner, 0.5s -> 8s).
//
// DOM-independent: the EventSource constructor is injectable so this can be
// unit-tested in Node (no global EventSource there). In a browser, omit
// `EventSourceImpl` and the global `EventSource` is used.
//
// The server always sends a named `event:` line (never bare `message`), so
// this module attaches one listener per known event type (§4.4.2 table)
// rather than relying on `onmessage`. Unknown event names are ignored (a
// server can add new event types without breaking older clients).

export const EVENT_TYPES = [
  'hello', 'state', 'sessions', 'screens', 'usage', 'prefs',
  'transition', 'toast', 'action', 'quota', 'capabilities',
  // API.md §6 (P1→v1): blocked-on-you stats and stall notices.
  'stats', 'stall',
];

export const DEFAULT_BACKOFF_MS = [500, 1000, 2000, 4000, 8000];

/**
 * @param {object} opts
 * @param {string} opts.url                     e.g. '/api/v1/events'
 * @param {Function} [opts.EventSourceImpl]      injectable EventSource constructor
 * @param {number[]} [opts.backoffMs]            reconnect delays, last value repeats
 * @param {(type:string, data:any, lastEventId:string) => void} [opts.onEvent]
 * @param {() => void} [opts.onOpen]
 * @param {(err:any) => void} [opts.onError]
 * @param {(attempt:number, delayMs:number) => void} [opts.onReconnectScheduled]
 * @param {Function} [opts.setTimeoutImpl]
 * @param {Function} [opts.clearTimeoutImpl]
 */
export function createSseClient({
  url,
  EventSourceImpl = (typeof EventSource !== 'undefined' ? EventSource : undefined),
  backoffMs = DEFAULT_BACKOFF_MS,
  onEvent,
  onOpen,
  onError,
  onReconnectScheduled,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (!url) throw new Error('sse.js: url is required');
  if (!EventSourceImpl) {
    throw new Error('sse.js: no EventSource implementation available; pass EventSourceImpl');
  }

  let es = null;
  let attempt = 0;
  let closed = false;
  let timer = null;
  let lastEventId = null;

  function targetUrl() {
    if (!lastEventId) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}last_event_id=${encodeURIComponent(lastEventId)}`;
  }

  function scheduleReconnect() {
    if (closed) return;
    const delay = backoffMs[Math.min(attempt, backoffMs.length - 1)];
    attempt += 1;
    if (onReconnectScheduled) onReconnectScheduled(attempt, delay);
    timer = setTimeoutImpl(connect, delay);
  }

  function handleEvent(type) {
    return (ev) => {
      if (ev && ev.lastEventId) lastEventId = ev.lastEventId;
      let data = null;
      if (ev && ev.data) {
        try {
          data = JSON.parse(ev.data);
        } catch (_) {
          data = null;
        }
      }
      if (onEvent) onEvent(type, data, ev ? ev.lastEventId : undefined);
    };
  }

  function connect() {
    if (closed) return;
    es = new EventSourceImpl(targetUrl());
    es.onopen = () => {
      attempt = 0;
      if (onOpen) onOpen();
    };
    es.onerror = (err) => {
      if (onError) onError(err);
      // Browsers auto-reconnect native EventSource on transport errors, but
      // we manage backoff ourselves for the "Reconnecting..." UI, so force
      // a clean stop-and-retry instead of relying on the built-in retry.
      if (es) {
        es.close();
      }
      scheduleReconnect();
    };
    for (const type of EVENT_TYPES) {
      es.addEventListener(type, handleEvent(type));
    }
  }

  function close() {
    closed = true;
    if (timer) {
      clearTimeoutImpl(timer);
      timer = null;
    }
    if (es) {
      es.close();
      es = null;
    }
  }

  return {
    connect,
    close,
    get isClosed() { return closed; },
    get attempt() { return attempt; },
    get lastEventId() { return lastEventId; },
  };
}
