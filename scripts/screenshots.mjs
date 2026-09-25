#!/usr/bin/env node
// screenshots.mjs — README / user-guide images (DESIGN §6, WP6).
//
//   node scripts/screenshots.mjs            write docs/screenshots/<name>-<theme>.png
//   node scripts/screenshots.mjs --verify   render to a temp dir and compare with
//                                           docs/screenshots (bytes, then pixels)
//   node scripts/screenshots.mjs --out DIR  write somewhere else
//
// Deterministic by construction: the REAL demo backend (`python3 -m omniwatch
// serve --demo --demo-clock <fixed> --demo-seed 7`, temp OMNIWATCH_CONFIG_DIR),
// headless Chromium at 1440×900 @2x, reducedMotion 'reduce', fixed locale and
// timezone, and the page clock pinned to the demo clock so every age and
// "… ago" is the same on every run. Headless only; never opens a window.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from '../web-tests/node_modules/playwright/index.mjs';
import { launchOptions } from '../web-tests/browsers.mjs';
import { muteContext } from '../web-tests/audio-mute.mjs';
import { startBackend, resetBackend, DEMO_CLOCK } from '../web-tests/e2e/backend.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs', 'screenshots');
const args = process.argv.slice(2);
const verify = args.includes('--verify');
const outDir = verify
  ? fs.mkdtempSync(path.join(os.tmpdir(), 'ow-shots-'))
  : (args.includes('--out') ? path.resolve(args[args.indexOf('--out') + 1]) : DOCS);
fs.mkdirSync(outDir, { recursive: true });

export const NAMES = ['split', 'list', 'grid', 'zoom', 'usage', 'palette', 'quick-reply', 'onboarding', 'projects',
  'empty-not-running', 'compact', 'stats', 'timeline', 'settings'];
const THEMES = ['dark', 'light'];

const backend = await startBackend();
// Muted: headless Chromium still reaches the speakers (web-tests/audio-mute.mjs).
const browser = await chromium.launch(launchOptions('chromium'));
// A clean hero: the quota-email banner is its own feature; dismiss it once.
await backend.api('POST', '/api/v1/quota-email/skip');

async function page(theme, { width = 1440, height = 900 } = {}) {
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: 'reduce',
    locale: 'en-US', timezoneId: 'America/New_York',
  });
  await muteContext(context);
  // Headless Chromium reports notifications as "denied" no matter what; show the
  // first-run state users actually see ("not asked yet") in onboarding/Settings.
  await context.addInitScript(() => {
    if (typeof Notification !== 'undefined') Object.defineProperty(Notification, 'permission', { get: () => 'default' });
  });
  const p = await context.newPage();
  const errors = [];
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  p.on('pageerror', (e) => errors.push(e.message));
  await p.clock.setFixedTime(new Date(DEMO_CLOCK * 1000));
  await p.goto(backend.authUrl);
  await p.waitForSelector('.ow-row, .ow-empty', { timeout: 15000 });
  return { p, context, errors };
}

const row = (p, tab) => p.locator(`.ow-sessions-sidebar .ow-row:has(.ow-row-tab:text-is("${tab}"))`);
const park = (p) => p.mouse.move(1100, 560); // off any hover target

async function settle(p) {
  await p.evaluate(() => document.fonts && document.fonts.ready);
  await park(p);
  await p.waitForTimeout(350);
}

