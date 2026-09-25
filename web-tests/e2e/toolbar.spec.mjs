// Toolbar: summary + waiting pill, status chip, filter, sort, views, stats chip.
import { test, expect } from './fixtures.mjs';

test.describe('toolbar', () => {
  test('summary text and waiting pill match the backend summary @P-25', async ({ app }) => {
    const st = await app.state();
    await expect(app.page.locator('.ow-summary')).toHaveText(`${st.summary.tabs} tabs · ${st.summary.agents} agents`);
    await expect(app.page.locator('.ow-pill-count')).toHaveText(String(st.summary.waiting));
    await expect(app.page.locator('.ow-waiting-pill')).toHaveClass(/is-hot/);
    await expect(app.page).toHaveTitle(`Omniwatch — ${st.summary.waiting} waiting`);
  });

  test('clicking the waiting pill selects the longest-waiting session @P-25 @P-58', async ({ app }) => {
    const st = await app.state();
    const order = st.summary.waiting_uids; // longest wait first
    const selected = app.page.locator('.ow-sessions-sidebar .ow-row.is-selected');
    await app.row(st.sessions.find((s) => s.state !== 'waiting').tab_label).click();
    await app.page.locator('.ow-waiting-pill').click();
    await expect(selected).toHaveAttribute('data-uid', order[0]);
    await app.page.locator('.ow-waiting-pill').click();
    await expect(selected).toHaveAttribute('data-uid', order[1]);
    await app.page.locator('.ow-waiting-pill').click();
    await expect(selected).toHaveAttribute('data-uid', order[0], { timeout: 3000 });
  });
});
