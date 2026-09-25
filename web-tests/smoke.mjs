#!/usr/bin/env node
// smoke.mjs — headless smoke run of the web UI against mock-server.mjs:
// loads the page through /auth, waits for the session list, drives a few
// interactions, and fails on any console error, page error, CSP violation
// or failed request. With `--shots DIR` it also saves screenshots of the
// main views in dark and light themes (plus compact) for visual review.
//
//   node web-tests/smoke.mjs [--shots DIR]
//
// Headless only: never opens a visible window. Uses the Playwright-managed
// Chromium if present, else the newest cached chrome-headless-shell.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { startMockServer } from './mock-server.mjs';

function findChromium() {
  try {
    const p = chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch (_) { /* fall through */ }
  const cache = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  const dirs = fs.existsSync(cache) ? fs.readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])) : [];
  for (const d of dirs) {
    for (const sub of fs.readdirSync(path.join(cache, d))) {
      const exe = path.join(cache, d, sub, 'chrome-headless-shell');
      if (fs.existsSync(exe)) return exe;
    }
  }
  return undefined;
}

const args = process.argv.slice(2);
const shotsDir = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;
const wantCoverage = args.includes('--coverage');
const coverage = new Map(); // url -> {source, covered:Set<line>, lines:Set<line>}
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });

function findWebkit() {
  try {
    const p = webkit.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch (_) { /* fall through */ }
  const cache = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  const dirs = fs.existsSync(cache) ? fs.readdirSync(cache).filter((d) => /^webkit-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])) : [];
  for (const d of dirs) {
    const exe = path.join(cache, d, 'pw_run.sh');
    if (fs.existsSync(exe)) return exe;
  }
  return undefined;
}

const engine = args.includes('--browser') ? args[args.indexOf('--browser') + 1] : 'chromium';
const browserType = engine === 'webkit' ? webkit : chromium;
const executablePath = engine === 'webkit' ? findWebkit() : findChromium();
console.log(`engine ${engine} (${executablePath || 'playwright default'})`);
const browser = await browserType.launch({ headless: true, executablePath });
const problems = [];
let checks = 0;
const check = (cond, msg) => {
  checks += 1;
  if (!cond) problems.push(`assertion failed: ${msg}`);
};

async function openPage(srv, { width = 1440, height = 900, scheme = 'dark', theme = null, reducedMotion = 'reduce' } = {}) {
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: 2, colorScheme: scheme, reducedMotion,
  });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console error [${width}x${height} ${scheme}]: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('requestfailed', (r) => {
    // SSE requests are aborted when a context closes; not a failure.
    if (!r.url().includes('/api/v1/events')) problems.push(`request failed: ${r.url()} ${r.failure() && r.failure().errorText}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.request().method()} ${r.url()}`);
  });
  if (wantCoverage) await page.coverage.startJSCoverage({ resetOnNavigation: false });
  const origClose = context.close.bind(context);
  context.close = async () => {
    if (wantCoverage) collectCoverage(await page.coverage.stopJSCoverage());
    return origClose();
  };
  await page.goto(srv.authUrl);
  if (theme) {
    await page.evaluate(async (t) => {
      await fetch('/api/v1/prefs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: t }) });
    }, theme);
  }
  return { page, context };
}

// Line coverage from V8 block ranges: a line counts if the innermost range
// containing its first code character ran. Merged across every page.
function collectCoverage(entries) {
  for (const e of entries) {
    const m = /\/js\/(.+\.js)$/.exec(new URL(e.url).pathname);
    if (!m || !e.source) continue;
    const ranges = e.functions.flatMap((fn) => fn.ranges);
    let rec = coverage.get(m[1]);
    if (!rec) {
      rec = { covered: new Set(), lines: new Set() };
      coverage.set(m[1], rec);
    }
    let offset = 0;
    let inBlockComment = false;
    e.source.split('\n').forEach((line, i) => {
      const t = line.trim();
      const lead = line.length - line.trimStart().length;
      const isComment = inBlockComment || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*');
      if (t.startsWith('/*') && !t.includes('*/')) inBlockComment = true;
      else if (inBlockComment && t.includes('*/')) inBlockComment = false;
      if (t && !isComment && !/^[})\];,]+$/.test(t)) {
        const at = offset + lead;
        let best = null;
        for (const r of ranges) {
          if (r.startOffset <= at && at < r.endOffset && (!best || r.endOffset - r.startOffset < best.endOffset - best.startOffset)) best = r;
        }
        rec.lines.add(i);
        if (best && best.count > 0) rec.covered.add(i);
      }
      offset += line.length + 1;
    });
  }
}

async function shot(page, name) {
  if (!shotsDir) return;
  await page.waitForTimeout(250);
  const file = path.join(shotsDir, `${name}.png`);
  // Note: on WebKit, Playwright's screenshot injects a <style> the page's CSP refuses (logged as a
  // console error), so run WebKit smokes without --shots.
  await page.screenshot({ path: file });
  console.log(`screenshot ${file}`);
}

