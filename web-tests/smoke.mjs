#!/usr/bin/env node
// smoke.mjs — headless smoke run of the web UI. Loads the page through
// /auth, drives the main views and actions, and fails on any console error,
// page error, CSP violation, failed request or HTTP ≥ 400.
//
//   node web-tests/smoke.mjs [--backend mock|real] [--browser chromium|webkit]
//                            [--shots DIR] [--coverage]
//
// --backend real spawns `python3 -m omniwatch serve --demo --ready-json
// --port 0` with OMNIWATCH_CONFIG_DIR pointed at a fresh temp dir (so
// ~/.config/omniwatch is never touched) and logs in with the token from the
// ready line. --backend mock (default) uses web-tests/mock-server.mjs.
//
// Headless only: never opens a visible window. Uses the Playwright-managed
// browser if present, else the newest cached build. On WebKit, Playwright's
// screenshot injects a <style> that the page's CSP refuses (logged as a
// console error), so WebKit runs ignore exactly that message while --shots
// is on, and report how many were ignored.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { startMockServer } from './mock-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const shotsDir = opt('--shots', null);
const wantCoverage = args.includes('--coverage');
const engine = opt('--browser', 'chromium');
const backendKind = opt('--backend', 'mock');
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });

// ------------------------------------------------------------- browsers

function cached(prefix, rel) {
  const cache = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  if (!fs.existsSync(cache)) return undefined;
  const dirs = fs.readdirSync(cache).filter((d) => d.startsWith(prefix) && /-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop()));
  for (const d of dirs) {
    for (const r of rel(path.join(cache, d))) if (fs.existsSync(r)) return r;
  }
  return undefined;
}

function executableFor(type) {
  try {
    const p = type.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch (_) { /* fall back to the cache */ }
  if (type === webkit) return cached('webkit-', (d) => [path.join(d, 'pw_run.sh')]);
  return cached('chromium_headless_shell-', (d) => fs.readdirSync(d).map((s) => path.join(d, s, 'chrome-headless-shell')));
}

// -------------------------------------------------------------- backends

async function startRealBackend() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-smoke-'));
  const child = spawn('python3', ['-m', 'omniwatch', 'serve', '--demo', '--ready-json', '--port', '0'], {
    cwd: REPO,
    env: { ...process.env, OMNIWATCH_CONFIG_DIR: configDir, PYTHONPATH: REPO, PYTHONUNBUFFERED: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  const ready = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`no ready line in 15 s; stderr:\n${stderr}`)), 15000);
    child.stdout.on('data', (c) => {
      buf += c;
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        clearTimeout(timer);
        try { resolve(JSON.parse(buf.slice(0, nl))); } catch (e) { reject(e); }
      }
    });
    child.on('exit', (code) => reject(new Error(`backend exited ${code}; stderr:\n${stderr}`)));
  });
  const url = `http://127.0.0.1:${ready.port}`;
  return {
    kind: 'real',
    url,
    token: ready.token,
    authUrl: `${url}/auth?token=${ready.token}`,
    ready,
    async close() {
      try {
        await fetch(`${url}/api/v1/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${ready.token}` } });
      } catch (_) { /* already gone */ }
      await new Promise((resolve) => {
        if (child.exitCode !== null) { resolve(); return; }
        const t = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 4000);
        child.on('exit', () => { clearTimeout(t); resolve(); });
      });
      fs.rmSync(configDir, { recursive: true, force: true });
    },
  };
}

async function startBackend() {
  if (backendKind === 'real') return startRealBackend();
  const m = await startMockServer({ port: 0, quiet: true, animate: true });
  return { kind: 'mock', ...m };
}

// ---------------------------------------------------------------- harness

const problems = [];
let checks = 0;
let ignoredShotCsp = 0;
const check = (cond, msg) => {
  checks += 1;
  if (!cond) problems.push(`assertion failed: ${msg}`);
};
const coverage = new Map();

