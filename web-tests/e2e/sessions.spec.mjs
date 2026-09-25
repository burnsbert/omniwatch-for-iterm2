// Session list (sidebar): row content, tints, ages, groups, selection,
// visit/goto, mouse, dashboard detection, transitions.
import { test, expect } from './fixtures.mjs';

test.describe('session list', () => {
  test('rows show tab label, path, name/label pill, agent chip, color dot @P-22 @P-23 @P-24 @P-28 @P-34 @P-36', async ({ app }) => {
    const st = await app.state();
    const s = st.sessions.find((x) => x.uid === 'DEMO-0001');
    const row = app.row(s.tab_label);
    await expect(row.locator('.ow-row-tab')).toHaveText(s.tab_label);
    await expect(row.locator('.ow-row-path')).toHaveText(s.path_display);
    await expect(row.locator('.ow-pill')).toHaveText(s.label);
    await expect(row.locator('.ow-chip')).toHaveText('Claude');
    await expect(row.locator('.ow-chip')).toHaveAttribute('data-agent', 'claude');
    await expect(row.locator('.ow-dot')).toHaveAttribute('data-color', 'blue');
    await expect(row.locator('.ow-dot')).toHaveAttribute('title', 'blue · api-gateway');
    const codex = app.row('2.2');
    await expect(codex.locator('.ow-chip')).toHaveText('Codex');
    const shell = app.row('1.4');
    await expect(shell.locator('.ow-chip')).toBeHidden();
    await expect(app.page.locator('.ow-sessions-sidebar .ow-row')).toHaveCount(st.sessions.length);
  });

  test('state icons are distinct shapes with text in the accessible name @P-27', async ({ app }) => {
    for (const [tab, state, word] of [['1.1', 'waiting', 'Waiting'], ['1.2', 'busy', 'Busy'], ['2.1', 'idle', 'Idle'], ['1.4', 'active', 'Output']]) {
      const row = app.row(tab);
      await expect(row).toHaveAttribute('data-state', state);
      await expect(row.locator(`svg.ow-state-${state}`)).toHaveCount(1);
      expect(await row.getAttribute('aria-label')).toMatch(new RegExp(`^${word}`));
    }
  });

  test('waiting rows are tinted amber with an age; others show idle age @P-29 @P-30', async ({ app }) => {
    await expect(app.row('1.1')).toHaveAttribute('data-tone', 'waiting');
    await expect(app.row('1.1').locator('.ow-row-age')).toHaveText(/^wait \d+m$/);
    await expect(app.row('1.1').locator('.ow-row-age')).toHaveClass(/is-waiting/);
    await expect(app.row('1.2').locator('.ow-row-age')).toHaveText('');
    // Idle ages appear once the screen has been unchanged for ≥ 60 s.
    await expect(app.row('2.1').locator('.ow-row-age')).toHaveText('');
    await app.step(120);
    await app.page.clock.setFixedTime(new Date((1790000000 + 120) * 1000));
    await expect(app.row('2.1').locator('.ow-row-age')).toHaveText(/^idle 2m$/);
  });

  test('window group headers appear only with natural sort and >1 window @P-35 @P-39', async ({ app }) => {
    await expect(app.page.locator('.ow-sessions-sidebar .ow-group')).toHaveCount(2);
    await expect(app.page.locator('.ow-sessions-sidebar .ow-group-label').first()).toHaveText('Window 1');
    await expect(app.page.locator('.ow-listhead-sort')).toHaveText('sort: natural');
    await app.page.keyboard.press('s');
    await expect(app.page.locator('.ow-listhead-sort')).toHaveText('sort: attention');
    await expect(app.page.locator('.ow-sessions-sidebar .ow-group')).toHaveCount(0);
    await app.page.keyboard.press('/');
    await app.page.keyboard.type('web');
    await expect(app.page.locator('.ow-filter-chip')).toHaveText(/^“web” · \d+ of 11$/);
  });

  test('selection follows the uid across a resort and snaps back when filtered out @P-55', async ({ app }) => {
    await app.row('2.1').click();
    await app.page.keyboard.press('s');
    await expect(app.page.locator('.ow-sessions-sidebar .ow-row.is-selected')).toHaveAttribute('data-uid', 'DEMO-0006');
    await app.page.keyboard.press('/');
    await app.page.keyboard.type('mobile');
    await expect(app.page.locator('.ow-sessions-sidebar .ow-row.is-selected')).toHaveAttribute('data-uid', 'DEMO-0007');
    await app.page.keyboard.press('Enter');
    await app.page.keyboard.press('j');
    await app.page.keyboard.press('k');
    await expect(app.page.locator('.ow-sessions-sidebar .ow-row')).toHaveCount(1);
  });

  test('selecting a waiting row visits it (attention clears after the debounce) @P-56 @P-12', async ({ app }) => {
    let st = await app.state();
    expect(st.sessions.find((s) => s.uid === 'DEMO-0007').attention).toBe(true);
    await app.row('2.2').click();
    await expect.poll(async () => (await app.state()).sessions.find((s) => s.uid === 'DEMO-0007').attention).toBe(false);
    st = await app.state();
    expect(st.sessions.find((s) => s.uid === 'DEMO-0007').state).toBe('waiting');
  });

  test('double-click / ⏎ / g go to the session and toast "→ tab N" @P-57 @P-72', async ({ app }) => {
    await app.row('1.2').dblclick();
    await app.toast(/^→ tab 1\.2$/);
    await app.row('2.1').click();
    await app.page.keyboard.press('g');
    await app.toast(/^→ tab 2\.1$/);
    await app.page.keyboard.press('Enter');
    await expect(app.page.locator('.ow-toast-msg').filter({ hasText: '→ tab 2.1' })).toHaveCount(2);
  });

  test('right-click opens the session context menu; the wheel scrolls instead of moving the selection @P-72', async ({ app }) => {
    await app.row('1.2').click({ button: 'right' });
    const menu = app.page.getByRole('menu', { name: /Actions for ~\/src\/billing/ });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Go to session/ })).toBeVisible();
    await app.page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    const before = await app.page.locator('.ow-sessions-sidebar .ow-row.is-selected').getAttribute('data-uid');
    await app.page.mouse.move(300, 500);
    await app.page.mouse.wheel(0, 200);
    await expect(app.page.locator('.ow-sessions-sidebar .ow-row.is-selected')).toHaveAttribute('data-uid', before);
  });

  test('the grid shows agent sessions only; plain shells and dashboards stay in the list @P-45 @P-50', async ({ app }) => {
    // The demo (after the rebrand) has no Ultrawatch dashboard session; dashboard
    // detection and its grid exclusion are unit-tested (viewmodel gridSessions).
    const st = await app.state();
    await app.page.keyboard.press('Meta+3');
    const agents = st.sessions.filter((s) => s.agent && !s.is_dashboard);
    await expect(app.page.locator('.ow-tile')).toHaveCount(agents.length);
    await app.page.keyboard.press('Meta+1');
    await expect(app.page.locator('.ow-sessions-sidebar .ow-row')).toHaveCount(st.sessions.length);
  });

  test('a busy→waiting transition flashes the row and toasts "is waiting for your input" @P-31 @P-32 @P-24', async ({ app }) => {
    await app.row('2.1').click();
    await app.step(6);
    await expect(app.row('1.2')).toHaveAttribute('data-state', 'waiting');
    await expect(app.row('1.2')).toHaveClass(/is-flash/);
    await app.toast(/^◉ ~\/src\/billing is waiting for your input$/);
    await expect(app.page.locator('#ow-live-polite')).toHaveText(/is waiting for your input/);
  });
});
