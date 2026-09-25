import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  stateKey, stateLabel, agentLabel, agentLongName, filterHaystack, visibleSessions, gridSessions, listItems,
  effectiveView, nextView, resolveSelection, moveSelection, nextWaitingUid, clampSplit, stepSplit, clampFontScale,
  splitPath, tileName, sessionTitle, accessibleName, spokenDuration, rowTone, rowModel, projectForSession,
  colorDotTitle, statusChip, emptyState, summaryModel, plural, windowTitle, matchCountText, previewFooter,
  stateWithAge, visibleUids, nativeThemeValue, gridColumnCount, derive, indexOfUid,
} from '../../omniwatch/web/js/viewmodel.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/state.json', import.meta.url), 'utf8'));
const NOW = fixture.server_time;
const S = fixture.sessions;
const byLabel = (l) => S.find((s) => s.tab_label === l);

test('state and agent labels (P-27/P-28)', () => {
  assert.equal(stateLabel('waiting'), 'Waiting');
  assert.equal(stateLabel('active'), 'Output');
  assert.equal(stateLabel(null), 'Unknown');
  assert.equal(stateKey('bogus'), 'unknown');
  assert.equal(stateKey('unknown'), 'unknown');
  assert.equal(agentLabel('claude'), 'Claude');
  assert.equal(agentLabel('codex'), 'Codex');
  assert.equal(agentLabel(null), '');
  assert.equal(agentLongName('claude'), 'Claude Code');
  assert.equal(agentLongName('codex'), 'Codex');
  assert.equal(agentLongName(''), '');
});

test('filter matches "{path} {name} {label}" fuzzily (P-59)', () => {
  assert.equal(filterHaystack(byLabel('1.2')), `~/src/billing ${byLabel('1.2').name} refactor`);
  assert.equal(filterHaystack({}), '  ');
  const rows = visibleSessions(S, { filter: 'bill' });
  assert.deepEqual(rows.map((s) => s.tab_label), ['1.2']);
  assert.equal(visibleSessions(S, { filter: 'zzzz' }).length, 0);
  assert.equal(visibleSessions(S).length, S.length);
  assert.equal(visibleSessions(undefined).length, 0);
});

test('visibleSessions applies the sort (P-60)', () => {
  const rows = visibleSessions(S, { sort: 'attention' });
  assert.equal(rows[0].state, 'waiting');
  assert.equal(rows[1].state, 'waiting');
  // longest-waiting first
  assert.ok(rows[0].state_since <= rows[1].state_since);
});

test('grid: agents only, dashboards excluded, falls back to all; grid_all shows everything (P-45/P-50)', () => {
  const g = gridSessions(S, false);
  assert.ok(g.every((s) => s.agent && !s.is_dashboard));
  assert.equal(g.length, S.filter((s) => s.agent).length);
  const plain = S.filter((s) => !s.agent);
  assert.deepEqual(gridSessions(plain, false), plain);
  assert.equal(gridSessions(S, true).length, S.length);
  const dash = [{ uid: 'd', agent: 'claude', is_dashboard: true }];
  assert.deepEqual(gridSessions(dash, false), dash, 'only-dashboard list falls back to all');
});

test('window group headers only for natural sort with >1 window (P-35)', () => {
  const items = listItems(S, 'natural', fixture.windows);
  assert.equal(items.filter((i) => i.type === 'header').length, 2);
  assert.deepEqual(items[0], { type: 'header', key: 'w-104', number: 1, count: 4 });
  assert.equal(items[1].type, 'row');
  assert.equal(listItems(S, 'attention', fixture.windows).filter((i) => i.type === 'header').length, 0);
  const one = S.filter((s) => s.window_id === 104);
  assert.equal(listItems(one, 'natural', [{ id: 104, number: 1 }]).filter((i) => i.type === 'header').length, 0);
  // two windows in data but windows list missing → still grouped
  assert.equal(listItems(S, 'natural', null).filter((i) => i.type === 'header').length, 2);
  assert.deepEqual(listItems([], 'natural', fixture.windows), []);
});

