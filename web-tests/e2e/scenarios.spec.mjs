// Every demo scenario's empty / error / permission state (§2.9, P-54, P-26).
import { test, expect } from './fixtures.mjs';

test.describe('scenario: empty', () => {
  test.use({ appOptions: { scenario: 'empty', prefs: {}, open: true, allowHttp: [] } });
  test('"No iTerm2 sessions" with New tab @P-54', async ({ app }) => {
    const e = app.page.locator('.ow-empty[data-kind="no_sessions"]');
    await expect(e.locator('h2')).toHaveText('No iTerm2 sessions');
    await e.getByRole('button', { name: 'New tab' }).click();
    await app.toast(/^opening new tab…$/);
  });
});

test.describe('scenario: not-running', () => {
  test.use({ appOptions: { scenario: 'not-running', prefs: {}, open: true, allowHttp: [] } });
  test('"iTerm2 isn’t running" + Launch iTerm2; the status chip says Not running @P-54 @P-26', async ({ app }) => {
    const e = app.page.locator('.ow-empty[data-kind="not_running"]');
    await expect(e.locator('h2')).toHaveText('iTerm2 isn’t running');
    await expect(app.page.locator('.ow-status-chip')).toHaveText('Not running');
    await e.getByRole('button', { name: 'Launch iTerm2' }).click();
    await app.toast(/^launching iTerm2…$/);
  });
});

test.describe('scenario: not-authorized', () => {
  test.use({ appOptions: { scenario: 'not-authorized', prefs: {}, open: true, allowHttp: [] } });
  test('the permission card offers Automation settings and Try again @P-54 @P-26', async ({ app }) => {
    const e = app.page.locator('.ow-empty[data-kind="not_authorized"]');
    await expect(e.locator('h2')).toHaveText('Omniwatch needs permission to read iTerm2');
    await expect(e.getByRole('button', { name: 'Open Automation settings' })).toBeVisible();
    await expect(app.page.locator('.ow-status-chip')).toHaveText('No permission');
    const probe = app.page.waitForRequest((r) => r.url().endsWith('/diagnostics/probe-automation'));
    await e.getByRole('button', { name: 'Try again' }).click();
    await probe;
    await app.toast(/asking macOS for permission/);
  });
});

test.describe('scenario: many', () => {
  test.use({ appOptions: { scenario: 'many', prefs: {}, open: true, allowHttp: [] } });
  test('lots of sessions scroll and keep the selection rendered', async ({ app }) => {
    const st = await app.state();
    const rows = app.page.locator('.ow-sessions-sidebar .ow-row');
    expect(await rows.count()).toBeLessThanOrEqual(st.sessions.length);
    await app.page.locator('.ow-sessions-sidebar .ow-row').first().click();
    for (let i = 0; i < 30; i += 1) await app.page.keyboard.press('j');
    const id = await app.page.locator('.ow-sessions-sidebar .ow-listbox').getAttribute('aria-activedescendant');
    await expect(app.page.locator(`#${id}`)).toBeVisible();
  });
});

test.describe('scenario: usage-errors', () => {
  test.use({ appOptions: { scenario: 'usage-errors', prefs: {}, open: true, allowHttp: [] } });
  test('sessions still render; usage shows the failure messages @P-51', async ({ app }) => {
    await expect(app.page.locator('.ow-strip-msg').first()).toHaveText('usage API fetch failed');
    await expect(app.page.locator('.ow-sessions-sidebar .ow-row')).toHaveCount((await app.state()).sessions.length);
  });
});

test.describe('scenario: default', () => {
  test('no empty state; filter no-match state with Clear @P-54', async ({ app }) => {
    await expect(app.page.locator('.ow-empty-host')).toBeHidden();
    await app.page.keyboard.press('/');
    await app.page.keyboard.type('nothing-matches');
    const e = app.page.locator('.ow-list-empty .ow-empty');
    await expect(e.locator('h2')).toHaveText('No sessions match “nothing-matches”');
    await e.getByRole('button', { name: /Clear filter/ }).click();
    await expect(app.page.locator('.ow-sessions-sidebar .ow-row')).toHaveCount(11);
  });
});
