// First-run onboarding (§2.10).
import { test, expect } from './fixtures.mjs';

test.describe('onboarding', () => {
  test.use({ appOptions: { scenario: 'default', prefs: { onboarding_done: false }, open: true, allowHttp: [] } });

  test('opens on first run with three steps and live status; Skip persists onboarding_done @P-54', async ({ app }) => {
    const sheet = app.page.getByRole('dialog', { name: 'Set up Omniwatch' });
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('.ow-step-title')).toHaveText(['Control iTerm2', 'Tab colors & projects', 'Notifications']);
    await expect(sheet.locator('.ow-step').first()).toHaveAttribute('data-status', 'done');
    await expect(sheet.locator('.ow-step-status')).toContainText('Connected');
    await sheet.getByRole('button', { name: 'Next' }).click();
    await expect(sheet.locator('.ow-step-body h3')).toHaveText('Color tabs by project');
    await expect(sheet.locator('.ow-code code')).toHaveText('make install-colors');
    await sheet.getByRole('button', { name: 'Next' }).click();
    await expect(sheet.getByRole('button', { name: 'Done' })).toBeVisible();
    await sheet.getByRole('button', { name: 'Try the demo' }).click();
    await app.toast(/omniwatch demo/);
    await sheet.getByRole('button', { name: 'Skip setup' }).click();
    await expect(sheet).toBeHidden();
    await expect.poll(async () => (await app.prefs()).onboarding_done).toBe(true);
    await app.page.reload();
    await app.page.waitForSelector('.ow-row');
    await expect(app.page.locator('.ow-onboarding')).toHaveCount(0);
  });
});