test('effective view: compact ≤420, split falls back to list <900 (P-38)', () => {
  assert.equal(effectiveView('split', 1440), 'split');
  assert.equal(effectiveView('split', 899), 'list');
  assert.equal(effectiveView('split', 900), 'split');
  assert.equal(effectiveView('grid', 700), 'grid');
  assert.equal(effectiveView('grid', 420), 'compact');
  assert.equal(effectiveView('bogus', 1200), 'split');
  assert.equal(effectiveView('list'), 'list');
});

test('view cycle split → list → grid (P-37)', () => {
  assert.equal(nextView('split'), 'list');
  assert.equal(nextView('list'), 'grid');
  assert.equal(nextView('grid'), 'split');
  assert.equal(nextView('???'), 'split');
});

test('selection follows uid and snaps to the first row (P-55)', () => {
  assert.equal(resolveSelection([], 'x'), null);
  assert.equal(resolveSelection(S, S[3].uid), S[3].uid);
  assert.equal(resolveSelection(S, 'gone'), S[0].uid);
  assert.equal(resolveSelection(S, null), S[0].uid);
  assert.equal(indexOfUid(S, S[2].uid), 2);
});

test('moveSelection clamps at both ends and handles ±columns (P-46)', () => {
  assert.equal(moveSelection(S, S[0].uid, -1), S[0].uid);
  assert.equal(moveSelection(S, S[0].uid, 1), S[1].uid);
  assert.equal(moveSelection(S, S[1].uid, 3), S[4].uid);
  assert.equal(moveSelection(S, S[5].uid, 10), S[S.length - 1].uid);
  assert.equal(moveSelection(S, 'gone', 1), S[1].uid);
  assert.equal(moveSelection([], 'x', 1), null);
});

test('next waiting cycles longest-waiting first (P-58)', () => {
  const waiting = S.filter((s) => s.state === 'waiting').sort((a, b) => a.state_since - b.state_since);
  const first = nextWaitingUid(S, null);
  assert.equal(first, waiting[0].uid);
  assert.equal(nextWaitingUid(S, first), waiting[1].uid);
  assert.equal(nextWaitingUid(S, waiting[1].uid), waiting[0].uid);
  assert.equal(nextWaitingUid(S.filter((s) => s.state !== 'waiting'), null), null);
  assert.equal(nextWaitingUid(undefined, null), null);
  assert.equal(nextWaitingUid([{ uid: 'a', state: 'waiting' }, { uid: 'b', state: 'waiting', state_since: 5 }], 'zzz'), 'a');
});

test('split ratio clamps to 0.2–0.8 in 0.05 steps (P-38)', () => {
  assert.equal(clampSplit(0.9), 0.8);
  assert.equal(clampSplit(0.1), 0.2);
  assert.equal(clampSplit(NaN), 0.42);
  assert.equal(stepSplit(0.42, 1), 0.47);
  assert.equal(stepSplit(0.8, 1), 0.8);
  assert.equal(stepSplit(undefined, -1), 0.37);
});

test('font scale clamps to 0.8–1.6', () => {
  assert.equal(clampFontScale(2), 1.6);
  assert.equal(clampFontScale(0.1), 0.8);
  assert.equal(clampFontScale(1.1000001), 1.1);
  assert.equal(clampFontScale(undefined), 1);
});

test('splitPath keeps the basename for middle truncation', () => {
  assert.deepEqual(splitPath('~/src/api-gateway'), { head: '~/src/', tail: 'api-gateway' });
  assert.deepEqual(splitPath('~'), { head: '', tail: '~' });
  assert.deepEqual(splitPath(''), { head: '', tail: '' });
  assert.deepEqual(splitPath(undefined), { head: '', tail: '' });
  assert.deepEqual(splitPath('/'), { head: '', tail: '/' });
  assert.deepEqual(splitPath('~/src/site/'), { head: '~/src/', tail: 'site' });
});

