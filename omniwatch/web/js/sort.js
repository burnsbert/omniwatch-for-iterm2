// sort.js — session sort orders, ported verbatim from Ultrawatch's
// `ultrawatch_lib/ui/app.py:build_rows` (P-60). Operates on the **Session**
// JSON shape from DESIGN.md §4.4.1 (not the Python Row dataclass), field
// mapping:
//   r.s.window_id/tab_index/session_index -> session.window_id/tab_index/session_index
//   r.state / r.since                     -> session.state / session.state_since
//   r.kind (truthy agent string or None)   -> session.agent (string or null)
//   r.last_change                         -> session.last_change
//   r.path (shortened, '' -> '~')          -> session.path_display || '~'
//
// `Array.prototype.sort` is a stable sort as of ES2019 (Node 20/all
// evergreen browsers), matching Python's stable `list.sort`.

export const SORT_CYCLE = Object.freeze(['natural', 'attention', 'agents', 'activity', 'path']);

// waiting < busy < active < idle < quiet < unknown (P-60).
const STATE_RANK = { waiting: 0, busy: 1, active: 2, idle: 3, quiet: 4 };

function stateRank(state) {
  return Object.prototype.hasOwnProperty.call(STATE_RANK, state) ? STATE_RANK[state] : 5;
}

function naturalTuple(s) {
  return [s.window_id, s.tab_index, s.session_index];
}

function compareValues(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareTuples(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    const c = compareValues(a[i], b[i]);
    if (c !== 0) return c;
  }
  return 0;
}

function hasAgent(session) {
  if (session.agent) return true;
  return Array.isArray(session.agents) && session.agents.length > 0;
}

const COMPARATORS = {
  natural: (a, b) => compareTuples(naturalTuple(a), naturalTuple(b)),

  attention: (a, b) => compareTuples(
    [
      stateRank(a.state),
      a.state === 'waiting' ? (a.state_since || 0) : 0,
      ...naturalTuple(a),
    ],
    [
      stateRank(b.state),
      b.state === 'waiting' ? (b.state_since || 0) : 0,
      ...naturalTuple(b),
    ],
  ),

  agents: (a, b) => compareTuples(
    [hasAgent(a) ? 0 : 1, ...naturalTuple(a)],
    [hasAgent(b) ? 0 : 1, ...naturalTuple(b)],
  ),

  activity: (a, b) => compareTuples(
    [-(a.last_change || 0), ...naturalTuple(a)],
    [-(b.last_change || 0), ...naturalTuple(b)],
  ),

  path: (a, b) => compareTuples(
    [a.path_display || '~', ...naturalTuple(a)],
    [b.path_display || '~', ...naturalTuple(b)],
  ),
};

/**
 * @param {object[]} sessions  Session JSON objects (§4.4.1)
 * @param {string} sortName    one of SORT_CYCLE
 * @returns {object[]} a new, sorted array (input is not mutated)
 */
export function sortSessions(sessions, sortName) {
  const cmp = COMPARATORS[sortName] || COMPARATORS.natural;
  return [...sessions].sort(cmp);
}

/** `s` key: cycle natural -> attention -> agents -> activity -> path -> natural (P-60). */
export function nextSort(current) {
  const idx = SORT_CYCLE.indexOf(current);
  return SORT_CYCLE[(idx + 1) % SORT_CYCLE.length];
}

export const comparators = COMPARATORS;
