// Usage strip + view (P-49/P-51/P-69/P-70), levels, projections, burn and
// sparklines, errors, gating, quota banner.
import { test, expect } from './fixtures.mjs';
import { startBackend } from './backend.mjs';

test.describe('usage', () => {
  test('the strip shows one row per provider with meters, collapses (persisted), and opens the view @P-49 @P-70', async ({ app }) => {
    const strip = app.page.locator('.ow-strip');
    await expect(strip.locator('.ow-strip-provider')).toHaveText(['Claude', 'Codex']);
    await expect(strip.locator('.ow-strip-limit')).toHaveCount(6);
    await strip.getByRole('button', { name: 'Collapse usage strip' }).click();
    await expect.poll(async () => (await app.prefs()).usage_strip).toBe('collapsed');
    await expect(strip).toHaveClass(/is-collapsed/);
    await expect(strip.locator('.ow-strip-sum')).toHaveCount(2);
    await strip.locator('.ow-strip-body').click();
    await expect(app.page.locator('.ow-usage-view')).toBeVisible();
    await app.page.keyboard.press('u');
    await expect(app.page.locator('.ow-usage-view')).toBeHidden();
    await app.page.keyboard.press('Meta+u');
    await expect(app.page.locator('.ow-usage-view')).toBeVisible();
  });

  test('cards: title, level-colored percentage, countdown, one outlook per limit @P-51 @P-18 @P-19', async ({ app }) => {
    const st = await app.state();
    await app.page.keyboard.press('u');
    const cards = app.page.locator('.ow-card');
    await expect(cards).toHaveCount(6);
    await expect(app.page.locator('.ow-usage-refreshed')).toHaveText(/^Refreshed \d+[smh] ago$/);
    const five = cards.filter({ hasText: 'Session · 5h' }).first();
    const lim = st.usage.claude.limits.find((l) => l.id === 'claude.five_hour');
    await expect(five.locator('.ow-card-pct')).toHaveText(`${Math.round(lim.pct)}%`);
    await expect(five).toHaveAttribute('data-tone', { green: 'ok', yellow: 'warn', red: 'danger' }[lim.level]);
    await expect(five.locator('.ow-card-reset')).toHaveText(/^Resets in \d+h \d+m · Today at /);
    for (const c of await cards.all()) {
      expect(await c.locator('.ow-card-burn, .ow-card-warn').count(), 'at most one projection line').toBeLessThanOrEqual(1);
    }
    await expect(five.locator('.ow-card-burn')).toHaveText(/^At this rate: /);
  });

  test('burn-rate sparklines from /usage/history in cards and the strip', async ({ app }) => {
    await app.page.keyboard.press('u');
    await expect(app.page.locator('.ow-card .ow-spark')).toHaveCount(6);
    await expect(app.page.locator('.ow-strip .ow-spark').first()).toBeVisible();
    await expect(app.page.locator('.ow-card-rate').first()).toHaveText(/^\+\d+(\.\d)?%\/h$/);
  });

  test('$ toggles the monthly dollar amount: "$ hidden · press $" ↔ the limit @P-69 @P-20', async ({ app }) => {
    await app.page.keyboard.press('u');
    const monthly = app.page.locator('.ow-card').filter({ hasText: 'Monthly cap' });
    await expect(monthly.locator('.ow-card-dollars')).toHaveText('$ hidden · press $');
    await app.page.keyboard.press('$');
    await app.toast(/^Claude monthly dollar limit shown$/);
    await expect(monthly.locator('.ow-card-dollars')).not.toHaveText('$ hidden · press $');
    await expect(monthly.locator('.ow-card-dollars')).toHaveText(/\$\d/);
    await expect.poll(async () => (await app.prefs()).show_dollars).toBe(true);
  });

  test('both providers render as sections (Claude Code, Codex) @P-15 @P-16', async ({ app }) => {
    await app.page.keyboard.press('u');
    await expect(app.page.locator('.ow-usage-provider-name')).toHaveText(['Claude Code', 'Codex']);
  });
});

test.describe('usage errors and gating', () => {
  test.use({ appOptions: { scenario: 'usage-errors', prefs: {}, open: true, allowHttp: [] } });
  test('fetch failures show the P-51 messages @P-51', async ({ app }) => {
    await app.page.keyboard.press('u');
    await expect(app.page.locator('.ow-usage-msg')).toHaveText(['usage API fetch failed', 'Codex usage fetch failed']);
    await expect(app.page.locator('.ow-strip-msg')).toHaveText(['usage API fetch failed', 'Codex usage fetch failed']);
  });
});

test.describe('usage when no agents run', () => {
  test.use({ appOptions: { scenario: 'empty', prefs: {}, open: true, allowHttp: [] } });
  test('inactive providers are hidden and the view explains gating @P-17 @P-51', async ({ app }) => {
    await app.page.keyboard.press('u');
    await expect(app.page.locator('.ow-usage-view h3')).toHaveText('No Claude Code or Codex sessions running');
    await expect(app.page.locator('.ow-usage-view')).toContainText('only checks your limits while an agent of that kind is running');
  });
});

test.describe('quota email banner', () => {
  test('pending in the demo; Skip this month clears it for good @P-21', async ({ page }) => {
    const b = await startBackend();
    try {
      await b.api('PATCH', '/api/v1/prefs', { onboarding_done: true });
      await page.goto(b.authUrl);
      const banner = page.locator('.ow-banner[data-tone="attention"]');
      await expect(banner).toContainText('Claude usage is at 91% of your monthly limit');
      await banner.getByRole('button', { name: 'Skip this month' }).click();
      await expect(banner).toBeHidden();
      expect((await b.api('GET', '/api/v1/state')).json.quota_prompt).toBe(null);
      await page.reload();
      await page.waitForSelector('.ow-row');
      await expect(banner).toBeHidden();
    } finally {
      await b.stop();
    }
  });
});