test('tile name and toast title (P-24/P-45)', () => {
  assert.equal(tileName(byLabel('1.2')), 'refactor');
  assert.equal(tileName(byLabel('1.1')), 'api-gateway');
  assert.equal(tileName({ uid: 'ABCDEFGHIJ', path_display: '', name: '' }), 'ABCDEFGH');
  assert.equal(tileName({ uid: 'x', name: 'zsh' }), 'zsh');
  assert.equal(tileName({ uid: 'x', path_display: '~' }), '~');
  assert.equal(sessionTitle(byLabel('1.2')), 'refactor');
  assert.equal(sessionTitle(null), '');
  assert.equal(sessionTitle({ uid: 'x', label: 'l' }), 'l');
  assert.equal(sessionTitle({ uid: 'x', path_display: '~/a/b' }), 'b');
});

test('accessible names describe state, agent, tab, path, label (§2.7)', () => {
  const s = byLabel('1.2');
  const name = accessibleName(s, NOW);
  assert.match(name, /^Waiting 3 minutes, Claude Code, tab 1\.2, ~\/src\/billing, label refactor, tab color blue$/);
  const idle = { ...byLabel('1.4'), last_change: NOW - 7200 };
  assert.match(accessibleName(idle, NOW), /^Idle 2 hours, Codex, tab 1\.4/);
  const busy = byLabel('1.1');
  assert.match(accessibleName(busy, NOW), /^Busy, Claude Code, tab 1\.1, ~\/src\/api-gateway, ✨ Fix flaky test$/);
  assert.match(accessibleName({ ...busy, muted: true }, NOW), /^Busy, muted, /);
  assert.equal(accessibleName({ state: null }, NOW), 'Unknown');
});

test('spokenDuration pluralizes', () => {
  assert.equal(spokenDuration(1), '1 second');
  assert.equal(spokenDuration(59), '59 seconds');
  assert.equal(spokenDuration(60), '1 minute');
  assert.equal(spokenDuration(3600), '1 hour');
  assert.equal(spokenDuration(86400 * 2), '2 days');
  assert.equal(spokenDuration(-5), '0 seconds');
});

test('row tone: waiting amber wins over fresh green (P-29)', () => {
  assert.equal(rowTone({ state: 'waiting', fresh_until: NOW + 10 }, NOW), 'waiting');
  assert.equal(rowTone({ state: 'idle', fresh_until: NOW + 10 }, NOW), 'fresh');
  assert.equal(rowTone({ state: 'busy', fresh_until: NOW + 10 }, NOW), '');
  assert.equal(rowTone({ state: 'idle', fresh_until: NOW - 1 }, NOW), '');
});

test('rowModel carries everything a row renders', () => {
  const m = rowModel(byLabel('1.2'), NOW, fixture.projects);
  assert.equal(m.state, 'waiting');
  assert.equal(m.agentLabel, 'Claude');
  assert.equal(m.age, 'wait 3m');
  assert.equal(m.tone, 'waiting');
  assert.equal(m.projectName, 'api');
  assert.equal(m.projectSlot, 1);
  assert.deepEqual(m.path, { head: '~/src/', tail: 'billing' });
  const plain = rowModel({ uid: 'u', state: 'quiet' }, NOW, []);
  assert.equal(plain.agent, '');
  assert.equal(plain.projectName, '');
  assert.equal(plain.projectSlot, null);
  assert.equal(plain.displayName, '');
});

test('projectForSession uses project slot then tab color (§4.4.1)', () => {
  assert.equal(projectForSession({ project: 2 }, fixture.projects).name, 'billing');
  assert.equal(projectForSession({ project: 9, tab_color: 'blue' }, fixture.projects).name, 'api');
  assert.equal(projectForSession({ tab_color: 'orange' }, fixture.projects), null);
  assert.equal(projectForSession({}, null), null);
  assert.equal(colorDotTitle({ tab_color: 'blue' }, fixture.projects), 'Tab color blue · project api');
  assert.equal(colorDotTitle({ tab_color: 'green' }, fixture.projects), 'Tab color green');
  assert.equal(colorDotTitle({}, fixture.projects), '');
});

