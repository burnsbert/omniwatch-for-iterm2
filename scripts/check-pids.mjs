#!/usr/bin/env node
// check-pids.mjs — every non-Drop parity row in docs/DESIGN.md §1 (P-01 …
// P-83) must be referenced by at least one test: a web unit test
// (web-tests/unit), an E2E spec (web-tests/e2e, `@P-xx` tags), or a Python
// test (tests/, any `P-xx` mention). Rows whose Status is exactly "Drop"
// (or starts with "Drop" and has no "Keep") are exempt. Node stdlib only.
//
//   node scripts/check-pids.mjs          exit 1 and list the uncovered IDs
//   node scripts/check-pids.mjs --list   also print where each ID is covered

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verbose = process.argv.includes('--list');

// ---- parity rows from DESIGN §1 --------------------------------------------
const design = readFileSync(path.join(ROOT, 'docs', 'DESIGN.md'), 'utf8');
const section = design.slice(design.indexOf('## 1. Parity matrix'), design.indexOf('## 2. GUI design'));
const rows = [];
for (const line of section.split('\n')) {
  const m = /^\|\s*(P-\d{2})\s*\|/.exec(line);
  if (!m) continue;
  const cells = line.split('|').map((c) => c.trim()).filter((c, i, a) => i > 0 && i < a.length - 1);
  const status = cells[cells.length - 1];
  rows.push({ id: m[1], status });
}
const isDrop = (status) => /^Drop\b/.test(status) && !/Keep/.test(status);
const required = rows.filter((r) => !isDrop(r.status));
const dropped = rows.filter((r) => isDrop(r.status)).map((r) => r.id);

// ---- test sources --------------------------------------------------------
function walk(dir, exts) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    if (f === 'node_modules' || f.startsWith('.')) return [];
    return statSync(p).isDirectory() ? walk(p, exts) : (exts.some((e) => p.endsWith(e)) ? [p] : []);
  });
}
const sources = [
  ...walk(path.join(ROOT, 'web-tests', 'unit'), ['.test.mjs']),
  ...walk(path.join(ROOT, 'web-tests', 'e2e'), ['.spec.mjs']),
  ...walk(path.join(ROOT, 'tests'), ['.py']),
];
const where = new Map();
for (const file of sources) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/\bP-(\d{2})\b/g)) {
    const id = `P-${m[1]}`;
    if (!where.has(id)) where.set(id, new Set());
    where.get(id).add(path.relative(ROOT, file));
  }
}

const uncovered = required.filter((r) => !where.has(r.id)).map((r) => r.id);
console.log(`check-pids: ${rows.length} parity rows in DESIGN §1; ${dropped.length} Drop (${dropped.join(', ')}); ${required.length} required`);
console.log(`check-pids: scanned ${sources.length} test files (web unit, e2e, python)`);
if (verbose) for (const r of required) console.log(`  ${r.id}  ${where.has(r.id) ? [...where.get(r.id)].join(', ') : '— UNCOVERED'}`);
console.log(`check-pids: ${required.length - uncovered.length} covered, ${uncovered.length} uncovered${uncovered.length ? `: ${uncovered.join(', ')}` : ''}`);
process.exit(uncovered.length ? 1 : 0);
