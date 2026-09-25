// Backend restart: "Reconnecting…" while it's down, stale data stays; the
// page is back once it's re-authorized against the new backend (§2.9).
import { test, expect } from '@playwright/test';
import net from 'node:net';
import { startBackend } from './backend.mjs';

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

test('reconnect after the backend restarts on the same port', async ({ page }) => {
  test.setTimeout(60000);
  const port = await freePort();
  let b = await startBackend({ port });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await b.api('PATCH', '/api/v1/prefs', { onboarding_done: true });
    await page.goto(b.authUrl);
    await page.waitForSelector('.ow-row');
    await b.stop();
    const banner = page.locator('.ow-banner', { hasText: 'Reconnecting' });
    await expect(banner).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.ow-sessions-sidebar .ow-row')).toHaveCount(11);
    b = await startBackend({ port });
    await b.api('PATCH', '/api/v1/prefs', { onboarding_done: true });
    await page.goto(b.authUrl); // what the app shell / `omniwatch --browser` does for a new token
    await expect(banner).toBeHidden({ timeout: 10000 });
    await expect(page.locator('.ow-sessions-sidebar .ow-row')).toHaveCount(11);
    expect(errors).toEqual([]);
  } finally {
    await b.stop();
  }
});
