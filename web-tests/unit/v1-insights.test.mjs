// Pure-module tests for the v1 insight features (T017), driven by payloads
// captured from the real demo backend (fixtures/real-v1.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CODE_STATE, clockTime, duration, ribbonModel, ribbonShares, ribbonSummary, historyModel, waitingHistogram,
} from '../../omniwatch/web/js/activity.js';
import { statsModel, blockedText } from '../../omniwatch/web/js/stats-model.js';
import { sparkGeometry, windowPoints } from '../../omniwatch/web/js/sparkline.js';
import { burnModel, limitModel } from '../../omniwatch/web/js/usage-model.js';
import { stalledText, rowModel, accessibleName, summaryModel } from '../../omniwatch/web/js/viewmodel.js';
import { sortSessions } from '../../omniwatch/web/js/sort.js';
import { reduce, initialState } from '../../omniwatch/web/js/reducer.js';
import { reduceUi, initialUi } from '../../omniwatch/web/js/uistate.js';

const real = JSON.parse(readFileSync(new URL('../fixtures/real-v1.json', import.meta.url), 'utf8'));
const ST = real.state;
const NOW = ST.server_time;

test('duration and clock formatting', () => {
  assert.equal(duration(40), '40s');
  assert.equal(duration(12 * 60), '12m');
  assert.equal(duration(3600), '1h');
  assert.equal(duration(3900), '1h 5m');
  assert.equal(duration(-3), '0s');
  assert.match(clockTime(NOW), /^\d{1,2}:\d{2}(am|pm)$/);
  const midnight = new Date(2026, 8, 25, 0, 5).getTime() / 1000;
  assert.equal(clockTime(midnight), '12:05am');
  assert.equal(clockTime(new Date(2026, 8, 25, 13, 0).getTime() / 1000), '1:00pm');
  assert.equal(CODE_STATE.w, 'waiting');
});

