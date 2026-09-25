// iTerm2 actions: new tab, close tab, refresh, reveal / open in, go-to failure.
import { test, expect } from './fixtures.mjs';

test.describe('actions', () => {
  test('n opens a new tab: "opening new tab…" and a new session appears @P-66', async ({ app }) => {
    const before = (await app.state()).sessions.length;
    await app.row('1.1').click();
    await app.page.keyboard.press('n');
    await app.toast(/^opening new tab…$/);
    await expect.poll(async () => (await app.state()).sessions.length).toBe(before + 1);
    await expect(app.page.locator('.ow-sessions-sidebar .ow-row')).toHaveCount(before + 1);
  });

  test('x confirms with the tab name; y closes that tab by uid and the session disappears @P-67 @P-13', async ({ app }) => {
    await app.row('2.1').click();
    await app.page.keyboard.press('x');
    const dlg = app.page.getByRole('alertdialog');
    // TUI parity: the name is display_name (label, else session name), else the path.
    await expect(dlg.locator('.ow-confirm-title')).toHaveText('Close tab 2.1 (node)?');
    await app.page.keyboard.press('y');
    await app.toast(/^closing tab 2\.1…$/);
    await expect.poll(async () => (await app.state()).sessions.some((s) => s.uid === 'DEMO-0006')).toBe(false);
    await expect(app.page.locator('.ow-sessions-sidebar .ow-row[data-uid="DEMO-0006"]')).toHaveCount(0);
    expect((await app.state()).screens['DEMO-0006']).toBeUndefined();
  });

  test('r refreshes: one "refreshing…" toast (the server echo is deduplicated) @P-68', async ({ app }) => {
    await app.row('1.1').click();
    await app.page.keyboard.press('r');
    await app.toast(/^refreshing…$/);
    await app.page.waitForTimeout(400);
    await expect(app.page.locator('.ow-toast-msg', { hasText: 'refreshing…' })).toHaveCount(1);
  });

  test('open in: o reveals in Finder, e opens the editor, y copies the path (reveal action events)', async ({ app }) => {
    await app.patch({ editor: 'zed' });
    await app.row('1.1').click();
    await app.page.keyboard.press('o');
    await app.toast(/^revealed ~\/src\/api-gateway in Finder$/);
    await app.page.keyboard.press('e');
    await app.toast(/^opened ~\/src\/api-gateway in zed$/);
    await app.page.keyboard.press('y');
    await app.toast(/^copied ~\/src\/api-gateway$/);
    await app.row('1.1').click({ button: 'right' });
    await expect(app.page.getByRole('menuitem', { name: /Finder/ })).toBeEnabled();
  });

  test('go to a session that vanished: "goto failed: session not found" @P-57', async ({ app }) => {
    app.allow('404 POST /api/v1/sessions/DEMO-0006/goto');
    await app.row('2.1').click();
    await app.page.route('**/sessions/DEMO-0006/goto', (route) => route.continue({ url: route.request().url().replace('DEMO-0006', 'DEMO-GONE') }));
    app.allow('404 POST /api/v1/sessions/DEMO-GONE/goto');
    await expect(app.row('2.1')).toHaveClass(/is-selected/);
    const resp = app.page.waitForResponse((r) => r.url().endsWith('/DEMO-GONE/goto'));
    await app.page.keyboard.press('g');
    expect((await resp).status()).toBe(404);
    await app.toast(/^goto failed: session not found$/);
  });
});