const SCENES = {
  split: async (p) => { await row(p, '1.1').click(); },
  list: async (p) => {
    await p.keyboard.press('Meta+2');
    await p.locator('.ow-trow').first().click();
  },
  grid: async (p) => {
    await p.keyboard.press('Meta+3');
    await p.locator('.ow-tile').first().click();
  },
  zoom: async (p) => {
    await row(p, '1.1').click();
    await p.keyboard.press(' ');
    await p.waitForSelector('.ow-preview-zoom:not([hidden])');
  },
  usage: async (p) => {
    await p.keyboard.press('u');
    await p.waitForFunction(() => document.querySelectorAll('.ow-card .ow-spark').length >= 6);
  },
  palette: async (p) => {
    await row(p, '1.2').click();
    await p.keyboard.press('Meta+k');
    await p.keyboard.type('sort');
    await p.waitForSelector('.ow-palette-item mark');
  },
  'quick-reply': async (p) => {
    await row(p, '2.2').click();
    await p.keyboard.press('i');
    await p.keyboard.type('Yes — and bump the build number first');
  },
  onboarding: async (p) => {
    await p.waitForSelector('.ow-onboarding');
  },
  projects: async (p) => {
    await p.keyboard.press('p');
    await row(p, '2.1').click({ button: 'right' });
    await p.waitForSelector('.ow-menu-context');
  },
  'empty-not-running': async (p) => {
    await p.waitForSelector('.ow-empty[data-kind="not_running"]');
  },
  compact: async (p) => { await row(p, '1.1').click(); },
  stats: async (p) => {
    await p.locator('.ow-stats-chip').click();
    await p.waitForSelector('.ow-stats-card .ow-histo-bar');
  },
  timeline: async (p) => {
    await row(p, '1.1').click();
    await p.keyboard.press('t');
    await p.waitForSelector('.ow-history-sheet .ow-hist-seg');
  },
  settings: async (p) => {
    await p.keyboard.press('Meta+,');
    await p.waitForSelector('.ow-settings');
  },
};

const written = [];
const problems = [];
try {
  for (const theme of THEMES) {
    for (const name of NAMES) {
      const scenario = name === 'empty-not-running' ? 'not-running' : 'default';
      await resetBackend(backend, { scenario, prefs: { theme, onboarding_done: name !== 'onboarding' } });
      const size = name === 'compact' ? { width: 400, height: 860 } : {};
      const { p, context, errors } = await page(theme, size);
      await SCENES[name](p);
      await settle(p);
      // Rebrand guard: no user-visible "Ultrawatch" in any captured image.
      const legacy = await p.evaluate(() => /ultrawatch/i.test(document.body.innerText));
      if (legacy) problems.push(`${name}-${theme}: visible text mentions Ultrawatch`);
      const file = path.join(outDir, `${name}-${theme}.png`);
      await p.screenshot({ path: file });
      written.push(file);
      if (errors.length) problems.push(`${name}-${theme}: ${errors.join(' | ')}`);
      await context.close();
    }
  }
} finally {
  await browser.close();
  await backend.stop();
}

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 12);
console.log(`screenshots: ${written.length} PNGs → ${path.relative(ROOT, outDir) || outDir}`);
if (problems.length) {
  console.log('screenshots: page errors:');
  for (const x of problems) console.log(`  - ${x}`);
}

if (verify) {
  // Compare with docs/screenshots: identical bytes, else a pixel diff in a browser canvas.
  const cmpBrowser = await chromium.launch(launchOptions('chromium'));
  const cmp = await (await muteContext(await cmpBrowser.newContext())).newPage();
  let identical = 0;
  const diffs = [];
  for (const f of written) {
    const ref = path.join(DOCS, path.basename(f));
    if (!fs.existsSync(ref)) { diffs.push(`${path.basename(f)}: no reference`); continue; }
    if (sha(f) === sha(ref)) { identical += 1; continue; }
    const ratio = await cmp.evaluate(async ([a, b]) => {
      const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
      const [x, y] = await Promise.all([load(a), load(b)]);
      if (x.width !== y.width || x.height !== y.height) return 1;
      const px = (img) => {
        const c = new OffscreenCanvas(img.width, img.height);
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0);
        return g.getImageData(0, 0, img.width, img.height).data;
      };
      const da = px(x);
      const db = px(y);
      let bad = 0;
      for (let i = 0; i < da.length; i += 4) {
        if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 24) bad += 1;
      }
      return bad / (da.length / 4);
    }, [`data:image/png;base64,${fs.readFileSync(f).toString('base64')}`, `data:image/png;base64,${fs.readFileSync(ref).toString('base64')}`]);
    diffs.push(`${path.basename(f)}: bytes differ, ${(ratio * 100).toFixed(3)}% pixels differ`);
    if (ratio > 0.001) problems.push(`${path.basename(f)} differs by ${(ratio * 100).toFixed(3)}% (> 0.1%)`);
  }
  await cmpBrowser.close();
  console.log(`screenshots --verify: ${identical}/${written.length} byte-identical to docs/screenshots`);
  for (const d of diffs) console.log(`  ${d}`);
  fs.rmSync(outDir, { recursive: true, force: true });
}
process.exit(problems.length ? 1 : 0);
