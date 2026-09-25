// Guard: test browsers must never make a sound (they reach the Mac's speakers
// even headless). Every context gets the silent WebAudio/<audio> stub, and
// navigator.webdriver is true in both engines, so main.js's playChime()
// stopgap is known to cover WebKit too.
import { test, expect } from './fixtures.mjs';

test('audio is stubbed and navigator.webdriver is set in this engine', async ({ app }) => {
  const r = await app.page.evaluate(async () => {
    const before = window.__owChimes || 0;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    osc.connect(ctx.createGain()).connect(ctx.destination);
    osc.start();
    await document.createElement('audio').play();
    return {
      webdriver: navigator.webdriver === true,
      muted: window.__owAudioMuted === true,
      stubName: (window.AudioContext && window.AudioContext.name) || '',
      counted: (window.__owChimes || 0) - before,
    };
  });
  expect(r).toEqual({ webdriver: true, muted: true, stubName: 'SilentAudioContext', counted: 2 });
});

test('the app\'s chime paths still run but stay silent (sound toggle preview + attention chime)', async ({ app }) => {
  const before = await app.page.evaluate(() => window.__owChimes || 0);
  await app.page.keyboard.press('b');
  await app.toast(/^sound on attention on$/);
  await expect.poll(() => app.page.evaluate(() => window.__owChimes || 0)).toBeGreaterThan(before);
  const mid = await app.page.evaluate(() => window.__owChimes || 0);
  await app.step(6); // 1.2 busy → waiting: the attention chime
  await expect.poll(() => app.page.evaluate(() => window.__owChimes || 0)).toBeGreaterThan(mid);
});
