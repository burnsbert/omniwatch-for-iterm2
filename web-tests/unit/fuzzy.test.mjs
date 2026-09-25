import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyMatch, fuzzyScore, rankFuzzyMatches } from '../../omniwatch/web/js/fuzzy.js';

// Parity fixtures mirror ultrawatch_lib/ui/draw.py:fuzzy_match (P-59):
// case-insensitive subsequence match over "{path} {name} {label}".
test('fuzzyMatch(): empty needle always matches (parity with an empty filter)', () => {
  assert.equal(fuzzyMatch('', 'anything'), true);
  assert.equal(fuzzyMatch(undefined, 'anything'), true);
});

test('fuzzyMatch(): case-insensitive subsequence, not substring', () => {
  assert.equal(fuzzyMatch('bil', '~/src/billing'), true);
  assert.equal(fuzzyMatch('BIL', '~/src/billing'), true);
  assert.equal(fuzzyMatch('sbil', '~/src/billing'), true); // s...bil, out of contiguous order but in sequence
  assert.equal(fuzzyMatch('zzz', '~/src/billing'), false);
});

test('fuzzyMatch(): matches across the combined "{path} {name} {label}" haystack (P-59)', () => {
  const haystack = '~/src/billing ✳ Refactor parser refactor';
  assert.equal(fuzzyMatch('refr', haystack), true);
  assert.equal(fuzzyMatch('billrefr', haystack), true);
});

test('fuzzyMatch(): requires needle characters in order', () => {
  assert.equal(fuzzyMatch('ba', 'ab'), false);
  assert.equal(fuzzyMatch('ab', 'ab'), true);
});

test('fuzzyScore(): non-match reports matched:false and no indices', () => {
  const r = fuzzyScore('zzz', 'billing');
  assert.equal(r.matched, false);
  assert.deepEqual(r.indices, []);
});

test('fuzzyScore(): empty needle matches with score 0', () => {
  assert.deepEqual(fuzzyScore('', 'billing'), { matched: true, score: 0, indices: [] });
});

test('fuzzyScore(): a contiguous prefix match scores higher than a scattered match', () => {
  const contiguous = fuzzyScore('api', 'api-gateway');
  const scattered = fuzzyScore('api', 'a-slow-pipe-i-guess');
  assert.equal(contiguous.matched, true);
  assert.equal(scattered.matched, true);
  assert.ok(contiguous.score > scattered.score, `${contiguous.score} should exceed ${scattered.score}`);
});

test('fuzzyScore(): an earlier match start scores higher than a later one', () => {
  const early = fuzzyScore('log', 'log viewer');
  const late = fuzzyScore('log', 'the background log viewer');
  assert.ok(early.score > late.score);
});

test('rankFuzzyMatches(): ranks a command-palette-style list, best (contiguous) match first', () => {
  const items = [
    { title: 'Toggle dollars' }, // no g/r/i/d subsequence at all -> excluded
    { title: 'View: grid' }, // contiguous "grid" -> best match
    { title: 'Go to ~/src/api-gateway · deploy-fix' }, // "grid" only as a scattered subsequence -> matches, but ranks lower
  ];
  const ranked = rankFuzzyMatches('grid', items, (i) => i.title);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].item.title, 'View: grid');
});

test('rankFuzzyMatches(): stable order for equal scores, ties broken by original order', () => {
  const items = [{ title: 'aaa' }, { title: 'aab' }];
  const ranked = rankFuzzyMatches('a', items, (i) => i.title);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].item.title, 'aaa');
  assert.equal(ranked[1].item.title, 'aab');
});

test('rankFuzzyMatches(): drops non-matching items entirely', () => {
  const items = [{ title: 'foo' }, { title: 'bar' }];
  const ranked = rankFuzzyMatches('xyz', items, (i) => i.title);
  assert.deepEqual(ranked, []);
});
