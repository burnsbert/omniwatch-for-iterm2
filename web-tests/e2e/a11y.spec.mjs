// Accessibility (§2.7): roles, names, live regions, dialog focus trap.
import { test, expect } from './fixtures.mjs';

test.describe('accessibility', () => {
  test('landmarks and widgets expose roles and accessible names', async ({ app }) => {
    const p = app.page;
    await expect(p.getByRole('toolbar', { name: 'Omniwatch toolbar' })).toBeVisible();
    const lb = p.getByRole('listbox', { name: 'Sessions' }).first();
    await expect(lb).toBeVisible();
    await expect(lb.getByRole('option')).toHaveCount(11);
    await expect(lb.getByRole('option', { name: /^Waiting \d+ minutes?, Claude Code, tab 1\.1, ~\/src\/api-gateway, label deploy-fix/ })).toBeVisible();
    await expect(lb).toHaveAttribute('aria-activedescendant', /^ow-row-/);
    await expect(p.getByRole('radiogroup', { name: 'View' })).toBeVisible();
    await expect(p.locator('#ow-live-polite')).toHaveAttribute('aria-live', 'polite');
    await expect(p.locator('#ow-live-assertive')).toHaveAttribute('aria-live', 'assertive');
    await p.keyboard.press('Meta+3');
    const grid = p.getByRole('grid', { name: 'Session grid' });
    await expect(grid.getByRole('gridcell')).toHaveCount(5);
  });

  test('dialogs are modal, named, and trap Tab focus', async ({ app }) => {
    await app.page.keyboard.press('Meta+,');
    const dlg = app.page.getByRole('dialog', { name: 'Settings' });
    await expect(dlg).toHaveAttribute('aria-modal', 'true');
    for (let i = 0; i < 40; i += 1) await app.page.keyboard.press('Tab');
    expect(await app.page.evaluate(() => !!document.activeElement.closest('.ow-dialog'))).toBe(true);
  });

  test('state is never color-only: every row has an icon and a spoken state', async ({ app }) => {
    const names = await app.page.locator('.ow-sessions-sidebar .ow-row').evaluateAll((els) => els.map((e) => [e.getAttribute('aria-label'), !!e.querySelector('svg.ow-state')]));
    for (const [name, hasIcon] of names) {
      expect(hasIcon).toBe(true);
      expect(name).toMatch(/^(Waiting|Busy|Idle|Output|Quiet|Unknown)/);
    }
  });
});
