// Guard: every harness that launches a browser mutes it (--mute-audio for
// Chromium + the audio stub in every context). See web-tests/audio-mute.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHROMIUM_MUTE_ARGS, installAudioMute } from '../audio-mute.mjs';

const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('Chromium launches with --mute-audio in the E2E config, smoke and screenshots', async () => {
  assert.deepEqual([...CHROMIUM_MUTE_ARGS], ['--mute-audio']);
  const { default: config } = await import('../playwright.config.mjs');
  const chromium = config.projects.find((p) => p.name === 'chromium');
  assert.ok(chromium.use.launchOptions.args.includes('--mute-audio'));
  const { launchOptions } = await import('../browsers.mjs');
  assert.ok(launchOptions('chromium').args.includes('--mute-audio'), 'the browser finder mutes Chromium');
  assert.equal(launchOptions('chromium').headless, true);
  assert.match(src('../smoke.mjs'), /browserType\.launch\(\{ \.\.\.launchOptions\(engine\)/);
  assert.equal((src('../../scripts/screenshots.mjs').match(/chromium\.launch\(launchOptions\('chromium'\)\)/g) || []).length, 2);
});

test('every context is muted: fixtures override `context`, smoke/screenshots call muteContext', () => {
  assert.match(src('../e2e/fixtures.mjs'), /context: async \(\{ context \}, use\) => \{\s+await muteContext\(context\);/);
  assert.ok((src('../smoke.mjs').match(/muteContext\(await browser\.newContext/g) || []).length >= 2);
  assert.match(src('../../scripts/screenshots.mjs'), /await muteContext\(context\);/);
  for (const f of ['reconnect', 'backend', 'settings']) {
    assert.match(src(`../e2e/${f}.spec.mjs`), /from '\.\/fixtures\.mjs'/, `${f}.spec uses the muted fixtures`);
  }
});

test('the stub keeps the WebAudio surface and counts would-be sounds', () => {
  const w = { HTMLMediaElement: function H() {} };
  globalThis.window = w;
  try {
    installAudioMute();
    const ctx = new w.AudioContext();
    const osc = ctx.createOscillator();
    osc.frequency.value = 880;
    ctx.createGain().gain.setValueAtTime(0, 0).exponentialRampToValueAtTime(0.1, 1);
    osc.connect(ctx.createGain()).connect(ctx.destination);
    osc.start();
    osc.stop();
    w.HTMLMediaElement.prototype.play();
    assert.equal(w.__owChimes, 2);
    assert.equal(w.webkitAudioContext, w.AudioContext);
    assert.equal(w.__owAudioMuted, true);
  } finally {
    delete globalThis.window;
  }
});
