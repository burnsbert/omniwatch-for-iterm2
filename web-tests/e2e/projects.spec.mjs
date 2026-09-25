// Projects panel (P-63/P-64/P-65).
import { test, expect } from './fixtures.mjs';

test.describe('projects', () => {
  test('p toggles the panel (persisted); 5 slots in blue, purple, green, red, yellow @P-63', async ({ app }) => {
    await app.page.keyboard.press('p');
    await expect(app.page.locator('.ow-slot')).toHaveCount(5);
    const colors = await app.page.locator('.ow-slot .ow-dot').evaluateAll((els) => els.map((e) => e.dataset.color));
    expect(colors).toEqual(['blue', 'purple', 'green', 'red', 'yellow']);
    await expect(app.page.locator('.ow-slot-name').first()).toHaveText('api-gateway');
    await expect.poll(async () => (await app.prefs()).projects_open).toBe(true);
    await app.page.keyboard.press('p');
    await expect(app.page.locator('.ow-slots')).toBeHidden();
  });

  test('↑ from the top row enters the slots; ⏎ edits; ⏎ saves, Esc cancels; click edits @P-63', async ({ app }) => {
    await app.page.keyboard.press('p');
    await app.row('1.1').click();
    await app.page.keyboard.press('ArrowUp');
    await expect(app.page.locator('.ow-slot[data-slot="5"]')).toHaveClass(/is-kbd-focus/);
    await app.page.keyboard.press('ArrowUp');
    await app.page.keyboard.press('Enter');
    const input = app.page.locator('.ow-slot[data-slot="4"] .ow-slot-input');
    await expect(input).toBeFocused();
    await input.fill('ops');
    await input.press('Enter');
    await expect(app.page.locator('.ow-slot[data-slot="4"] .ow-slot-name')).toHaveText('ops');
    await expect.poll(async () => (await app.state()).projects[3].name).toBe('ops');
    await app.page.locator('.ow-slot[data-slot="5"] .ow-slot-btn').click();
    await app.page.locator('.ow-slot[data-slot="5"] .ow-slot-input').fill('nope');
    await app.page.locator('.ow-slot[data-slot="5"] .ow-slot-input').press('Escape');
    await expect(app.page.locator('.ow-slot[data-slot="5"] .ow-slot-name')).toHaveText('Unnamed');
  });

  test('1–5 color the tab to the project color, 0 clears it @P-64', async ({ app }) => {
    await app.row('2.1').click();
    await app.page.keyboard.press('2');
    await app.toast(/^tab 2\.1 → purple \(billing\)$/);
    await expect.poll(async () => (await app.state()).sessions.find((s) => s.uid === 'DEMO-0006').tab_color).toBe('purple');
    await expect(app.row('2.1').locator('.ow-dot')).toHaveAttribute('data-color', 'purple');
    await app.page.keyboard.press('0');
    await app.toast(/^tab 2\.1: color cleared$/);
    await expect.poll(async () => (await app.state()).sessions.find((s) => s.uid === 'DEMO-0006').tab_color).toBe(null);
  });

  test('drag a row onto a project slot to color its tab; the context menu offers the same @P-64', async ({ app }) => {
    await app.page.keyboard.press('p');
    await app.row('2.1').dragTo(app.page.locator('.ow-slot[data-slot="3"]'));
    await expect.poll(async () => (await app.state()).sessions.find((s) => s.uid === 'DEMO-0006').tab_color).toBe('green');
    await app.row('2.1').click({ button: 'right' });
    await app.page.getByRole('menuitemradio', { name: /billing/ }).click();
    await expect.poll(async () => (await app.state()).sessions.find((s) => s.uid === 'DEMO-0006').tab_color).toBe('purple');
    await app.page.keyboard.press('0');
  });

  test('c asks before clearing all five names @P-65', async ({ app }) => {
    await app.page.keyboard.press('c');
    const dlg = app.page.getByRole('alertdialog', { name: 'Confirm' });
    await expect(dlg).toContainText('Clear all 5 project names?');
    await app.page.keyboard.press('n');
    await expect(dlg).toBeHidden();
    expect((await app.state()).projects[0].name).toBe('api-gateway');
    await app.page.keyboard.press('c');
    await app.page.keyboard.press('y');
    await app.toast(/^projects cleared$/);
    await expect.poll(async () => (await app.state()).projects.every((p) => !p.name)).toBe(true);
  });
});