const srv = await startMockServer({ port: 0, quiet: true, animate: true });
async function resetScenario(server, name) {
  await fetch(`${server.url}/api/v1/demo/scenario`, {
    method: 'POST', headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  });
}
try {
  // ---- main smoke: split view, dark
  for (const scheme of ['dark', 'light']) {
    await resetScenario(srv, 'default');
    const { page, context } = await openPage(srv, { scheme, theme: scheme });
    await page.waitForSelector('.ow-row[data-state="waiting"]', { timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll('.ow-sessions-sidebar .ow-row').length >= 5);
    const rows = await page.locator('.ow-sessions-sidebar .ow-row').count();
    check(rows >= 5, `sidebar rows rendered (${rows})`);
    check(await page.locator('[role="listbox"][aria-activedescendant]').count() >= 1, 'listbox has aria-activedescendant');
    // select the waiting Claude session so the quick-reply bar shows
    await page.locator('.ow-row[data-state="waiting"]').first().click();
    await page.waitForSelector('.ow-preview-full .ow-reply:not([hidden])');
    check(await page.locator('.ow-preview-full .ow-reply-opt').count() >= 2, 'reply options rendered');
    await shot(page, `split-${scheme}`);

    // filter
    await page.keyboard.press('/');
    await page.keyboard.type('bill');
    await page.waitForFunction(() => document.querySelectorAll('.ow-sessions-sidebar .ow-row').length === 1);
    check(true, 'filter narrows the list');
    await page.keyboard.press('Escape');

    // grid
    await page.keyboard.press('Meta+3');
    await page.waitForSelector('.ow-grid .ow-tile');
    check(await page.locator('.ow-tile').count() >= 3, 'grid tiles');
    await shot(page, `grid-${scheme}`);

    // zoom
    await page.keyboard.press('Meta+1');
    await page.waitForSelector('.ow-preview-full:not([hidden])');
    await page.locator('.ow-row[data-state="waiting"]').first().click();
    await page.keyboard.press(' ');
    await page.waitForSelector('.ow-preview-zoom:not([hidden])');
    await shot(page, `zoom-${scheme}`);
    await page.keyboard.press('Escape');

    // list
    await page.keyboard.press('Meta+2');
    await page.waitForSelector('.ow-sessions-table .ow-trow');
    await shot(page, `list-${scheme}`);
    await page.keyboard.press('Meta+1');

    // usage
    await page.keyboard.press('u');
    await page.waitForSelector('.ow-usage-view:not([hidden]) .ow-card');
    check(await page.locator('.ow-card').count() >= 4, 'usage cards');
    await shot(page, `usage-${scheme}`);
    await page.keyboard.press('u');

    // palette
    await page.keyboard.press('Meta+k');
    await page.waitForSelector('.ow-palette-input');
    await page.keyboard.type('sort');
    await page.waitForSelector('.ow-palette-item mark');
    await shot(page, `palette-${scheme}`);
    await page.keyboard.press('Escape');

    // settings
    await page.keyboard.press('Meta+,');
    await page.waitForSelector('.ow-settings');
    await shot(page, `settings-${scheme}`);
    await page.keyboard.press('Escape');

    // shortcuts
    await page.keyboard.press('?');
    await page.waitForSelector('.ow-keys-grid');
    await shot(page, `shortcuts-${scheme}`);
    await page.keyboard.press('Escape');

    // projects + context menu
    await page.keyboard.press('p');
    await page.waitForSelector('.ow-slots:not([hidden])');
    await page.locator('.ow-row').first().click({ button: 'right' });
    await page.waitForSelector('.ow-menu-context');
    await shot(page, `projects-menu-${scheme}`);
    await page.keyboard.press('Escape');
    await page.keyboard.press('p');

    if (scheme === 'dark') {
      // label edit (P-61): l → type → ⏎ shows the pill
      await page.locator('.ow-row[data-state="quiet"]').first().click();
      await page.keyboard.press('l');
      await page.waitForSelector('.ow-preview-full .ow-label-input');
      await page.keyboard.type('infra-shell');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => [...document.querySelectorAll('.ow-preview-full .ow-pill')].some((e) => e.textContent === 'infra-shell' && !e.hidden));
      check(true, 'label saved');
      // project rename (P-63)
      await page.keyboard.press('p');
      await page.locator('.ow-slot[data-slot="4"] .ow-slot-btn').click();
      await page.waitForSelector('.ow-slot-input');
      await page.keyboard.type('ops');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.ow-slot[data-slot="4"] .ow-slot-name').textContent === 'ops');
      check(true, 'project renamed');
      await page.keyboard.press('p');
      // sort menu (P-60)
      await page.locator('.ow-tool-btn[aria-haspopup="menu"]').click();
      await page.waitForSelector('.ow-menu-sort');
      await page.locator('.ow-menu-sort .ow-menu-item', { hasText: 'Attention' }).click();
      await page.waitForFunction(() => document.querySelector('.ow-sort-text').textContent === 'attention');
      check(true, 'sort menu sets attention');
      // quick reply (§3 P0): ⌥1 on the waiting Codex session → 202 → toast
      await page.locator('.ow-row[data-state="waiting"]').first().click();
      await page.waitForSelector('.ow-preview-full .ow-reply:not([hidden])');
      await page.locator('.ow-preview-full .ow-reply-opt').first().click();
      await page.waitForFunction(() => [...document.querySelectorAll('.ow-toast-msg')].some((e) => e.textContent.startsWith('Replied to')));
      check(true, 'quick reply sent');
      await page.locator('.ow-tool-btn[aria-haspopup="menu"]').click();
      await page.locator('.ow-menu-sort .ow-menu-item', { hasText: 'Natural' }).click();
    }

    // confirm dialog (close tab) — cancelled
    await page.keyboard.press('x');
    await page.waitForSelector('.ow-confirm');
    await shot(page, `confirm-${scheme}`);
    await page.keyboard.press('n');
    await context.close();
  }

  // ---- compact companion width
  for (const scheme of ['dark', 'light']) {
    await resetScenario(srv, 'default');
    const { page, context } = await openPage(srv, { width: 400, height: 760, scheme, theme: scheme });
    await page.waitForSelector('[data-layout="compact"] .ow-sessions-sidebar .ow-row');
    await page.locator('.ow-row[data-state="waiting"]').first().click();
    await page.waitForSelector('.ow-preview-drawer .ow-reply:not([hidden])');
    await shot(page, `compact-${scheme}`);
    await context.close();
  }

  // ---- virtualization: 240 sessions, only a window of rows in the DOM
  await fetch(`${srv.url}/api/v1/demo/scenario`, {
    method: 'POST', headers: { Authorization: `Bearer ${srv.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'many' }),
  });
  {
    const { page, context } = await openPage(srv, { scheme: 'dark' });
    await page.waitForSelector('.ow-sessions-sidebar .ow-row');
    const inDom = await page.locator('.ow-sessions-sidebar .ow-row').count();
    check(inDom > 10 && inDom < 120, `virtualized: ${inDom} of 240 rows in the DOM`);
    await page.locator('.ow-sessions-sidebar .ow-listbox').focus();
    await page.keyboard.press('End');
    for (let i = 0; i < 60; i += 1) await page.keyboard.press('ArrowDown');
    const active = await page.evaluate(() => {
      const lb = document.querySelector('.ow-sessions-sidebar .ow-listbox');
      const id = lb.getAttribute('aria-activedescendant');
      return !!(id && document.getElementById(id));
    });
    check(active, 'aria-activedescendant row is rendered after scrolling by keyboard');
    await shot(page, 'many-dark');
    await context.close();
  }

  // ---- high contrast
  await fetch(`${srv.url}/api/v1/demo/scenario`, {
    method: 'POST', headers: { Authorization: `Bearer ${srv.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'default' }),
  });
  {
    const { page, context } = await openPage(srv, { scheme: 'dark', theme: 'high-contrast' });
    await page.waitForSelector('.ow-row[data-state="waiting"]');
    check(await page.evaluate(() => document.documentElement.dataset.theme) === 'high-contrast', 'high-contrast theme applied');
    await shot(page, 'split-high-contrast');
    await page.evaluate(async () => {
      await fetch('/api/v1/prefs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: 'system' }) });
    });
    await context.close();
  }

  // ---- onboarding + empty states
  for (const [scenario, name, sel] of [
    ['onboarding', 'onboarding', '.ow-onboarding'],
    ['not-running', 'empty-not-running', '.ow-empty[data-kind="not_running"]'],
    ['not-authorized', 'empty-not-authorized', '.ow-empty[data-kind="not_authorized"]'],
  ]) {
    await fetch(`${srv.url}/api/v1/demo/scenario`, {
      method: 'POST', headers: { Authorization: `Bearer ${srv.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: scenario }),
    });
    const { page, context } = await openPage(srv, { scheme: 'dark' });
    await page.waitForSelector(sel);
    await shot(page, `${name}-dark`);
    await context.close();
  }
  await fetch(`${srv.url}/api/v1/demo/scenario`, {
    method: 'POST', headers: { Authorization: `Bearer ${srv.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'default' }),
  });
} finally {
  await browser.close();
  await srv.close();
}

if (wantCoverage) {
  let tl = 0;
  let tc = 0;
  console.log('browser JS line coverage (smoke run, Chromium):');
  for (const [file, rec] of [...coverage.entries()].sort()) {
    tl += rec.lines.size;
    tc += rec.covered.size;
    console.log(`  ${file.padEnd(32)} ${(100 * rec.covered.size / Math.max(1, rec.lines.size)).toFixed(1).padStart(6)}%  (${rec.covered.size}/${rec.lines.size})`);
  }
  console.log(`  ${'all files'.padEnd(32)} ${(100 * tc / Math.max(1, tl)).toFixed(1).padStart(6)}%  (${tc}/${tl})`);
}
console.log(`smoke: ${checks} checks, ${problems.length} problems`);
for (const p of problems) console.log(`  - ${p}`);
process.exit(problems.length ? 1 : 0);
