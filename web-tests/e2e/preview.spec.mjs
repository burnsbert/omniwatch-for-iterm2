// Split view preview: header, screen, footer, debug rule, divider, list
// fallback + drawer, label editing, mute.
import { test, expect } from './fixtures.mjs';

test.describe('preview', () => {
  test('header shows path · label · agent · state + age with a state accent @P-40', async ({ app }) => {
    await app.row('1.1').click();
    const pv = app.page.locator('.ow-preview-full');
    await expect(pv.locator('.ow-pv-path')).toHaveText('~/src/api-gateway');
    await expect(pv.locator('.ow-pv-label .ow-pill')).toHaveText('deploy-fix');
    await expect(pv.locator('.ow-pv-meta .ow-chip')).toHaveText('Claude');
    await expect(pv.locator('.ow-pv-state-text')).toHaveText(/^Waiting \d+m$/);
    await expect(pv).toHaveAttribute('data-state', 'waiting');
  });

  test('footer says "live · updated just now" and offers Zoom and more actions @P-41', async ({ app }) => {
    await app.row('1.2').click();
    const foot = app.page.locator('.ow-preview-full .ow-pv-foot');
    await expect(foot.locator('.ow-pv-fresh')).toHaveText('live · updated just now');
    await foot.getByRole('button', { name: /Zoom/ }).click();
    await expect(app.page.locator('.ow-preview-zoom')).toBeVisible();
    await app.page.keyboard.press('Escape');
    await foot.getByRole('button', { name: 'More actions' }).click();
    await expect(app.page.getByRole('menu')).toBeVisible();
  });

  test('the screen shows the full text pinned to the bottom @P-42', async ({ app }) => {
    const st = await app.state();
    await app.row('1.1').click();
    const pre = app.page.locator('.ow-preview-full .ow-screen');
    await expect(pre).toHaveText(st.screens['DEMO-0001'].text.replace(/\s+$/u, ''));
    const pinned = await pre.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 8);
    expect(pinned).toBe(true);
  });

  test('Settings › Advanced "Show classifier rule" adds rule: … to the footer @P-43', async ({ app }) => {
    await app.patch({ debug_rule: true });
    await app.row('1.1').click();
    await expect(app.page.locator('.ow-preview-full .ow-pv-rule')).toHaveText(/^rule: \S+/);
  });

  test('divider: drag and < > keys resize the split in 5 % steps, persisted @P-38', async ({ app }) => {
    await app.row('1.1').click();
    await app.page.keyboard.press('.');
    await app.toast(/^list pane 47% of width$/);
    await expect.poll(async () => (await app.prefs()).split_ratio).toBe(0.47);
    await app.page.keyboard.press(',');
    await app.page.keyboard.press(',');
    await expect.poll(async () => (await app.prefs()).split_ratio).toBe(0.37);
    // Measure the divider only after the layout has moved to the new ratio.
    await expect.poll(() => app.page.locator('#app').evaluate((el) => el.style.getPropertyValue('--ow-split'))).toBe('0.37');
    const div = app.page.locator('#ow-divider');
    const box = await div.boundingBox();
    await app.page.mouse.move(box.x + 2, 400);
    await app.page.mouse.down();
    await app.page.mouse.move(720, 400, { steps: 5 });
    await app.page.mouse.up();
    await expect.poll(async () => (await app.prefs()).split_ratio).toBe(0.5);
  });

  test('below 900 px split falls back to the list view @P-38', async ({ app }) => {
    await app.page.setViewportSize({ width: 860, height: 800 });
    await expect(app.page.locator('#app')).toHaveAttribute('data-layout', 'list');
    await expect(app.page.locator('.ow-sessions-table')).toBeVisible();
    await expect.poll(async () => (await app.prefs()).view).toBe('split');
  });

  test('list view: table columns and a resizable bottom preview drawer @P-44', async ({ app }) => {
    await app.page.keyboard.press('Meta+2');
    await expect(app.page.locator('.ow-thead .ow-th')).toHaveText(['State', 'Agent', 'Tab', 'Path', 'Name / label', 'Last 8 h', 'Age', 'Color']);
    await app.page.locator('.ow-trow').nth(1).click();
    const drawer = app.page.locator('.ow-preview-drawer .ow-screen');
    await expect(drawer).toBeVisible();
    const h0 = (await drawer.boundingBox()).height;
    const handle = app.page.locator('.ow-drawer-handle');
    const hb = await handle.boundingBox();
    await app.page.mouse.move(hb.x + hb.width / 2, hb.y + 4);
    await app.page.mouse.down();
    await app.page.mouse.move(hb.x + hb.width / 2, hb.y - 160, { steps: 5 });
    await app.page.mouse.up();
    expect((await drawer.boundingBox()).height).toBeGreaterThan(h0 + 80);
    await app.page.locator('.ow-th', { hasText: 'Path' }).click();
    await expect.poll(async () => (await app.prefs()).sort).toBe('path');
  });

  test('l edits the label inline: ⏎ saves (trimmed, Unicode), empty removes, Esc cancels @P-61', async ({ app }) => {
    await app.row('2.1').click();
    await app.page.keyboard.press('l');
    const input = app.page.locator('.ow-preview-full .ow-label-input');
    await input.fill('  pipeline ✨  ');
    await input.press('Enter');
    await expect(app.row('2.1').locator('.ow-pill')).toHaveText('pipeline ✨');
    await expect.poll(async () => (await app.state()).sessions.find((s) => s.uid === 'DEMO-0006').label).toBe('pipeline ✨');
    await app.page.keyboard.press('l');
    await input.fill('ignored');
    await input.press('Escape');
    await expect(app.row('2.1').locator('.ow-pill')).toHaveText('pipeline ✨');
    await app.page.keyboard.press('l');
    await input.fill('');
    await input.press('Enter');
    await expect.poll(async () => (await app.state()).sessions.find((s) => s.uid === 'DEMO-0006').label).toBe('');
  });

  test('mute: the bell button mutes/unmutes; muted rows dim and say so', async ({ app }) => {
    await app.row('1.2').click();
    await app.page.locator('.ow-preview-full .ow-icon-btn[aria-label^="Mute"]').click();
    await app.toast(/muted$/);
    await expect(app.row('1.2')).toHaveClass(/is-muted/);
    expect(await app.row('1.2').getAttribute('aria-label')).toMatch(/muted/);
    await app.page.locator('.ow-preview-full .ow-icon-btn[aria-label^="Unmute"]').click();
    await expect.poll(async () => (await app.state()).sessions.find((s) => s.uid === 'DEMO-0002').muted).toBe(false);
  });
});
