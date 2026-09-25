import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  levelForPct, toneForLevel, resetParts, limitModel, providerMessage, providerVisible, usageModel, stripSummary,
} from '../../omniwatch/web/js/usage-model.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/state.json', import.meta.url), 'utf8'));
const NOW = fixture.server_time;
const claude = fixture.usage.claude;

test('usage level thresholds (P-19)', () => {
  assert.equal(levelForPct(49.9), 'green');
  assert.equal(levelForPct(50), 'yellow');
  assert.equal(levelForPct(79), 'yellow');
  assert.equal(levelForPct(80), 'red');
  assert.equal(levelForPct(undefined), 'green');
  assert.equal(toneForLevel('red'), 'danger');
  assert.equal(toneForLevel('yellow'), 'warn');
  assert.equal(toneForLevel('green'), 'ok');
});

test('reset countdown ticks from resets_at, falls back to reset_text (§2.4)', () => {
  const l = { resets_at: NOW + 2 * 3600 + 15 * 60 };
  const p = resetParts(l, NOW);
  assert.equal(p.rel, '2h 15m');
  assert.match(p.abs, / at /);
  assert.equal(resetParts({ resets_at: NOW + 3600 }, NOW + 1800).rel, '30m', 'recomputed against a later now');
  assert.deepEqual(resetParts({ reset_text: 'soon' }, NOW), { rel: 'soon', abs: '', text: 'soon' });
  assert.deepEqual(resetParts({}, NOW), { rel: '', abs: '', text: '' });
  assert.equal(resetParts({ reset_text: '2h (Today at 5pm)' }, NOW).abs, 'Today at 5pm');
});

test('limit card model: pct, tone, warning, dollars (P-18/P-20/P-69)', () => {
  const session = limitModel(claude.limits[0], { now: NOW, showDollars: false });
  assert.deepEqual([session.title, session.pctText, session.tone], ['Session · 5h', '62%', 'warn']);
  assert.deepEqual(session.warning, { kind: 'pace', text: 'On pace to hit session limit Today at 5:30pm', tone: 'warn' });
  assert.equal(session.dollars, null);
  assert.match(session.resetText, /^Resets in 2h 15m · /);
  const monthly = limitModel(claude.limits[2], { now: NOW, showDollars: false });
  assert.deepEqual([monthly.title, monthly.monthly, monthly.dollars], ['Monthly cap', true, { shown: false, text: '$ hidden · press $' }]);
  assert.equal(limitModel({ ...claude.limits[2], limit_display: '$200' }, { now: NOW, showDollars: true }).dollars.text, '$200');
  assert.equal(limitModel(claude.limits[2], { now: NOW, showDollars: true }).dollars, null, 'shown but no amount from the server');
  const hit = limitModel(fixture.usage.codex.limits[1], { now: NOW, showDollars: false });
  assert.deepEqual([hit.warning.kind, hit.warning.tone], ['hit', 'danger']);
  const odd = limitModel({ id: 'x', pct: 140, projection: { kind: 'pace', text: '' } }, { now: NOW });
  assert.deepEqual([odd.pct, odd.level, odd.label, odd.warning, odd.resetText, odd.title], [100, 'red', 'x', null, '', '']);
  assert.equal(limitModel({ id: 'claude.extra_usage', label: 'Extra Usage', pct: 1 }, { now: NOW }).monthly, true);
});

test('provider messages match P-51 / §2.9', () => {
  assert.equal(providerMessage('claude', { status: 'error' }, NOW).text, 'usage API fetch failed');
  assert.equal(providerMessage('codex', { status: 'error' }, NOW).text, 'Codex usage fetch failed');
  assert.equal(providerMessage('claude', { status: 'stale', fetched_at: NOW - 600 }, NOW).text, 'fetch failing — showing data from 10m ago');
  assert.equal(providerMessage('claude', { status: 'stale' }, NOW).text, 'fetch failing — showing data from ? ago');
  assert.equal(providerMessage('claude', { status: 'no_credentials' }, NOW).text, 'Sign in to Claude Code to see limits');
  assert.equal(providerMessage('codex', { status: 'no_credentials' }, NOW).text, 'Codex auth not found');
  assert.equal(providerMessage('claude', { status: 'ok' }, NOW), null);
  assert.equal(providerMessage('claude', null, NOW), null);
  assert.equal(providerVisible({ status: 'inactive' }), false);
  assert.equal(providerVisible(null), false);
});

test('usage model: providers, refreshed text, empty state (P-51)', () => {
  const m = usageModel(fixture.usage, { now: NOW, showDollars: false });
  assert.deepEqual(m.providers.map((p) => p.id), ['claude', 'codex']);
  assert.equal(m.refreshed, 'Refreshed 5m ago');
  assert.equal(m.providers[0].peak.pctText, '91%');
  assert.equal(m.empty, false);
  const none = usageModel({ claude: { status: 'inactive' }, codex: null }, { now: NOW });
  assert.deepEqual([none.empty, none.refreshed, none.emptyTitle], [true, '', 'No Claude Code or Codex sessions running']);
  assert.equal(usageModel(undefined, { now: NOW }).empty, true);
  const err = usageModel({ claude: { status: 'error', limits: [] } }, { now: NOW });
  assert.deepEqual([err.providers[0].peak, err.refreshed], [null, '']);
  assert.deepEqual(stripSummary(m).map((x) => [x.name, x.pctText]), [['Claude', '91%'], ['Codex', '84%']]);
  assert.deepEqual(stripSummary(err), []);
});
