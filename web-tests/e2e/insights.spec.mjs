// v1 insights: activity timeline, blocked-on-you stats, stall detection.
import { test, expect } from './fixtures.mjs';

test.describe('insights', () => {
  test('timeline: 48-bucket ribbon in rows and preview; t opens the 8 h history with segment tooltips', async ({ app }) => {
    await app.row('1.1').click();
    await expect(app.page.locator('.ow-preview-full .ow-pv-ribbon .ow-rb')).toHaveCount(48);
    await expect(app.row('1.1').locator('.ow-ribbon-xs .ow-rb')).toHaveCount(48);
    await expect(app.row('1.4').locator('.ow-ribbon-xs')).toBeHidden();
    await app.page.keyboard.press('t');
    const sheet = app.page.getByRole('dialog', { name: 'Activity timeline' });
    await expect(sheet.locator('.ow-hist-seg').first()).toBeVisible();
    const hist = (await app.api('GET', '/api/v1/sessions/DEMO-0001/history')).json;
    await expect(sheet.locator('.ow-hist-seg')).toHaveCount(hist.segments.length);
    await expect(sheet.locator('.ow-hist-seg').first()).toHaveAttribute('title', /^(Busy|Idle|Waiting) · \d+:\d+[ap]m–/);
    await expect(sheet.locator('.ow-hist-transitions')).toHaveText(`${hist.transitions} state changes`);
  });

  test('blocked on you: the chip and card match /stats plus the open waits', async ({ app }) => {
    const st = await app.state();
    const live = st.stats.active.reduce((a, x) => a + (st.server_time - x.since), 0);
    const mins = Math.floor((st.stats.waiting_seconds + live) / 60);
    await expect(app.page.locator('.ow-stats-main')).toHaveText(`${mins} min blocked`);
    await app.page.locator('.ow-stats-chip').click();
    const card = app.page.getByRole('dialog', { name: 'Blocked on you today' });
    await expect(card.locator('.ow-st-hero-num')).toHaveText(`${mins} min`);
    await expect(card.locator('.ow-st-tile').nth(1).locator('.ow-st-value')).toHaveText(String(st.stats.answered));
    await expect(card.locator('.ow-st-row')).toHaveCount(st.stats.active.length);
    await card.locator('.ow-st-row').last().click();
    await expect(card).toBeHidden();
    await expect(app.page.locator('.ow-sessions-sidebar .ow-row.is-selected')).toHaveAttribute('data-uid', st.stats.active.at(-1).uid);
  });

  test('a finished wait updates the stats via the stats event', async ({ app }) => {
    const before = (await app.state()).stats;
    const s = (await app.state()).sessions.find((x) => x.uid === 'DEMO-0001');
    await app.api('POST', '/api/v1/sessions/DEMO-0001/reply', { text: '1', expect_hash: s.screen_hash });
    await app.step(2);
    await expect.poll(async () => (await app.state()).stats.answered).toBe(before.answered + 1);
    await app.page.locator('.ow-stats-chip').click();
    await expect(app.page.locator('.ow-st-tile').nth(1).locator('.ow-st-value')).toHaveText(String(before.answered + 1));
  });

  test('stalled: chip on the row and preview; a new episode toasts; 0 minutes turns it off', async ({ app }) => {
    await expect(app.row('1.3').locator('.ow-stall-chip')).toHaveText(/^Stalled\? \d+m$/);
    expect(await app.row('1.3').getAttribute('aria-label')).toMatch(/possibly stalled for \d+ minutes/);
    await app.row('1.3').click();
    await expect(app.page.locator('.ow-preview-full .ow-stall-chip')).toBeVisible();
    await app.patch({ stall_minutes: 120 });
    await app.step(0);
    await expect(app.row('1.3').locator('.ow-stall-chip')).toBeHidden();
    await app.patch({ stall_minutes: 10 });
    await app.step(1);
    await app.toast(/^~\/src\/web-app may be stalled — no screen change for \d+m$/);
    await app.patch({ stall_minutes: 0 });
    await app.step(0);
    await expect(app.page.locator('.ow-sessions-sidebar .ow-stall-chip:visible')).toHaveCount(0);
  });
});
