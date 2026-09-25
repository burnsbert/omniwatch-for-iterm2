#!/usr/bin/env node
// gen-keys-md.mjs — generates the keyboard-shortcuts table in README.md from
// the single source of truth for keybindings: omniwatch/web/js/commands.js
// (titles + categories) and omniwatch/web/js/keymap.js (physical key
// bindings). Node stdlib only.
//
// Usage:
//   node scripts/gen-keys-md.mjs           regenerate the table in README.md
//   node scripts/gen-keys-md.mjs --check   exit 1 if README.md is out of date
//
// The table is written between the `<!-- keys:start -->` / `<!-- keys:end -->`
// markers, which must already exist in README.md.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { CATEGORIES, commandsByCategory } from '../omniwatch/web/js/commands.js';
import { formatBindingsFor } from '../omniwatch/web/js/keymap.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const README_PATH = path.join(ROOT, 'README.md');
const START = '<!-- keys:start -->';
const END = '<!-- keys:end -->';

// Commands whose id ends in ".<N>" (color.set.1..5, reply.send.1..9) are
// collapsed into a single row with a key range, matching how a person would
// describe them ("1-5", "opt-1 - opt-9"), instead of one row per number.
const FAMILY_RE = /^(.*)\.(\d+)$/;

/** ['1','2','3','4','5'] -> '1–5'; ['⌥1',…,'⌥9'] -> '⌥1–⌥9'; else joined with ' / '. */
function rangeLabel(keys) {
  const parsed = keys.map((k) => {
    const m = k.match(/^(\D*)(\d+)$/);
    return m ? { prefix: m[1], n: Number(m[2]) } : null;
  });
  if (parsed.length > 1 && parsed.every(Boolean) && parsed.every((p) => p.prefix === parsed[0].prefix)) {
    const nums = parsed.map((p) => p.n).sort((a, b) => a - b);
    const consecutive = nums.every((n, i) => i === 0 || n === nums[i - 1] + 1);
    if (consecutive) return `${parsed[0].prefix}${nums[0]}–${parsed[0].prefix}${nums[nums.length - 1]}`;
  }
  return keys.join(' / ');
}

/** One row per command in a category, collapsing numeric families. */
function rowsForCategory(commands) {
  const rows = [];
  const done = new Set();
  for (const cmd of commands) {
    if (done.has(cmd.id)) continue;
    const m = cmd.id.match(FAMILY_RE);
    const family = m ? commands.filter((c) => {
      const cm = c.id.match(FAMILY_RE);
      return cm && cm[1] === m[1];
    }) : [cmd];
    if (family.length > 1) {
      family.forEach((c) => done.add(c.id));
      const keys = family.flatMap((c) => formatBindingsFor(c.id));
      const title = cmd.title.replace(/\d+/, 'N');
      rows.push({ keys: rangeLabel(keys), title });
      continue;
    }
    done.add(cmd.id);
    const keys = formatBindingsFor(cmd.id);
    rows.push({ keys: keys.length ? keys.join(' / ') : '—', title: cmd.title });
  }
  return rows;
}

function generateTable() {
  const groups = commandsByCategory();
  const lines = [];
  for (const category of CATEGORIES) {
    const commands = groups.get(category) || [];
    if (!commands.length) continue;
    lines.push(`**${category}**`, '', '| Key | Action |', '|-----|--------|');
    for (const row of rowsForCategory(commands)) {
      lines.push(`| ${row.keys} | ${row.title} |`);
    }
    lines.push('');
  }
  lines.push(
    '_Native app only (not in the web keymap, so it works even when the window is',
    'hidden): a global hotkey — default **⌃⌥⌘O** — shows or hides Omniwatch; a second,',
    'off-by-default hotkey goes to the next waiting session in iTerm2 without switching to',
    'it. **⌘Q** quits the app._',
  );
  return lines.join('\n').trimEnd();
}

function withTable(readme, table) {
  const startIdx = readme.indexOf(START);
  const endIdx = readme.indexOf(END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    console.error(`gen-keys-md: README.md is missing the ${START} / ${END} markers`);
    process.exit(2);
  }
  const before = readme.slice(0, startIdx + START.length);
  const after = readme.slice(endIdx);
  return `${before}\n\n${table}\n\n${after}`;
}

function main() {
  const check = process.argv.includes('--check');
  const readme = readFileSync(README_PATH, 'utf8');
  const next = withTable(readme, generateTable());
  if (check) {
    if (next === readme) {
      console.log('gen-keys-md --check: README.md keys table is up to date');
      return;
    }
    console.error('gen-keys-md --check: README.md keys table is stale — run: node scripts/gen-keys-md.mjs');
    process.exit(1);
    return;
  }
  if (next === readme) {
    console.log('gen-keys-md: README.md keys table already up to date');
    return;
  }
  writeFileSync(README_PATH, next, 'utf8');
  console.log('gen-keys-md: wrote the keys table into README.md');
}

main();
