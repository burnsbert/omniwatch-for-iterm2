import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sortSessions, nextSort, SORT_CYCLE } from '../../omniwatch/web/js/sort.js';

const fixture = JSON.parse(readFileSync(
  fileURLToPath(new URL('../fixtures/state.json', import.meta.url)),
  'utf8',
));
const sessions = fixture.sessions;

// Fixture sessions, in the order they appear in state.json (also natural
// order, by construction): [0] AAAA0001 busy/claude, [1] AAAA0002
// waiting/claude, [2] AAAA0003 quiet/no-agent, [3] AAAA0004 idle/codex,
// [4] BBBB0001 waiting/codex, [5] BBBB0002 active/no-agent,
// [6] BBBB0003 quiet/no-agent (muted dev-server tab).

function uidsOf(list) {
  return list.map((s) => s.uid);
}

function byIndices(indices) {
  return indices.map((i) => sessions[i].uid);
}

// Golden orders below are hand-derived from
// ultrawatch_lib/ui/app.py:build_rows (P-60) against the fixture (see the
// task receipt for the by-hand derivation of each). DESIGN.md §5 calls for
// a "Python-generated golden file" via scripts/golden_sort.py; that script
// and the omniwatch/ Python port it depends on don't exist yet in this
// repo (WP1 hasn't landed), so this is a documented stand-in — swap in the
// real generated fixture once WP1/scripts/golden_sort.py exist.

test('SORT_CYCLE matches Ultrawatch\'s cycle order exactly (P-60)', () => {
  assert.deepEqual(SORT_CYCLE, ['natural', 'attention', 'agents', 'activity', 'path']);
});

test('nextSort() cycles natural -> attention -> agents -> activity -> path -> natural', () => {
  const order = [];
  let s = 'natural';
  for (let i = 0; i < SORT_CYCLE.length + 1; i += 1) {
    order.push(s);
    s = nextSort(s);
  }
  assert.deepEqual(order, ['natural', 'attention', 'agents', 'activity', 'path', 'natural']);
});

test('natural: (window_id, tab_index, session_index) ascending', () => {
  assert.deepEqual(uidsOf(sortSessions(sessions, 'natural')), byIndices([0, 1, 2, 3, 4, 5, 6]));
});

test('attention: waiting (longest-waiting first) < busy < active < idle < quiet < unknown, ties natural', () => {
  assert.deepEqual(uidsOf(sortSessions(sessions, 'attention')), byIndices([4, 1, 0, 5, 3, 2, 6]));
});

test('agents: sessions with an agent first, ties natural', () => {
  assert.deepEqual(uidsOf(sortSessions(sessions, 'agents')), byIndices([0, 1, 3, 4, 2, 5, 6]));
});

test('activity: latest last_change first, ties natural', () => {
  assert.deepEqual(uidsOf(sortSessions(sessions, 'activity')), byIndices([5, 0, 1, 4, 3, 2, 6]));
});

test('path: alphabetical by path_display (blank as "~", which sorts before any "~/..."), ties natural', () => {
  assert.deepEqual(uidsOf(sortSessions(sessions, 'path')), byIndices([3, 0, 1, 2, 4, 5, 6]));
});

test('an unrecognized sort name falls back to natural order', () => {
  assert.deepEqual(
    uidsOf(sortSessions(sessions, 'bogus')),
    uidsOf(sortSessions(sessions, 'natural')),
  );
});

test('sortSessions() does not mutate the input array', () => {
  const copy = [...sessions];
  sortSessions(sessions, 'path');
  assert.deepEqual(sessions, copy);
});

test('attention: an explicit null state ranks last ("unknown"), below quiet', () => {
  const withUnknown = [
    { ...sessions[6], state: null, window_id: 1, tab_index: 1, session_index: 1 },
    { ...sessions[2], window_id: 1, tab_index: 2, session_index: 1 }, // quiet
  ];
  const sorted = sortSessions(withUnknown, 'attention');
  assert.equal(sorted[0].state, 'quiet');
  assert.equal(sorted[1].state, null);
});
