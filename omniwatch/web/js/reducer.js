// reducer.js — pure (state, event) -> state for every SSE event type in
// DESIGN.md §4.4.2. No I/O, no Date.now()/Math.random(), no DOM: fully
// deterministic given the same (state, event) pair, so it can be replayed
// against fixtures in tests.
//
// `event` is `{type, data}` as produced by sse.js's `onEvent(type, data)`
// (store.js is the piece that wraps the two into one object before
// dispatching). Unknown event types are a no-op (forward-compatible with
// new server-sent event types).

/** The shape a freshly-connected client should start from. */
export const initialState = Object.freeze({
  version: null,
  seq: -1,
  server_time: null,
  demo: false,
  iterm: { status: 'connecting', error: '', last_poll_at: null, poll_ms: null, stale: false },
  summary: { tabs: 0, agents: 0, waiting: 0, busy: 0, waiting_uids: [] },
  windows: [],
  sessions: [],
  screens: {},
  usage: { claude: null, codex: null },
  prefs: null,
  projects: [],
  capabilities: { tab_colors: null, reply: false, debug_rule: false },
  quota_prompt: null,
  stats: null,
  // Client-only bookkeeping, never present in server payloads:
  connectionStatus: 'connecting', // connecting | connected | reconnecting
  toasts: [],
  toastSeq: 0,
  lastTransition: null,
  lastAction: null,
  lastStall: null,
});

function applyScreens(state, data) {
  const screens = { ...state.screens, ...(data.screens || {}) };
  for (const uid of data.removed || []) {
    delete screens[uid];
  }
  return { ...state, seq: data.seq, screens };
}

function applyToast(state, data) {
  const id = state.toastSeq + 1;
  return {
    ...state,
    toastSeq: id,
    toasts: [...state.toasts, { id, level: data.level, message: data.message }],
  };
}

const HANDLERS = {
  hello(state, data) {
    return {
      ...state,
      version: data.version,
      server_time: data.server_time,
      demo: data.demo,
      connectionStatus: 'connected',
    };
  },
  state(state, data) {
    // Full State document (§4.4.1): replace every server-owned field,
    // preserve client-only bookkeeping (toasts, connectionStatus, ...).
    return { ...state, ...data, connectionStatus: 'connected' };
  },
  sessions(state, data) {
    return {
      ...state,
      seq: data.seq,
      sessions: data.sessions,
      summary: data.summary,
      windows: data.windows,
      iterm: data.iterm,
    };
  },
  screens: applyScreens,
  usage(state, data) {
    return { ...state, seq: data.seq, usage: data.usage };
  },
  prefs(state, data) {
    return { ...state, seq: data.seq, prefs: data.prefs, projects: data.projects };
  },
  transition(state, data) {
    return { ...state, lastTransition: data };
  },
  toast: applyToast,
  action(state, data) {
    return { ...state, lastAction: data };
  },
  quota(state, data) {
    return { ...state, quota_prompt: data };
  },
  // API.md §6: `{seq, stats}` — blocked-on-you totals (changes only on transitions).
  stats(state, data) {
    return { ...state, seq: data.seq !== undefined ? data.seq : state.seq, stats: data.stats || null };
  },
  // API.md §6: a busy session became stalled (the controller toasts it).
  stall(state, data) {
    return { ...state, lastStall: data };
  },
  // Local-only: the quota banner was acted on (draft/skip). The server has
  // no "quota cleared" event (§4.4.2), so the client clears it itself.
  quotaCleared(state) {
    return state.quota_prompt === null ? state : { ...state, quota_prompt: null };
  },
  capabilities(state, data) {
    return { ...state, capabilities: data };
  },
  // Local-only: connection lifecycle from sse.js (not a server event type,
  // but routed through the same dispatch so subscribers only need one hook).
  connection(state, data) {
    if (state.connectionStatus === data.status) return state;
    return { ...state, connectionStatus: data.status };
  },
};

/**
 * @param {object} state  current client state (start from `initialState`)
 * @param {{type: string, data: any}} event
 * @returns {object} next state (same reference if the event type is unknown/malformed)
 */
export function reduce(state, event) {
  if (!event || typeof event.type !== 'string') return state;
  const handler = HANDLERS[event.type];
  if (!handler) return state;
  return handler(state, event.data || {});
}

/**
 * Convenience wrapper for local-only connection-lifecycle changes (from
 * sse.js's onOpen/onReconnectScheduled), equivalent to
 * `reduce(state, {type: 'connection', data: {status}})`.
 */
export function setConnectionStatus(state, status) {
  return reduce(state, { type: 'connection', data: { status } });
}

/** Dismiss a toast by id (e.g. after its display timeout, or on user click). */
export function dismissToast(state, id) {
  const next = state.toasts.filter((t) => t.id !== id);
  if (next.length === state.toasts.length) return state;
  return { ...state, toasts: next };
}

export const EVENT_TYPES = Object.freeze(Object.keys(HANDLERS));
