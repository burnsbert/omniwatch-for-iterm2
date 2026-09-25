// P-81: the Makefile keeps the Ultrawatch targets and adds the Omniwatch
// ones (DESIGN §1.5), and e2e / screenshots / check-pids are real targets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mk = readFileSync(new URL('../../Makefile', import.meta.url), 'utf8');
const targets = new Set([...mk.matchAll(/^([a-z][a-z0-9-]*):/gm)].map((m) => m[1]));

test('P-81 make targets: test, check, dist, app, install, install-colors, e2e, screenshots, coverage, clean', () => {
  for (const t of ['test', 'check', 'dist', 'app', 'install', 'install-colors', 'e2e', 'screenshots', 'coverage', 'clean', 'check-pids']) {
    assert.ok(targets.has(t), `missing make target ${t}`);
  }
});

test('e2e and screenshots are real targets, and check runs check-pids + doc links', () => {
  const body = (name) => {
    const i = mk.indexOf(`\n${name}:`);
    return mk.slice(i, mk.indexOf('\n\n', i + 1));
  };
  assert.match(body('e2e'), /playwright test/);
  assert.doesNotMatch(body('e2e'), /TODO/);
  assert.match(body('screenshots'), /scripts\/screenshots\.mjs/);
  assert.match(body('check'), /check-pids/);
  assert.match(body('check'), /check-doc-links\.mjs/);
});