const browserType = engine === 'webkit' ? webkit : chromium;
const executablePath = executableFor(browserType);
console.log(`engine ${engine} (${executablePath || 'playwright default'}); backend ${backendKind}`);
const browser = await browserType.launch({ headless: true, executablePath });
const srv = await startBackend();
if (srv.ready) console.log(`ready line: ${JSON.stringify({ ...srv.ready, token: `<${srv.ready.token.length} chars>` })}`);

async function api(method, p, body) {
  const r = await fetch(`${srv.url}${p}`, {
    method, headers: { Authorization: `Bearer ${srv.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await r.json().catch(() => null);
  return { status: r.status, json };
}
const resetScenario = (name) => api('POST', '/api/v1/demo/scenario', { name });
const patchPrefs = (p) => api('PATCH', '/api/v1/prefs', p);

async function openPage({ width = 1440, height = 900, scheme = 'dark', reducedMotion = 'reduce' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: scheme, reducedMotion });
  const page = await context.newPage();
  const tag = `[${engine} ${width}x${height} ${scheme}]`;
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (engine === 'webkit' && shotsDir && /Refused to apply a stylesheet/.test(m.text())) {
      ignoredShotCsp += 1;
      return;
    }
    problems.push(`console error ${tag}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`page error ${tag}: ${e.message}`));
  page.on('requestfailed', (r) => {
    // The SSE request is aborted when a context closes; not a failure.
    if (!r.url().includes('/api/v1/events')) problems.push(`request failed ${tag}: ${r.url()} ${r.failure() && r.failure().errorText}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${tag}: ${r.request().method()} ${r.url()}`);
  });
  if (wantCoverage && engine === 'chromium') await page.coverage.startJSCoverage({ resetOnNavigation: false });
  const origClose = context.close.bind(context);
  context.close = async () => {
    if (wantCoverage && engine === 'chromium') collectCoverage(await page.coverage.stopJSCoverage());
    return origClose();
  };
  await page.goto(srv.authUrl);
  return { page, context };
}

async function shot(page, name) {
  if (!shotsDir) return;
  await page.waitForTimeout(250);
  const file = path.join(shotsDir, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`screenshot ${file}`);
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
    let inBlock = false;
    e.source.split('\n').forEach((line, i) => {
      const t = line.trim();
      const lead = line.length - line.trimStart().length;
      const isComment = inBlock || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*');
      if (t.startsWith('/*') && !t.includes('*/')) inBlock = true;
      else if (inBlock && t.includes('*/')) inBlock = false;
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

const rowCount = (page) => page.locator('.ow-sessions-sidebar .ow-row').count();
const toastSeen = (page, re) => page.waitForFunction((src) => [...document.querySelectorAll('.ow-toast-msg')]
  .some((e) => new RegExp(src).test(e.textContent)), re.source, { timeout: 8000 });

// ------------------------------------------------------------------ flows

try {
  // First run shows the onboarding sheet (real demo: onboarding_done=false).
  await resetScenario('default');
  if (srv.kind === 'mock') await patchPrefs({ onboarding_done: false });
  {
    const { page, context } = await openPage({ scheme: 'dark' });
    await page.waitForSelector('.ow-onboarding', { timeout: 10000 });
    check(true, 'onboarding opens on first run');
    await shot(page, 'onboarding-dark');
    await page.locator('.ow-onboarding .ow-ghost-btn', { hasText: 'Skip setup' }).click();
    await page.waitForFunction(() => !document.querySelector('.ow-onboarding'));
    await context.close();
  }
  const prefs = await api('GET', '/api/v1/prefs');
  check(prefs.json && prefs.json.onboarding_done === true, 'Skip setup persisted onboarding_done');

  for (const scheme of ['dark', 'light']) {
    await resetScenario('default');
    check((await patchPrefs({ theme: scheme, view: 'split', sort: 'natural' })).status === 200, `PATCH theme ${scheme}`);
    const { page, context } = await openPage({ scheme });
    await page.waitForSelector('.ow-row[data-state="waiting"]', { timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll('.ow-sessions-sidebar .ow-row').length >= 5);
    check(await page.evaluate(() => document.documentElement.dataset.theme) === scheme, `theme ${scheme} applied`);
    check(await page.locator('[role="listbox"][aria-activedescendant]').count() >= 1, 'listbox has aria-activedescendant');
    await page.locator('.ow-row[data-state="waiting"]').first().click();
    await page.waitForSelector('.ow-preview-full .ow-reply:not([hidden])');
    check(await page.locator('.ow-preview-full .ow-reply-opt').count() >= 2, 'reply options rendered');
    await shot(page, `split-${scheme}`);

    // filter (P-59)
    const before = await rowCount(page);
    await page.keyboard.press('/');
    await page.keyboard.type('bill');
    await page.waitForFunction((n) => {
      const c = document.querySelectorAll('.ow-sessions-sidebar .ow-row').length;
      return c >= 1 && c < n;
    }, before);
    check(true, 'filter narrows the list');
    await page.keyboard.press('Escape');
    await page.waitForFunction((n) => document.querySelectorAll('.ow-sessions-sidebar .ow-row').length === n, before);

    // views (P-37): grid, zoom, list
    await page.keyboard.press('Meta+3');
    await page.waitForSelector('.ow-grid .ow-tile');
    check(await page.locator('.ow-tile').count() >= 3, 'grid tiles');
    const tileMismatch = await page.evaluate(() => [...document.querySelectorAll('.ow-tile[data-state="waiting"]')]
      .filter((t) => !/\?|\(y\)|proceed|Yes/.test(t.querySelector('.ow-tile-body').textContent))
      .map((t) => t.querySelector('.ow-tile-title').textContent));
    check(tileMismatch.length === 0, `waiting tiles show a prompt (${JSON.stringify(tileMismatch)})`);
    await shot(page, `grid-${scheme}`);
    await page.keyboard.press('Meta+1');
    await page.waitForSelector('.ow-preview-full:not([hidden])');
    await page.locator('.ow-row[data-state="waiting"]').first().click();
    await page.keyboard.press(' ');
    await page.waitForSelector('.ow-preview-zoom:not([hidden])');
    await shot(page, `zoom-${scheme}`);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Meta+2');
    await page.waitForSelector('.ow-sessions-table .ow-trow');
    await shot(page, `list-${scheme}`);
    await page.keyboard.press('Meta+1');
    await page.waitForSelector('.ow-preview-full:not([hidden])');
    check((await api('GET', '/api/v1/prefs')).json.view === 'split', 'view persisted via PATCH');

    // usage (P-51)
    await page.keyboard.press('u');
    await page.waitForSelector('.ow-usage-view:not([hidden]) .ow-card');
    check(await page.locator('.ow-card').count() >= 4, 'usage cards');
    await shot(page, `usage-${scheme}`);
    await page.keyboard.press('u');

    // palette, settings, shortcuts
    await page.keyboard.press('Meta+k');
    await page.waitForSelector('.ow-palette-input');
    await page.keyboard.type('sort');
    await page.waitForSelector('.ow-palette-item mark');
    await shot(page, `palette-${scheme}`);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Meta+,');
    await page.waitForSelector('.ow-settings');
    await shot(page, `settings-${scheme}`);
    await page.keyboard.press('Escape');
    await page.keyboard.press('?');
    await page.waitForSelector('.ow-keys-grid');
    await shot(page, `shortcuts-${scheme}`);
    await page.keyboard.press('Escape');

    if (scheme === 'dark') {
      // label (P-61)
      await page.locator('.ow-sessions-sidebar .ow-row:not([data-state="waiting"])').first().click();
      await page.keyboard.press('l');
      await page.waitForSelector('.ow-preview-full .ow-label-input');
      await page.keyboard.press('Meta+a');
      await page.keyboard.type('smoke-label');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => [...document.querySelectorAll('.ow-preview-full .ow-pill')].some((e) => e.textContent === 'smoke-label' && !e.hidden));
      const st = (await api('GET', '/api/v1/state')).json;
      check(st.sessions.some((s) => s.label === 'smoke-label'), 'label saved in the backend');

      // mute (§3 P0) via the preview header button
      await page.locator('.ow-preview-full .ow-pv-actions .ow-icon-btn').first().click();
      await toastSeen(page, /muted$/);
      await page.waitForFunction(() => document.querySelector('.ow-sessions-sidebar .ow-row.is-selected.is-muted'));
      check(true, 'mute applied');
      await page.locator('.ow-preview-full .ow-pv-actions .ow-icon-btn').first().click();
      await toastSeen(page, /unmuted$/);

      // tab color (P-64): key 2 → purple
      await page.locator('.ow-sessions-sidebar .ow-listbox').focus();
      await page.keyboard.press('2');
      await toastSeen(page, /→ purple/);
      check(true, 'color set toast');

      // project rename (P-63)
      await page.keyboard.press('p');
      await page.locator('.ow-slot[data-slot="4"] .ow-slot-btn').click();
      await page.waitForSelector('.ow-slot-input');
      await page.keyboard.type('ops');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.ow-slot[data-slot="4"] .ow-slot-name').textContent === 'ops');
      check(true, 'project renamed');
      await page.locator('.ow-sessions-sidebar .ow-row').first().click({ button: 'right' });
      await page.waitForSelector('.ow-menu-context');
      await shot(page, 'projects-menu-dark');
      await page.keyboard.press('Escape');
      await page.keyboard.press('p');

      // sort menu (P-60)
      await page.locator('.ow-tool-btn[aria-haspopup="menu"]').click();
      await page.waitForSelector('.ow-menu-sort');
      await page.locator('.ow-menu-sort .ow-menu-item', { hasText: 'Attention' }).click();
      await page.waitForFunction(() => document.querySelector('.ow-sort-text').textContent === 'attention');
      check((await api('GET', '/api/v1/prefs')).json.sort === 'attention', 'sort persisted');
      await page.keyboard.press('s');
      await page.waitForFunction(() => document.querySelector('.ow-sort-text').textContent === 'agents');

      // quick reply (§3 P0): first option on the first waiting session
      await page.locator('.ow-sessions-sidebar .ow-row[data-state="waiting"]').first().click();
      await page.waitForSelector('.ow-preview-full .ow-reply:not([hidden])');
      const uid = await page.evaluate(() => document.querySelector('.ow-sessions-sidebar .ow-row.is-selected').dataset.uid);
      await page.locator('.ow-preview-full .ow-reply-opt').first().click();
      await toastSeen(page, /^Replied to/);
      check(true, 'quick reply accepted (202)');
      if (srv.kind === 'real') {
        await api('POST', '/api/v1/demo/step', { seconds: 2 });
        await page.waitForFunction((u) => {
          const row = document.getElementById(`ow-row-${u.replace(/[^A-Za-z0-9_-]/g, '_')}`);
          return row && row.dataset.state !== 'waiting';
        }, uid, { timeout: 8000 });
        check(true, 'replied session left waiting after /demo/step');
      }

      // /demo/step advances the scripted timeline and the UI follows
      const seq0 = (await api('GET', '/api/v1/state')).json.seq;
      const step = await api('POST', '/api/v1/demo/step', { seconds: 6 });
      check(step.status === 200 && step.json.ok === true && step.json.seq >= seq0, `demo/step 200 (seq ${seq0} → ${step.json && step.json.seq})`);
      const stateAfter = (await api('GET', '/api/v1/state')).json;
      await page.waitForFunction((n) => document.querySelector('.ow-pill-count').textContent === String(n), stateAfter.summary.waiting, { timeout: 8000 });
      check(true, 'waiting pill tracks the backend after a step');

      // high contrast is client-local (no 422 from the backend)
      await page.evaluate(() => window.omniwatch.command('theme.high-contrast'));
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'high-contrast');
      await shot(page, 'split-high-contrast');
      await page.evaluate(() => window.omniwatch.command('theme.dark'));
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
      await page.locator('.ow-tool-btn[aria-haspopup="menu"]').click();
      await page.locator('.ow-menu-sort .ow-menu-item', { hasText: 'Natural' }).click();
    }

    // confirm dialog (close tab) — cancelled
    await page.locator('.ow-sessions-sidebar .ow-listbox').focus();
    await page.keyboard.press('x');
    await page.waitForSelector('.ow-confirm');
    await shot(page, `confirm-${scheme}`);
    await page.keyboard.press('n');
    await page.waitForFunction(() => !document.querySelector('.ow-confirm'));
    await context.close();
  }

  // compact companion width (§3 P0)
  for (const scheme of ['dark', 'light']) {
    await resetScenario('default');
    await patchPrefs({ theme: scheme });
    const { page, context } = await openPage({ width: 400, height: 760, scheme });
    await page.waitForSelector('[data-layout="compact"] .ow-sessions-sidebar .ow-row');
    await page.locator('.ow-row[data-state="waiting"]').first().click();
    await page.waitForSelector('.ow-preview-drawer .ow-reply:not([hidden])');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= 400), 'compact layout fits 400 px');
    await shot(page, `compact-${scheme}`);
    await context.close();
  }
  await patchPrefs({ theme: 'dark' });

  // virtualization: 'many' scenario, only a window of rows in the DOM
  await resetScenario('many');
  {
    const { page, context } = await openPage({ scheme: 'dark' });
    await page.waitForSelector('.ow-sessions-sidebar .ow-row');
    const total = (await api('GET', '/api/v1/state')).json.sessions.length;
    const inDom = await rowCount(page);
    if (total > 200) check(inDom < total && inDom > 5, `virtualized: ${inDom} of ${total} rows in the DOM`);
    else check(inDom === total, `${total} sessions (≤200) all rendered`);
    await page.locator('.ow-sessions-sidebar .ow-listbox').focus();
    for (let i = 0; i < 40; i += 1) await page.keyboard.press('ArrowDown');
    check(await page.evaluate(() => {
      const lb = document.querySelector('.ow-sessions-sidebar .ow-listbox');
      const id = lb.getAttribute('aria-activedescendant');
      return !!(id && document.getElementById(id));
    }), 'aria-activedescendant row is rendered after keyboard scrolling');
    await shot(page, 'many-dark');
    await context.close();
  }

  // empty / permission states (§2.9)
  for (const [scenario, name, sel] of [
    ['not-running', 'empty-not-running', '.ow-empty[data-kind="not_running"]'],
    ['not-authorized', 'empty-not-authorized', '.ow-empty[data-kind="not_authorized"]'],
    ['empty', 'empty-no-sessions', '.ow-empty[data-kind="no_sessions"]'],
  ]) {
    await resetScenario(scenario);
    const { page, context } = await openPage({ scheme: 'dark' });
    await page.waitForSelector(sel, { timeout: 10000 });
    check(true, `${scenario} empty state`);
    await shot(page, `${name}-dark`);
    await context.close();
  }
  await resetScenario('default');
} catch (err) {
  problems.push(`flow aborted: ${err.message.split('\n')[0]}`);
} finally {
  await browser.close();
  await srv.close();
}

if (wantCoverage && coverage.size) {
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
if (ignoredShotCsp) console.log(`(ignored ${ignoredShotCsp} WebKit screenshot-injection CSP messages)`);
console.log(`smoke [${engine}, ${backendKind} backend]: ${checks} checks, ${problems.length} problems`);
for (const p of problems) console.log(`  - ${p}`);
process.exit(problems.length ? 1 : 0);
