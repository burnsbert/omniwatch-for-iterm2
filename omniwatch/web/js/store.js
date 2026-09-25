// store.js — a minimal pub/sub store around reducer.js, plus the wiring
// that turns sse.js events into dispatches. Deliberately tiny (no thunks,
// no middleware): WP5's components subscribe and read `getState()`.

import { reduce, initialState } from './reducer.js';
import { createSseClient } from './sse.js';

/**
 * Generic store: getState/dispatch/subscribe over a pure reducer.
 * @param {(state:any, event:any) => any} reducer
 * @param {any} seedState
 */
export function createStore(reducer, seedState) {
  let state = seedState;
  const listeners = new Set();

  function getState() {
    return state;
  }

  function dispatch(event) {
    const next = reducer(state, event);
    if (next !== state) {
      const prev = state;
      state = next;
      for (const fn of listeners) fn(state, prev, event);
    }
    return state;
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return { getState, dispatch, subscribe };
}

/**
 * Build the app store wired to reducer.js and (optionally) a live SSE
 * connection. Omit `sse` (default) to get a plain store for tests; pass
 * `sse: {url, EventSourceImpl}` to wire up a real/fake EventSource — every
 * SSE event and connection-lifecycle change is routed through the same
 * `dispatch`, so subscribers only need one hook.
 *
 * @param {object} [opts]
 * @param {any} [opts.seedState]   defaults to reducer.initialState
 * @param {object|null} [opts.sse] forwarded to sse.js's createSseClient
 */
export function createAppStore({ seedState = initialState, sse = null } = {}) {
  const store = createStore(reduce, seedState);

  let sseClient = null;
  if (sse) {
    sseClient = createSseClient({
      ...sse,
      onEvent: (type, data, lastEventId) => {
        store.dispatch({ type, data });
        if (sse.onEvent) sse.onEvent(type, data, lastEventId);
      },
      onOpen: () => {
        store.dispatch({ type: 'connection', data: { status: 'connected' } });
        if (sse.onOpen) sse.onOpen();
      },
      onReconnectScheduled: (attempt, delayMs) => {
        store.dispatch({ type: 'connection', data: { status: 'reconnecting' } });
        if (sse.onReconnectScheduled) sse.onReconnectScheduled(attempt, delayMs);
      },
      onError: (err) => {
        if (sse.onError) sse.onError(err);
      },
    });
  }

  return {
    getState: store.getState,
    dispatch: store.dispatch,
    subscribe: store.subscribe,
    sse: sseClient,
    connect: () => sseClient && sseClient.connect(),
    close: () => sseClient && sseClient.close(),
  };
}
