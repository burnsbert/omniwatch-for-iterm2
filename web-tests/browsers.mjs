// browsers.mjs — find a headless browser build for Playwright. Prefers the
// Playwright-managed one; falls back to the newest cached build under
// ~/Library/Caches/ms-playwright (the pinned 1.55 revisions may not be
// downloaded on this machine). Shared by playwright.config.mjs,
// smoke.mjs and scripts/screenshots.mjs.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { CHROMIUM_MUTE_ARGS } from './audio-mute.mjs';

function cached(prefix, candidates) {
  const cache = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  if (!fs.existsSync(cache)) return undefined;
  const dirs = fs.readdirSync(cache).filter((d) => d.startsWith(prefix) && /-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop()));
  for (const d of dirs) {
    for (const c of candidates(path.join(cache, d))) if (fs.existsSync(c)) return c;
  }
  return undefined;
}

export function executableFor(name) {
  const type = name === 'webkit' ? webkit : chromium;
  try {
    const p = type.executablePath();
    if (p && fs.existsSync(p)) return undefined; // Playwright's own build is installed: use it
  } catch (_) { /* fall back to the cache */ }
  if (name === 'webkit') return cached('webkit-', (d) => [path.join(d, 'pw_run.sh')]);
  return cached('chromium_headless_shell-', (d) => fs.readdirSync(d).map((s) => path.join(d, s, 'chrome-headless-shell')));
}

/**
 * Launch options for a headless browser: the executable (if we need the
 * cached build) and, for Chromium, --mute-audio — headless browsers still
 * reach the Mac's speakers. Every harness launches through this.
 */
export function launchOptions(name) {
  const executablePath = executableFor(name);
  const opts = { headless: true };
  if (executablePath) opts.executablePath = executablePath;
  if (name !== 'webkit') opts.args = [...CHROMIUM_MUTE_ARGS];
  return opts;
}
