// Rebrand guard: the rendered demo UI never says "Ultrawatch" (any case) —
// in any view, overlay, sheet, menu, tooltip-bearing attribute, or scenario.
// (Ultrawatch lives on only in code comments and the migration docs.)
import { test, expect } from './fixtures.mjs';

async function visibleBrandText(page) {
  return page.evaluate(() => {
    const hits = [];
    if (/ultrawatch/i.test(document.body.innerText)) hits.push('text');
    for (const el of document.querySelectorAll('[title], [aria-label], [placeholder]')) {
      for (const a of ['title', 'aria-label', 'placeholder']) {
        const v = el.getAttribute(a);
        if (v && /ultrawatch/i.test(v)) hits.push(`${a}="${v}"`);
      }
    }
    if (/ultrawatch/i.test(document.title)) hits.push('document.title');
    return hits;
  });
}

test.describe('branding', () => {
  test('no "Ultrawatch" anywhere in the default demo UI', async ({ app }) => {
    const p = app.page;
    const seen = {};
    const check = async (where) => { seen[where] = await visibleBrandText(p); };
    await check('split');
    await app.row('1.1').click();
    await check('split+selection');
    for (const [key, where] of [['Meta+2', 'list'], ['Meta+3', 'grid'], ['Meta+1', 'split again']]) {
      await p.keyboard.press(key);
      await check(where);
    }
    await p.keyboard.press(' ');
    await check('zoom');
    await p.keyboard.press('Escape');
    for (const [key, where] of [['u', 'usage'], ['?', 'shortcuts'], ['Meta+,', 'settings'], ['Meta+k', 'palette'], ['t', 'timeline']]) {
      await p.keyboard.press(key);
      await check(where);
      await p.keyboard.press('Escape');
    }
    await p.locator('.ow-stats-chip').click();
    await check('stats');
    await p.keyboard.press('Escape');
    await p.keyboard.press('p');
    await app.row('2.3').click({ button: 'right' });
    await check('projects + context menu');
    await p.keyboard.press('Escape');
    await app.page.evaluate(() => window.omniwatch.command('onboarding.open'));
    await check('onboarding');
    expect(Object.fromEntries(Object.entries(seen).filter(([, v]) => v.length))).toEqual({});
  });

  for (const scenario of ['empty', 'not-running', 'not-authorized', 'many', 'usage-errors']) {
    test.describe(`scenario ${scenario}`, () => {
      test.use({ appOptions: { scenario, prefs: {}, open: true, allowHttp: [] } });
      test('no "Ultrawatch" text', async ({ app }) => {
        expect(await visibleBrandText(app.page)).toEqual([]);
        await app.page.keyboard.press('Meta+3');
        expect(await visibleBrandText(app.page)).toEqual([]);
      });
    });
  }
});
