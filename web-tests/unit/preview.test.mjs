import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isChrome, tailLines } from '../../omniwatch/web/js/preview.js';

// Shared fixture with tests/test_textutil.py (DESIGN.md §4.2: tail_lines/
// is_chrome are ported to both omniwatch/textutil.py and this module, and
// tested against the same fixture so the two can't silently drift apart).
const busySpinnerFixture = readFileSync(
  fileURLToPath(new URL('../../tests/fixtures/claude_busy_spinner.txt', import.meta.url)),
  'utf8',
);

// Parity with ultrawatch_lib/ui/draw.py:_is_chrome.
test('isChrome(): blank lines and a bare prompt glyph are chrome', () => {
  assert.equal(isChrome(''), true);
  assert.equal(isChrome('   '), true);
  assert.equal(isChrome('❯'), true);
  assert.equal(isChrome('  ❯  '), true);
});

test('isChrome(): box-drawing divider lines (any run of ─/━) are chrome', () => {
  assert.equal(isChrome('──────────'), true);
  assert.equal(isChrome('━━━━━━'), true);
  assert.equal(isChrome('──━━──'), true);
  assert.equal(isChrome('── not a divider'), false);
});

test('isChrome(): ⏵⏵ status lines are chrome', () => {
  assert.equal(isChrome('⏵⏵ auto-accept edits on'), true);
});

test('isChrome(): "% remaining]" footer lines are chrome', () => {
  assert.equal(isChrome('Context left until auto-compact: [42% remaining]'), true);
});

test('isChrome(): ordinary content lines are not chrome', () => {
  assert.equal(isChrome('Do you want to proceed?'), false);
  assert.equal(isChrome('❯ 1. Yes'), false); // has trailing content, not the bare glyph
});

// Parity with ultrawatch_lib/ui/draw.py:tail_lines.
test('tailLines(): trims trailing blank lines before taking the tail', () => {
  const text = 'a\nb\nc\n\n\n';
  assert.deepEqual(tailLines(text, 2, 80), ['b', 'c']);
});

test('tailLines(): clips each line to width', () => {
  const text = 'a very long line of text';
  assert.deepEqual(tailLines(text, 1, 6), ['a very']);
});

test('tailLines(): n <= 0 returns an empty array', () => {
  assert.deepEqual(tailLines('a\nb', 0, 80), []);
  assert.deepEqual(tailLines('a\nb', -1, 80), []);
});

test('tailLines(): stripChrome drops up to 8 trailing chrome lines, then re-trims blanks', () => {
  const lines = ['real content', '❯', '──────', '⏵⏵ auto-accept', '[10% remaining]', ''];
  const text = lines.join('\n');
  assert.deepEqual(tailLines(text, 5, 80, { stripChrome: true }), ['real content']);
});

test('tailLines(): stripChrome stops after 8 lines even if more chrome follows', () => {
  const chromeLines = new Array(10).fill('❯');
  const text = ['keep me', ...chromeLines].join('\n');
  const result = tailLines(text, 20, 80, { stripChrome: true });
  // Only 8 of the 10 trailing chrome lines are stripped, so 2 remain plus "keep me".
  assert.deepEqual(result, ['keep me', '❯', '❯']);
});

test('tailLines(): without stripChrome, chrome lines are left in place', () => {
  const text = ['real content', '❯'].join('\n');
  assert.deepEqual(tailLines(text, 5, 80), ['real content', '❯']);
});

test('tailLines(): empty text returns an empty array', () => {
  assert.deepEqual(tailLines('', 5, 80), []);
});

// Parity checks against tests/fixtures/claude_busy_spinner.txt, mirroring
// tests/test_textutil.py's TestStripChromeLines/TestTailLines assertions
// on the exact same fixture file (Python and JS can't silently diverge).
test('shared fixture: tailLines(stripChrome) drops the spinner/footer chrome, keeps real content', () => {
  const stripped = tailLines(busySpinnerFixture, 20, 80, { stripChrome: true });
  assert.ok(!stripped.includes('❯'));
  assert.ok(!stripped.some((l) => l.includes('% remaining]')));
  assert.ok(!stripped.some((l) => l.trim() && /^[─━]+$/.test(l.trim())));
  assert.ok(stripped.some((l) => l.includes('✢ Ruminating…')));
  assert.match(stripped[stripped.length - 1], /Tip: Use \/permissions/);
});

test('shared fixture: stripping chrome yields strictly fewer lines than without', () => {
  const without = tailLines(busySpinnerFixture, 20, 80, { stripChrome: false });
  const withStrip = tailLines(busySpinnerFixture, 20, 80, { stripChrome: true });
  assert.ok(withStrip.length < without.length);
  assert.ok(!withStrip.includes('  ⏵⏵ auto mode on (shift+tab to cycle)'));
});
