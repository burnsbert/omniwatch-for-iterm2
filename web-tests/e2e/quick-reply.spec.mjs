// Quick reply (§3 P0): options, ⌥N, free text, the 409 stale_screen guard,
// and the Settings kill switch.
import { test, expect } from './fixtures.mjs';

test.describe('quick reply', () => {
  test('option buttons send the key with the screen hash; the agent leaves waiting', async ({ app }) => {
    await app.row('1.1').click();
    const bar = app.page.locator('.ow-preview-full .ow-reply');
    await expect(bar).toBeVisible();
    await expect(bar.locator('.ow-reply-q')).toHaveText('Do you want to proceed?');
    await expect(bar.locator('.ow-reply-opt')).toHaveCount(3);
    const st = await app.state();
    const req = app.page.waitForRequest((r) => r.url().endsWith('/sessions/DEMO-0001/reply'));
    await bar.locator('.ow-reply-opt').first().click();
    const body = JSON.parse((await req).postData());
    expect(body).toEqual({ text: '1', submit: false, expect_hash: st.sessions.find((s) => s.uid === 'DEMO-0001').screen_hash });
    await app.toast(/^Replied to deploy-fix$/);
    await app.step(2);
    await expect(app.row('1.1')).not.toHaveAttribute('data-state', 'waiting');
  });

  test('⌥1–⌥9 answer from the keyboard; Codex y/n options', async ({ app }) => {
    await app.row('2.2').click();
    const opts = app.page.locator('.ow-preview-full .ow-reply-opt kbd');
    await expect(opts.first()).toHaveText('y');
    const req = app.page.waitForRequest((r) => r.url().endsWith('/sessions/DEMO-0007/reply'));
    await app.page.keyboard.press('Alt+1');
    expect(JSON.parse((await req).postData()).text).toBe('y');
  });

  test('free text: i focuses the field, ⏎ submits with submit:true', async ({ app }) => {
    await app.row('1.1').click();
    await app.page.keyboard.press('i');
    const input = app.page.locator('.ow-preview-full .ow-reply-input');
    await expect(input).toBeFocused();
    const req = app.page.waitForRequest((r) => r.url().endsWith('/reply'));
    await input.fill('run it with --watch');
    await input.press('Enter');
    const body = JSON.parse((await req).postData());
    expect([body.text, body.submit]).toEqual(['run it with --watch', true]);
    await app.toast(/^Replied to/);
  });

  test('a stale screen hash gets 409 stale_screen from the real backend and a clear warning', async ({ app }) => {
    app.allow('409 POST /api/v1/sessions/DEMO-0001/reply');
    await app.page.route('**/sessions/DEMO-0001/reply', async (route) => {
      const body = JSON.parse(route.request().postData());
      await route.continue({ postData: JSON.stringify({ ...body, expect_hash: '00000000' }) });
    });
    await app.row('1.1').click();
    const resp = app.page.waitForResponse((r) => r.url().endsWith('/reply'));
    await app.page.locator('.ow-preview-full .ow-reply-opt').first().click();
    const r = await resp;
    expect(r.status()).toBe(409);
    expect((await r.json()).error.code).toBe('stale_screen');
    await app.toast(/screen changed before the reply was sent/);
    await expect(app.row('1.1')).toHaveAttribute('data-state', 'waiting');
  });

  test('turning quick reply off in Settings hides the bar', async ({ app }) => {
    await app.row('1.1').click();
    await expect(app.page.locator('.ow-preview-full .ow-reply')).toBeVisible();
    await app.page.keyboard.press('Meta+,');
    await app.page.locator('.ow-switch[aria-label="Reply from Omniwatch"]').click();
    await app.page.keyboard.press('Escape');
    await expect(app.page.locator('.ow-preview-full .ow-reply')).toBeHidden();
    await expect.poll(async () => (await app.prefs()).quick_reply).toBe(false);
  });
});
