// ⌘K command palette (§2.5).
import { test, expect } from './fixtures.mjs';

test.describe('command palette', () => {
  test('⌘K fuzzy-searches commands with highlighted matches; ⏎ runs', async ({ app }) => {
    await app.page.keyboard.press('Meta+k');
    const pal = app.page.getByRole('dialog', { name: 'Command palette' });
    await expect(pal).toBeVisible();
    await app.page.keyboard.type('view grid');
    await expect(pal.locator('.ow-palette-item.is-active .ow-palette-title')).toHaveText('View: grid');
    await expect(pal.locator('.ow-palette-item.is-active mark').first()).toBeVisible();
    await app.page.keyboard.press('Enter');
    await expect(pal).toBeHidden();
    await expect(app.page.locator('#app')).toHaveAttribute('data-layout', 'grid');
  });

  test('sessions: waiting ones lead the empty list; ⏎ goes to it, ⌥⏎ only selects', async ({ app }) => {
    await app.page.keyboard.press('Meta+k');
    // Reply options for the selected waiting session come first, then waiting sessions.
    const titles = await app.page.locator('.ow-palette-item .ow-palette-title').allTextContents();
    const firstSession = titles.findIndex((t) => t.startsWith('Go to '));
    expect(titles.slice(0, firstSession).every((t) => t.startsWith('Reply: '))).toBe(true);
    expect(titles[firstSession]).toMatch(/^Go to ~\/src\/(api-gateway|mobile-app)/);
    await app.page.keyboard.type('mobile');
    await app.page.keyboard.press('Alt+Enter');
    await expect(app.page.locator('.ow-sessions-sidebar .ow-row.is-selected')).toHaveAttribute('data-uid', 'DEMO-0007');
    await expect(app.page.locator('.ow-toast-msg', { hasText: '→ tab' })).toHaveCount(0);
    await app.page.keyboard.press('Meta+k');
    await app.page.keyboard.type('go to ~/src/data');
    await app.page.keyboard.press('Enter');
    await app.toast(/^→ tab 2\.1$/);
  });

  test('↑/↓ move the cursor; Esc closes; ⌘K toggles; no match message', async ({ app }) => {
    await app.page.keyboard.press('Meta+k');
    await app.page.keyboard.press('ArrowDown');
    await expect(app.page.locator('.ow-palette-item').nth(1)).toHaveClass(/is-active/);
    await app.page.keyboard.type('qqqqzz');
    await expect(app.page.locator('.ow-palette-empty')).toHaveText('No commands or sessions match “qqqqzz”');
    await app.page.keyboard.press('Escape');
    await expect(app.page.locator('.ow-palette')).toHaveCount(0);
    await app.page.keyboard.press('Meta+k');
    await app.page.keyboard.press('Meta+k');
    await expect(app.page.locator('.ow-palette')).toHaveCount(0);
  });
});
