// fixtures.mjs — Playwright fixtures for the Omniwatch E2E suite.
//  - `backend` (worker-scoped): one REAL demo backend per worker, frozen
//    demo clock + seed, temp config dir.
//  - `app` (test-scoped): resets the scenario and every pref, opens the UI
//    through /auth with the page clock pinned to the demo clock (so ages and
//    "updated … ago" are deterministic), and fails the test on any console
//    error, page error, or unexpected HTTP ≥ 400.

import { test as base, expect } from '@playwright/test';
import { startBackend, resetBackend, DEMO_CLOCK } from './backend.mjs';

export { expect };

export const test = base.extend({
  backend: [async ({}, use) => { // eslint-disable-line no-empty-pattern
    const b = await startBackend();
    await use(b);
    await b.stop();
  }, { scope: 'worker' }],

  // Per-test options for the `app` fixture.
  appOptions: [{ scenario: 'default', prefs: {}, open: true, allowHttp: [] }, { option: true }],

  app: async ({ page, backend, appOptions }, use) => {
    const problems = [];
    const allow = appOptions.allowHttp || [];
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      // The browser also logs an allowed HTTP error ("…status of 409 (Conflict)").
      const st = /status of (\d{3})/.exec(m.text());
      if (st && allow.some((a) => (a instanceof RegExp ? a.test(`${st[1]} POST /x/reply`) || a.source.includes(st[1]) : String(a).startsWith(st[1])))) return;
      problems.push(`console: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('response', (r) => {
      if (r.status() < 400) return;
      const key = `${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`;
      if (!allow.some((a) => (a instanceof RegExp ? a.test(key) : key === a))) problems.push(`HTTP ${key}`);
    });
    await resetBackend(backend, { scenario: appOptions.scenario, prefs: appOptions.prefs });
    await page.clock.setFixedTime(new Date(DEMO_CLOCK * 1000));
    const app = {
      page,
      backend,
      problems,
      allow: (pattern) => allow.push(pattern),
      api: backend.api,
      async open() {
        await page.goto(backend.authUrl);
        await page.waitForSelector('.ow-row, .ow-empty', { timeout: 10000 });
      },
      state: async () => (await backend.api('GET', '/api/v1/state')).json,
      prefs: async () => (await backend.api('GET', '/api/v1/prefs')).json,
      step: (seconds) => backend.api('POST', '/api/v1/demo/step', { seconds }),
      scenario: (name) => backend.api('POST', '/api/v1/demo/scenario', { name }),
      patch: (prefs) => backend.api('PATCH', '/api/v1/prefs', prefs),
      row: (tabLabel) => page.locator(`.ow-sessions-sidebar .ow-row:has(.ow-row-tab:text-is("${tabLabel}"))`),
      toast: (re) => expect(page.locator('.ow-toast-msg').filter({ hasText: re }).first()).toBeVisible(),
      lastKeyCommand: () => page.evaluate(() => document.documentElement.dataset.owKeyCommand || null),
      async clearKeyCommand() {
        await page.evaluate(() => { delete document.documentElement.dataset.owKeyCommand; });
      },
    };
    if (appOptions.open !== false) await app.open();
    await use(app);
    expect(problems, 'console errors / unexpected HTTP errors').toEqual([]);
  },
});
