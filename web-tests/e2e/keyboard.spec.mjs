// Keyboard parity (§2.5, P-83): every binding in keymap.js — the single
// source for keys — must reach its command. Driven from BINDINGS, so a new
// binding is covered automatically. Plus the shortcut sheet (P-48), the
// legend (P-52) and Esc unwinding (P-73).
import { test, expect } from './fixtures.mjs';
import { BINDINGS, formatBinding } from '../../omniwatch/web/js/keymap.js';

function pwKey(b) {
  const mods = [];
  if (b.ctrl) mods.push('Control');
  if (b.alt) mods.push('Alt');
  if (b.shift) mods.push('Shift');
  if (b.meta) mods.push('Meta');
  const key = b.key === ' ' ? 'Space' : b.key;
  return [...mods, key].join('+');
}

async function settle(app) {
  // Leave no text field, modal, menu or overlay behind for the next key.
  for (let i = 0; i < 4; i += 1) {
    const busy = await app.page.evaluate(() => {
      const a = document.activeElement;
      if (a && a.matches && a.matches('input, textarea, select')) a.blur();
      delete document.documentElement.dataset.owKeyCommand;
      return !!document.querySelector('.ow-modal-wrap:not(.is-leaving), .ow-menu') || !document.getElementById('ow-body-overlay').hidden;
    });
    if (!busy) return;
    await app.page.keyboard.press('Escape');
  }
  await app.clearKeyCommand();
}

test.describe('keyboard', () => {
  test('every keymap.js binding dispatches its command @P-83 @P-37 @P-58 @P-59 @P-60 @P-63 @P-64 @P-66 @P-67 @P-68 @P-69 @P-70 @P-73', async ({ app }) => {
    test.setTimeout(90000);
    // ⌥1…⌥9 fire real replies back to back; later ones may meet the guard (409/422).
    app.allow(/^(409|422) POST \/api\/v1\/sessions\/[^/]+\/reply$/);
    await app.row('1.1').click();
    const misses = [];
    let n = 0;
    for (const [command, bindings] of Object.entries(BINDINGS)) {
      for (const b of bindings) {
        await settle(app);
        await app.page.keyboard.press(pwKey(b));
        const got = await app.lastKeyCommand();
        n += 1;
        if (got !== command) misses.push(`${formatBinding(b)} (${pwKey(b)}) → ${got}, expected ${command}`);
      }
    }
    expect(misses, `${n} bindings checked`).toEqual([]);
    expect(n).toBeGreaterThan(70);
  });

  test('? opens the shortcut sheet grouped Navigate / Act / View / System with the state legend; Esc closes @P-48 @P-52', async ({ app }) => {
    await app.page.keyboard.press('?');
    const sheet = app.page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('.ow-keys-section h3')).toHaveText(['Navigate', 'Act', 'View', 'System']);
    await expect(sheet.locator('.ow-legend-item')).toHaveText(['Waiting for you', 'Working', 'Idle agent', 'New output', 'Quiet shell']);
    await app.page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await app.page.keyboard.press('Meta+/');
    await expect(sheet).toBeVisible();
  });

  test('Esc unwinds text entry → overlay → filter, and never quits @P-73', async ({ app }) => {
    await app.page.keyboard.press('/');
    await app.page.keyboard.type('api');
    await app.page.keyboard.press('Enter');
    await app.row('1.1').click();
    await app.page.keyboard.press(' ');
    await expect(app.page.locator('.ow-preview-zoom')).toBeVisible();
    await app.page.keyboard.press('Escape');
    await expect(app.page.locator('.ow-preview-zoom')).toBeHidden();
    await expect(app.page.locator('.ow-search-input')).toHaveValue('api');
    await app.page.keyboard.press('Escape');
    await expect(app.page.locator('.ow-search-input')).toHaveValue('');
    await app.page.keyboard.press('Escape');
    await app.page.keyboard.press('q');
    await expect(app.page.locator('.ow-row').first()).toBeVisible();
  });

  test('/ filters live with a match count; Esc clears; ⏎ keeps @P-59', async ({ app }) => {
    await app.page.keyboard.press('/');
    await app.page.keyboard.type('mbl');
    await expect(app.page.locator('.ow-search-count')).toHaveText('1 of 11');
    await expect(app.page.locator('.ow-sessions-sidebar .ow-row')).toHaveCount(1);
    await app.page.keyboard.press('Enter');
    await expect(app.page.locator('.ow-search-input')).not.toBeFocused();
    await expect(app.page.locator('.ow-sessions-sidebar .ow-row')).toHaveCount(1);
    await app.page.keyboard.press('Meta+f');
    await app.page.keyboard.press('Escape');
    await expect(app.page.locator('.ow-sessions-sidebar .ow-row')).toHaveCount(11);
  });

  test('s cycles natural → attention → agents → activity → path with a toast, persisted @P-60', async ({ app }) => {
    for (const s of ['attention', 'agents', 'activity', 'path', 'natural']) {
      await app.page.keyboard.press('s');
      await app.toast(new RegExp(`^sort: ${s}$`));
    }
    await app.page.keyboard.press('s');
    await expect.poll(async () => (await app.prefs()).sort).toBe('attention');
    await expect.poll(() => app.page.locator('.ow-sessions-sidebar .ow-row').evaluateAll((els) => els.slice(0, 3).map((e) => e.dataset.state)))
      .toEqual(['waiting', 'waiting', 'busy']);
    const first = await app.page.locator('.ow-sessions-sidebar .ow-row').nth(2).getAttribute('data-uid');
    expect(first).toBe('DEMO-0003'); // the stalled agent leads the busy tier
  });

  test('v / ⌘1 ⌘2 ⌘3 switch views; the choice is persisted @P-37', async ({ app }) => {
    await app.page.keyboard.press('v');
    await expect(app.page.locator('#app')).toHaveAttribute('data-layout', 'list');
    await app.page.keyboard.press('v');
    await expect(app.page.locator('#app')).toHaveAttribute('data-layout', 'grid');
    await app.page.keyboard.press('Meta+1');
    await expect(app.page.locator('#app')).toHaveAttribute('data-layout', 'split');
    await app.page.getByRole('radio', { name: 'Grid view' }).click();
    await expect.poll(async () => (await app.prefs()).view).toBe('grid');
    await app.page.reload();
    await expect(app.page.locator('#app')).toHaveAttribute('data-layout', 'grid');
  });
});
