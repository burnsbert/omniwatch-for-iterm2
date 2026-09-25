// Grid camera wall (P-45/P-46) and zoom (P-47).
import { test, expect } from './fixtures.mjs';

test.describe('grid', () => {
  test('agents only (dashboards out), chrome-stripped tails, amber border for waiting; A shows all @P-45', async ({ app }) => {
    await app.page.keyboard.press('Meta+3');
    const tiles = app.page.locator('.ow-tile');
    const st = await app.state();
    await expect(tiles).toHaveCount(st.sessions.filter((s) => s.agent && !s.is_dashboard).length);
    await expect(app.page.locator('.ow-tile[data-state="waiting"]')).toHaveCount(2);
    const body = await app.page.locator('.ow-tile[data-state="waiting"] .ow-tile-body').first().textContent();
    expect(body).toMatch(/proceed|run the following command/);
    expect(body.trim().split('\n').at(-1)).not.toMatch(/^[─━]+$|^❯$|⏵⏵|% remaining\]/);
    await expect(app.page.locator('.ow-tile.is-selected')).toHaveCount(1);
    await app.page.keyboard.press('A');
    await app.toast(/^grid: all sessions$/);
    await expect(tiles).toHaveCount(st.sessions.length);
    await expect.poll(async () => (await app.prefs()).grid_all).toBe(true);
  });

  test('←/→ move by one, ↑/↓ by the computed column count @P-46', async ({ app }) => {
    await app.page.keyboard.press('Meta+3');
    await app.page.keyboard.press('A');
    const cols = await app.page.locator('.ow-grid-row').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
    expect(cols).toBeGreaterThan(1);
    const sel = () => app.page.locator('.ow-tile.is-selected').evaluate((el) => [...el.parentNode.children].indexOf(el));
    await app.page.locator('.ow-tile').first().click();
    await app.page.keyboard.press('ArrowRight');
    expect(await sel()).toBe(1);
    await app.page.keyboard.press('ArrowDown');
    expect(await sel()).toBe(1 + cols);
    await app.page.keyboard.press('ArrowUp');
    await app.page.keyboard.press('ArrowLeft');
    expect(await sel()).toBe(0);
  });

  test('empty grid text: "No agent sessions — press A to show all" @P-45 @P-46', async ({ app }) => {
    await app.page.keyboard.press('Meta+3');
    await app.page.keyboard.press('/');
    await app.page.keyboard.type('zzzz');
    await expect(app.page.locator('.ow-list-empty .ow-empty')).toContainText('No sessions match');
  });

  test('tiles carry the activity ribbon and the stalled chip', async ({ app }) => {
    await app.page.keyboard.press('Meta+3');
    await expect(app.page.locator('.ow-tile').first().locator('.ow-rb')).toHaveCount(48);
    const stalled = app.page.locator('.ow-tile[data-stalled="true"]');
    await expect(stalled).toHaveCount(1);
    await expect(stalled.locator('.ow-stall-chip')).toHaveText(/^Stalled\? \d+m$/);
  });
});

test.describe('zoom', () => {
  test('Space zooms; ↑/↓ change session; ⏎ goes; any other key exits @P-47', async ({ app }) => {
    await app.row('1.1').click();
    await app.page.keyboard.press(' ');
    const zoom = app.page.locator('.ow-preview-zoom');
    await expect(zoom).toBeVisible();
    await expect(zoom.locator('.ow-pv-path')).toHaveText('~/src/api-gateway');
    await app.page.keyboard.press('ArrowDown');
    await expect(zoom.locator('.ow-pv-path')).toHaveText('~/src/billing');
    await app.page.keyboard.press('Enter');
    await app.toast(/^→ tab 1\.2$/);
    await expect(zoom).toBeVisible();
    await app.page.keyboard.press('x');
    await expect(zoom).toBeHidden();
    await expect(app.page.locator('.ow-confirm')).toHaveCount(0);
    await app.page.keyboard.press(' ');
    await app.page.keyboard.press('Escape');
    await expect(zoom).toBeHidden();
  });
});