test('ribbon model: 48 buckets aligned to end, titles, summary (API.md §5 ribbon)', () => {
  const s = ST.sessions[0];
  const m = ribbonModel(s.ribbon);
  assert.equal(m.buckets.length, 48);
  assert.equal(m.end, s.ribbon.end);
  assert.equal(m.start, s.ribbon.end - 48 * 600);
  assert.equal(m.buckets[47].end, s.ribbon.end);
  assert.equal(m.buckets[0].start, m.start);
  assert.equal(m.buckets[47].code, s.ribbon.codes.at(-1));
  assert.match(m.buckets[0].title, / · (Idle|Busy|Waiting|Output|Quiet|No data)$/);
  assert.ok(m.key.endsWith(s.ribbon.codes));
  const shares = ribbonShares(m);
  assert.ok(Math.abs(Object.values(shares).reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.match(ribbonSummary(m), /^Last 8 hours: busy \d+%/);
  assert.equal(ribbonModel(null), null);
  assert.equal(ribbonModel({ codes: '' }), null);
  assert.equal(ribbonSummary(null), 'No activity recorded yet');
  assert.deepEqual(ribbonShares(null), {});
  const odd = ribbonModel({ end: 6000, codes: 'x-' });
  assert.deepEqual(odd.buckets.map((b) => [b.code, b.state]), [['-', 'none'], ['-', 'none']]);
  assert.equal(odd.buckets[1].start, 6000 - 600, 'bucket_s defaults to 600');
  assert.equal(ribbonSummary(odd), 'Last 0 hours: no data');
});

test('history model: positioned segments, ongoing tail, ticks, totals (API.md §5 History)', () => {
  const m = historyModel(real.history, NOW);
  assert.equal(m.segments.length, real.history.segments.length);
  assert.ok(m.segments.every((g) => g.left >= 0 && g.left <= 100 && g.width > 0));
  const sum = m.segments.reduce((a, g) => a + g.width, 0);
  assert.ok(sum > 99 && sum < 100.5, `segments cover the window (${sum})`);
  assert.equal(m.segments.at(-1).ongoing, true);
  assert.match(m.segments.at(-1).title, /–now · /);
  assert.equal(m.totals[0].seconds, Math.max(...Object.values(real.history.totals)), 'totals sorted, largest first');
  assert.ok(m.ticks.length >= 7 && m.ticks.every((t) => t.left >= 0 && t.left <= 100));
  assert.equal(m.transitions, real.history.transitions);
  assert.equal(historyModel(null, NOW), null);
  const tiny = historyModel({ from: 0, to: 3600, segments: [{ state: null, start: 0, end: 50 }, { state: 'busy', start: 50, end: 50 }], totals: { unknown: 50, busy: 0 } }, 3600);
  assert.deepEqual(tiny.segments.map((g) => g.state), ['unknown'], 'zero-width segments dropped');
  assert.deepEqual(tiny.totals.map((t) => t.label), ['Unknown']);
  assert.equal(tiny.hours, 1, 'hours from the span when missing');
  assert.equal(tiny.transitions, 0);
});

test('waiting histogram counts waiting agents per bucket across ribbons', () => {
  const m = waitingHistogram(ST.sessions);
  assert.equal(m.bars.length, 48);
  const expected = ST.sessions.filter((s) => s.agent && s.ribbon && s.ribbon.codes.at(-1) === 'w').length;
  assert.equal(m.bars[47].count, expected);
  assert.ok(m.max >= 1 && m.bars.every((b) => b.height >= 0 && b.height <= 1));
  assert.match(m.bars[0].title, / · \d+ waiting$/);
  assert.equal(waitingHistogram([]), null);
  assert.equal(waitingHistogram(undefined), null);
  const shifted = waitingHistogram([
    { agent: 'claude', ribbon: { end: 1200, bucket_s: 600, codes: 'ww' } },
    { agent: 'codex', ribbon: { end: 600, bucket_s: 600, codes: 'w' } },
  ]);
  assert.deepEqual(shifted.bars.map((b) => b.count), [2, 1], 'older ribbons are aligned to the newest end');
});

test('blocked-on-you: live total adds open waits; chip and card text (API.md §5 Stats)', () => {
  const m = statsModel(ST.stats, NOW, ST.sessions);
  const live = ST.stats.active.reduce((a, x) => a + (NOW - x.since), 0);
  assert.equal(Math.round(m.totalSeconds), Math.round(ST.stats.waiting_seconds + live));
  assert.equal(m.waitingNow, ST.stats.active.length);
  assert.equal(m.answered, ST.stats.answered);
  assert.equal(m.waits, ST.stats.waits);
  assert.equal(m.answerRate, Math.round((ST.stats.answered / ST.stats.waits) * 100));
  assert.ok(m.longestSeconds >= ST.stats.longest_wait_s);
  assert.match(m.chipText, /^\d+ min blocked$/);
  assert.match(m.summary, new RegExp(`blocked today · longest \\d+m · ${ST.stats.answered} answered$`));
  assert.equal(m.active[0].title, ST.sessions.find((s) => s.uid === ST.stats.active[0].uid).title);
  const later = statsModel(ST.stats, NOW + 600, ST.sessions);
  assert.ok(later.totalSeconds - m.totalSeconds >= 600 * ST.stats.active.length - 1, 'ticks with the clock');
  assert.equal(statsModel(null, NOW), null);
  const empty = statsModel({ day: 'd' }, NOW);
  assert.deepEqual([empty.totalText, empty.answerRate, empty.averageSeconds, empty.waitingNow], ['0 min', null, 0, 0]);
  const unknownUid = statsModel({ active: [{ uid: 'gone', since: NOW - 60 }] }, NOW);
  assert.deepEqual([unknownUid.active[0].title, unknownUid.active[0].agent], ['gone', null]);
  assert.equal(blockedText(99 * 60), '99 min');
  assert.equal(blockedText(100 * 60), '1h 40m');
});

test('sparkline geometry', () => {
  const pts = real.usage_history.limits['claude.five_hour'].points;
  const g = sparkGeometry(pts, { width: 120, height: 30 });
  assert.match(g.line, /^M[\d.]+ [\d.]+( L[\d.]+ [\d.]+)+$/);
  assert.ok(g.area.endsWith('Z'));
  assert.equal(g.last.pct, pts.at(-1)[1]);
  assert.ok(g.last.x <= 120 && g.last.y >= 0 && g.last.y <= 30);
  assert.equal(sparkGeometry([[1, 2]], { width: 10, height: 10 }), null);
  assert.equal(sparkGeometry(null, { width: 10, height: 10 }), null);
  const over = sparkGeometry([[0, 50], [10, 150]], { width: 10, height: 10, from: 0, to: 10, pad: 0 });
  assert.equal(over.last.y, 0, 'values over 100 scale the top');
  assert.deepEqual(windowPoints([[1, 1], [5, 2], [9, 3]], 4, 8), [[5, 2]]);
  assert.deepEqual(windowPoints(null, 0, 1), []);
});

test('burn rate model (API.md §5 Burn)', () => {
  const lims = ST.usage.claude.limits;
  const five = burnModel(lims.find((l) => l.id === 'claude.five_hour').burn);
  assert.match(five.text, /^At this rate: 100% /);
  assert.equal(five.tone, 'danger');
  assert.match(five.rate, /^\+\d+(\.\d)?%\/h$/);
  const sonnet = burnModel(lims.find((l) => l.id === 'claude.seven_day_sonnet').burn);
  assert.equal(sonnet.tone, 'muted');
  assert.match(sonnet.text, /^At this rate: ~\d+% at reset$/);
  assert.equal(burnModel({ text: 'limit hit' }).tone, 'danger');
  assert.deepEqual([burnModel({ text: 'not rising', rate_per_hour: 0 }).tone, burnModel({ text: 'not rising', rate_per_hour: 0 }).rate], ['muted', '']);
  assert.equal(burnModel({ text: 'x', at_reset_pct: 85 }).tone, 'warn');
  assert.equal(burnModel({ text: 'x', rate_per_hour: 0.73 }).rate, '+0.7%/h');
  assert.equal(burnModel(null), null);
  assert.equal(burnModel({ text: '' }), null);
  assert.equal(limitModel(lims[0], { now: NOW }).burn.tone, 'danger');
});

test('stalled chip text, row model, accessible name, summary (API.md §5 stalled)', () => {
  const s = ST.sessions.find((x) => x.stalled);
  assert.match(stalledText(s, NOW), /^Stalled\? \d+m$/);
  assert.equal(stalledText({ stalled: true }, NOW), 'Stalled?');
  assert.equal(stalledText({ stalled: false }, NOW), '');
  assert.equal(stalledText(null, NOW), '');
  const m = rowModel(s, NOW, ST.projects);
  assert.deepEqual([m.stalled, m.ribbon, !!m.stalledText], [true, s.ribbon, true]);
  assert.match(accessibleName(s, NOW), /^Busy, possibly stalled for \d+ minutes, Codex/);
  assert.match(accessibleName({ state: 'busy', stalled: true }, NOW), /^Busy, possibly stalled$/);
  assert.equal(summaryModel(ST.summary).stalled, ST.summary.stalled);
});

test('attention sort: stalled agents lead the busy tier, longest-stalled first', () => {
  const base = { window_id: 1, session_index: 1 };
  const rows = [
    { ...base, uid: 'b1', tab_index: 1, state: 'busy' },
    { ...base, uid: 's2', tab_index: 2, state: 'busy', stalled: true, stalled_since: 200 },
    { ...base, uid: 'w3', tab_index: 3, state: 'waiting', state_since: 5 },
    { ...base, uid: 's4', tab_index: 4, state: 'busy', stalled: true, stalled_since: 100 },
    { ...base, uid: 'i5', tab_index: 5, state: 'idle', stalled: true },
  ];
  assert.deepEqual(sortSessions(rows, 'attention').map((r) => r.uid), ['w3', 's4', 's2', 'b1', 'i5']);
  assert.deepEqual(sortSessions(rows, 'natural').map((r) => r.uid), ['b1', 's2', 'w3', 's4', 'i5'], 'other sorts unchanged');
});

test('reducer: stats and stall events (API.md §6)', () => {
  let st = reduce(initialState, { type: 'state', data: ST });
  assert.equal(st.stats.waits, ST.stats.waits);
  st = reduce(st, { type: 'stats', data: { seq: 99, stats: { ...ST.stats, waits: 42 } } });
  assert.deepEqual([st.stats.waits, st.seq], [42, 99]);
  st = reduce(st, { type: 'stats', data: {} });
  assert.deepEqual([st.stats, st.seq], [null, 99]);
  st = reduce(st, { type: 'stall', data: { uid: 'x', minutes: 10 } });
  assert.equal(st.lastStall.uid, 'x');
});

test('ui state: native settings, histories', () => {
  let ui = reduceUi(initialUi, { type: 'setNativeSettings', settings: { launchAtLogin: true, menuBarOnly: false } });
  assert.equal(ui.nativeSettings.launchAtLogin, true);
  ui = reduceUi(ui, { type: 'setHistory', uid: 'u', data: { a: 1 }, at: 5 });
  assert.deepEqual(ui.history, { uid: 'u', data: { a: 1 }, at: 5 });
  ui = reduceUi(ui, { type: 'setUsageHistory', data: { b: 2 }, at: 6 });
  assert.deepEqual(ui.usageHistory, { data: { b: 2 }, at: 6 });
});