test('status chip (P-26, §2.9)', () => {
  assert.equal(statusChip(null, NOW), null);
  assert.equal(statusChip(fixture.iterm, NOW), null);
  assert.equal(statusChip({ status: 'not_running' }, NOW).text, 'Not running');
  assert.equal(statusChip({ status: 'not_authorized' }, NOW).text, 'No permission');
  const err = statusChip({ status: 'error', error: 'boom' }, NOW);
  assert.deepEqual([err.text, err.title], ['Error', 'boom']);
  assert.equal(statusChip({ status: 'error' }, NOW).title, 'iTerm2 query failed');
  assert.equal(statusChip({}, NOW).text, 'Connecting…');
  const stale = statusChip({ status: 'ok', stale: true, last_poll_at: NOW - 12 }, NOW);
  assert.deepEqual([stale.kind, stale.text], ['warn', 'Stale · 12s']);
  assert.equal(statusChip({ status: 'ok', stale: true }, NOW).text, 'Stale');
  assert.equal(statusChip({ status: 'ok', stale: true, error: 'e' }, NOW).title, 'e');
  // An old last_poll_at alone is not "stale" (only the backend knows, see viewmodel.js).
  assert.equal(statusChip({ status: 'ok', stale: false, last_poll_at: NOW - 600 }, NOW), null);
});

test('empty states (§2.9, P-54)', () => {
  const base = { iterm: { status: 'ok' }, sessions: S, rows: S, filter: '', view: 'split', connection: 'connected' };
  assert.equal(emptyState(base), null);
  assert.equal(emptyState({ ...base, iterm: { status: 'not_running' }, sessions: [], rows: [] }).kind, 'not_running');
  const na = emptyState({ ...base, iterm: { status: 'not_authorized' } });
  assert.equal(na.kind, 'not_authorized');
  assert.deepEqual(na.actions.map((a) => a.id), ['automation.open', 'automation.probe']);
  assert.equal(emptyState({ ...base, iterm: { status: 'error', error: 'x' }, sessions: [], rows: [] }).body, 'x');
  assert.equal(emptyState({ ...base, iterm: { status: 'error' }, sessions: [], rows: [] }).body, 'The last query to iTerm2 failed.');
  assert.equal(emptyState({ ...base, iterm: { status: 'error' } }), null, 'stale data stays visible');
  assert.equal(emptyState({ ...base, iterm: null, sessions: [], rows: [] }).kind, 'connecting');
  assert.equal(emptyState({ ...base, sessions: [], rows: [], connection: 'connecting' }).kind, 'connecting');
  assert.equal(emptyState({ ...base, sessions: [], rows: [] }).kind, 'no_sessions');
  assert.equal(emptyState({ ...base, sessions: undefined, rows: [] }).kind, 'no_sessions');
  const nm = emptyState({ ...base, rows: [], filter: 'foo' });
  assert.deepEqual([nm.kind, nm.title], ['no_match', 'No sessions match “foo”']);
  assert.equal(emptyState({ ...base, rows: [], view: 'grid' }).title, 'No agent sessions — press A to show all');
  assert.equal(emptyState({ ...base, rows: [], view: 'list' }), null);
});

test('summary, title and match count (P-25, P-59)', () => {
  assert.deepEqual(summaryModel(fixture.summary), { waiting: 2, stalled: 0, tabs: 7, agents: 4, busy: 1, text: '7 tabs · 4 agents' });
  assert.equal(summaryModel({ stalled: 2 }).stalled, 2);
  assert.equal(summaryModel(undefined).text, '0 tabs · 0 agents');
  assert.equal(summaryModel({ tabs: 1, agents: 1 }).text, '1 tab · 1 agent');
  assert.equal(plural(2, 'x'), '2 xs');
  assert.equal(windowTitle(0), 'Omniwatch');
  assert.equal(windowTitle(2), 'Omniwatch — 2 waiting');
  assert.equal(matchCountText('', 1, 2), '');
  assert.equal(matchCountText('a', 1, 2), '1 of 2');
});

