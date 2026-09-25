import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { paletteItems, paletteResults, highlightSegments, moveCursor, EXTRA_ACTIONS, MAX_RESULTS } from '../../omniwatch/web/js/palette.js';
import { replyModel } from '../../omniwatch/web/js/reply.js';
import { shortcutSections, dedupeKeys, hintsFor } from '../../omniwatch/web/js/shortcuts.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/state.json', import.meta.url), 'utf8'));
const NOW = fixture.server_time;

test('palette lists waiting sessions first, then commands, then other sessions (§2.5)', () => {
  const items = paletteItems({ sessions: fixture.sessions, projects: fixture.projects, now: NOW });
  assert.equal(items[0].kind, 'session');
  assert.match(items[0].title, /^Go to ~\/src\/site/, 'longest waiting first');
  assert.match(items[0].subtitle, /^Waiting \d+m · Codex · tab 2\.1$/);
  assert.equal(items[1].kind, 'session');
  assert.equal(items[2].kind, 'command');
  assert.equal(items[items.length - 1].kind, 'session');
  assert.ok(!items.some((i) => i.command === 'move.up'), 'pure navigation hidden');
  assert.ok(items.some((i) => i.command === 'theme.dark'));
  const color = items.find((i) => i.command === 'color.set.1');
  assert.equal(color.title, 'Set tab color: blue (api)');
  assert.equal(items.find((i) => i.command === 'color.set.3').title, 'Set tab color: green');
  assert.equal(items.find((i) => i.command === 'sort.cycle').shortcut, 's');
  const noName = paletteItems({ sessions: [{ uid: 'u', state: 'quiet' }] });
  assert.equal(noName.find((i) => i.kind === 'session').title, 'Go to ~');
  assert.equal(paletteItems().filter((i) => i.kind === 'session').length, 0);
  assert.ok(EXTRA_ACTIONS.length > 5);
});

test('reply options appear as palette commands when a reply is available', () => {
  const reply = replyModel(fixture.sessions[1], fixture.prefs, fixture.capabilities);
  const items = paletteItems({ sessions: [], reply, now: NOW });
  assert.deepEqual(items.slice(0, 3).map((i) => i.command), ['reply.send.1', 'reply.send.2', 'reply.send.3']);
  assert.equal(items[0].title, 'Reply: 1. Yes');
  const noQ = paletteItems({ reply: { ...reply, question: '' } });
  assert.equal(noQ[0].subtitle, 'Quick reply');
});

test('ranking uses the fuzzy matcher; empty query keeps natural order and the limit', () => {
  const items = paletteItems({ sessions: fixture.sessions, projects: fixture.projects, now: NOW });
  const r = paletteResults('grid', items);
  assert.ok(r.slice(0, 2).some((x) => x.item.command === 'view.grid'));
  assert.equal(r[0].indices.length, 4);
  assert.equal(paletteResults('', items).length, Math.min(MAX_RESULTS, items.length));
  assert.deepEqual(paletteResults('', items, 2).map((x) => x.item.key), items.slice(0, 2).map((i) => i.key));
  assert.equal(paletteResults('qqqqzzzz', items).length, 0);
});

test('highlightSegments splits text into matched runs', () => {
  assert.deepEqual(highlightSegments('View: grid', [6, 7, 8, 9]), [{ text: 'View: ', match: false }, { text: 'grid', match: true }]);
  assert.deepEqual(highlightSegments('abc', []), [{ text: 'abc', match: false }]);
  assert.deepEqual(highlightSegments('ab', [0]), [{ text: 'a', match: true }, { text: 'b', match: false }]);
  assert.deepEqual(highlightSegments('', null), []);
});

test('palette cursor wraps', () => {
  assert.equal(moveCursor(0, -1, 3), 2);
  assert.equal(moveCursor(2, 1, 3), 0);
  assert.equal(moveCursor(1, 1, 0), 0);
});

test('shortcut sheet groups every command under the four categories (P-48)', () => {
  const sections = shortcutSections();
  assert.deepEqual(sections.map((s) => s.category), ['Navigate', 'Act', 'View', 'System']);
  const act = sections[1].entries;
  assert.equal(act.filter((e) => e.id === 'color.set').length, 1, 'color family collapsed');
  assert.deepEqual(act.find((e) => e.id === 'reply.send').keys, ['⌥1–⌥9']);
  const view = sections[2].entries.find((e) => e.id === 'view.cycle');
  assert.deepEqual(view.keys, ['v']);
  const refresh = sections[1].entries.find((e) => e.id === 'refresh');
  assert.deepEqual(refresh.keys, ['r', '⌘r']);
});

test('dedupeKeys drops upper-case variants only when the lower-case one is present', () => {
  assert.deepEqual(dedupeKeys(['v', 'V']), ['v']);
  assert.deepEqual(dedupeKeys(['A']), ['A']);
  assert.deepEqual(dedupeKeys(['⏎', 'g', 'G']), ['⏎', 'g']);
});

test('hint bar is context sensitive (P-53)', () => {
  assert.deepEqual(hintsFor({ overlay: 'zoom' }).map((h) => h[1]), ['change session', 'go to', 'back']);
  assert.deepEqual(hintsFor({ overlay: 'usage' }).map((h) => h[0]), ['$', 'r', 'u']);
  const split = hintsFor({ overlay: null, view: 'split', hasSelection: true, reply: true }).map((h) => h[1]);
  assert.ok(split.includes('reply') && split.includes('zoom'));
  const grid = hintsFor({ overlay: null, view: 'grid', hasSelection: false, reply: false }).map((h) => h[1]);
  assert.ok(grid.includes('all / agents') && !grid.includes('zoom'));
});
