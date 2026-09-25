// Settings sheet and themes (§2.6): colorScheme × prefs.theme, text size,
// sound, hints, keep on top (browser), stall minutes, editor.
import { test, expect, newMutedContext } from './fixtures.mjs';

const bg = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test.describe('themes', () => {
  for (const [scheme, theme, expected] of [
    ['dark', 'system', 'rgb(15, 17, 21)'], ['light', 'system', 'rgb(247, 247, 248)'],
    ['light', 'dark', 'rgb(15, 17, 21)'], ['dark', 'light', 'rgb(247, 247, 248)'],
    ['light', 'high-contrast', 'rgb(0, 0, 0)'],
  ]) {
    test(`colorScheme ${scheme} + theme ${theme} → ${expected}`, async ({ app, browser }) => {
      await app.patch({ theme });
      const ctx = await newMutedContext(browser, { colorScheme: scheme });
      const page = await ctx.newPage();
      await page.goto(app.backend.authUrl);
      await page.waitForSelector('.ow-row');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect.poll(() => bg(page)).toBe(expected);
      await ctx.close();
    });
  }

  test('the theme segmented control PATCHes prefs.theme (including high contrast)', async ({ app }) => {
    await app.page.keyboard.press('Meta+,');
    await app.page.getByRole('radio', { name: /Light/ }).click();
    await expect.poll(async () => (await app.prefs()).theme).toBe('light');
    await expect.poll(() => bg(app.page)).toBe('rgb(247, 247, 248)');
    await app.page.getByRole('radio', { name: /High contrast/ }).click();
    await expect.poll(async () => (await app.prefs()).theme).toBe('high-contrast');
    await expect(app.page.locator('html')).toHaveAttribute('data-theme', 'high-contrast');
  });
});

test.describe('settings', () => {
  test('text size ⌘+ / ⌘− / ⌘0 persist font_scale', async ({ app }) => {
    await app.page.keyboard.press('Meta+=');
    await expect.poll(async () => (await app.prefs()).font_scale).toBe(1.1);
    await app.page.keyboard.press('Meta+-');
    await app.page.keyboard.press('Meta+-');
    await expect.poll(async () => (await app.prefs()).font_scale).toBe(0.9);
    await app.page.keyboard.press('Meta+0');
    await expect.poll(async () => (await app.prefs()).font_scale).toBe(1);
  });

  test('b toggles sound on attention, persisted @P-33', async ({ app }) => {
    await app.page.keyboard.press('b');
    await app.toast(/^sound on attention on$/);
    await expect.poll(async () => (await app.prefs()).sound).toBe(true);
    await app.page.keyboard.press('Meta+,');
    await expect(app.page.locator('.ow-switch[aria-label="Sound on attention"]')).toHaveAttribute('aria-checked', 'true');
  });

  test('the hint bar follows context and can be turned off @P-53', async ({ app }) => {
    const hints = app.page.locator('.ow-hints');
    await expect(hints).toContainText('next waiting');
    await app.page.keyboard.press('u');
    await expect(hints).toContainText('dollars');
    await app.page.keyboard.press('u');
    await app.page.keyboard.press('Meta+,');
    await app.page.locator('.ow-switch[aria-label="Show shortcut hints"]').click();
    await app.page.keyboard.press('Escape');
    await expect(hints).toBeHidden();
  });

  test('browser mode: keep on top and q are app-only; native rows are hidden', async ({ app }) => {
    await app.page.keyboard.press('Meta+,');
    await expect(app.page.locator('.ow-switch[aria-label="Keep window on top"]')).toBeDisabled();
    await expect(app.page.locator('.ow-set-row', { hasText: 'Launch at login' })).toBeHidden();
    await expect(app.page.locator('.ow-set-row', { hasText: 'Menu bar only' })).toBeHidden();
  });

  test('stall detection minutes, stall notifications and the editor command are saved', async ({ app }) => {
    await app.page.keyboard.press('Meta+,');
    await app.page.locator('.ow-settings .ow-select').selectOption('30');
    await expect.poll(async () => (await app.prefs()).stall_minutes).toBe(30);
    await app.page.locator('.ow-switch[aria-label="Stall notifications"]').click();
    await expect.poll(async () => (await app.prefs()).notifications.stall).toBe(false);
    const field = app.page.locator('.ow-settings .ow-text-field');
    await field.fill('code -w');
    await field.press('Enter');
    await expect.poll(async () => (await app.prefs()).editor).toBe('code -w');
    await app.page.locator('.ow-settings .ow-select').selectOption('0');
    await expect.poll(async () => (await app.state()).sessions.some((s) => s.stalled)).toBe(false);
  });

  test('a bad editor command is refused by the backend and reverted', async ({ app }) => {
    app.allow('422 PATCH /api/v1/prefs');
    await app.page.keyboard.press('Meta+,');
    const field = app.page.locator('.ow-settings .ow-text-field');
    await field.fill('code "unclosed');
    await field.press('Enter');
    await app.toast(/^settings failed: /);
    await expect(field).toHaveValue('');
  });
});
