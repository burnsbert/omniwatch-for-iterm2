// Lint (WP5 acceptance): no innerHTML / outerHTML / insertAdjacentHTML /
// document.write anywhere in the web UI's JS — dynamic text goes through
// dom.js as text nodes. Also no inline style attributes via setAttribute
// (CSP style-src 'self'); custom properties go through the CSSOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../omniwatch/web/js', import.meta.url));
function files(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : (p.endsWith('.js') ? [p] : []);
  });
}
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('no HTML-parsing DOM sinks in omniwatch/web/js/**', () => {
  const offenders = [];
  for (const f of files(root)) {
    const src = stripComments(readFileSync(f, 'utf8'));
    for (const re of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /createContextualFragment/, /\bnew Function\(/, /\beval\(/]) {
      if (re.test(src)) offenders.push(`${f}: ${re}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('no string style attributes (CSP: style-src \'self\')', () => {
  const offenders = [];
  for (const f of files(root)) {
    const src = stripComments(readFileSync(f, 'utf8'));
    if (/setAttribute\(\s*['"]style['"]/.test(src) && !f.endsWith('dom.js')) offenders.push(f);
    if (/\bstyle:\s*['"`]/.test(src)) offenders.push(`${f}: style string prop`);
  }
  assert.deepEqual(offenders, []);
});