test('preview footer freshness and debug rule (P-41, P-43)', () => {
  const s = { rule: 'menu-option' };
  assert.deepEqual(previewFooter({ last_poll_at: NOW - 1 }, s, NOW, false), { fresh: 'live · updated just now', rule: '', live: true });
  assert.deepEqual(previewFooter({ last_poll_at: NOW - 12 }, s, NOW, true), { fresh: 'updated 12s ago', rule: 'rule: menu-option', live: false });
  assert.deepEqual(previewFooter(null, null, NOW, true), { fresh: '', rule: '', live: false });
});

test('preview header state text (P-40)', () => {
  assert.equal(stateWithAge(byLabel('1.2'), NOW), 'Waiting 3m');
  assert.equal(stateWithAge({ state: 'idle', state_since: 1, last_change: NOW - 3600 }, NOW), 'Idle 1h');
  assert.equal(stateWithAge({ state: 'idle', state_since: 1, last_change: NOW - 5 }, NOW), 'Idle');
  assert.equal(stateWithAge({ state: 'busy', state_since: 1 }, NOW), 'Busy');
  assert.equal(stateWithAge({ state: 'waiting' }, NOW), 'Waiting');
});

test('visible uids for native notification suppression (SHELL_CONTRACT §6)', () => {
  assert.deepEqual(visibleUids({ view: 'split', selectedUid: 'a', overlay: null }), ['a']);
  assert.deepEqual(visibleUids({ view: 'split', selectedUid: null, overlay: null }), []);
  assert.deepEqual(visibleUids({ view: 'grid', selectedUid: 'a', gridUids: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(visibleUids({ view: 'grid', selectedUid: 'a' }), []);
  assert.deepEqual(visibleUids({ view: 'grid', selectedUid: 'a', overlay: 'zoom' }), ['a']);
  assert.deepEqual(visibleUids({ view: 'grid', selectedUid: null, overlay: 'zoom' }), []);
  assert.deepEqual(visibleUids({ view: 'split', selectedUid: 'a', overlay: 'usage' }), []);
  assert.deepEqual(visibleUids({ view: 'split', selectedUid: 'a', windowFocused: false }), []);
});

test('theme value posted to native', () => {
  assert.equal(nativeThemeValue('dark'), 'dark');
  assert.equal(nativeThemeValue('light'), 'light');
  assert.equal(nativeThemeValue('high-contrast'), 'dark');
  assert.equal(nativeThemeValue('system'), 'system');
  assert.equal(nativeThemeValue(undefined), 'system');
});

test('grid column count from computed grid-template-columns (P-46)', () => {
  assert.equal(gridColumnCount('340px 340px 340px'), 3);
  assert.equal(gridColumnCount('none'), 1);
  assert.equal(gridColumnCount(''), 1);
  assert.equal(gridColumnCount(' 500px '), 1);
});

test('derive(): layout, rows, grid subset and selection agree', () => {
  const server = { ...fixture, prefs: { ...fixture.prefs, view: 'grid', sort: 'attention' } };
  const d = derive(server, { filter: '', selectedUid: byLabel('1.3').uid }, 1400);
  assert.equal(d.view, 'grid');
  assert.equal(d.sort, 'attention');
  assert.ok(d.active.every((s) => s.agent));
  assert.equal(d.selectedUid, d.active[0].uid, 'a non-agent selection snaps to the first tile');
  assert.equal(d.selected.uid, d.selectedUid);
  const d2 = derive({ sessions: [], prefs: null }, { filter: '', selectedUid: null }, 1400);
  assert.deepEqual([d2.view, d2.sort, d2.selected], ['split', 'natural', null]);
  const d3 = derive({ ...fixture }, { filter: 'bill', selectedUid: null }, 1400);
  assert.equal(d3.selected.tab_label, '1.2');
});
