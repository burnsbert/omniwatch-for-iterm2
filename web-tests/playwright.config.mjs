// playwright.config.mjs — Omniwatch E2E (DESIGN §5, WP6). Headless Chromium
// and WebKit against the REAL demo backend (spawned per worker by
// e2e/fixtures.mjs with a frozen demo clock, fixed seed and a temp
// OMNIWATCH_CONFIG_DIR). Headed/UI/debug runs are refused unless
// OW_ALLOW_HEADED=1, so a run never opens a window by accident.

import { defineConfig } from '@playwright/test';
import { launchOptions } from './browsers.mjs';

const wantsHeaded = process.argv.some((a) => a === '--headed' || a === '--ui' || a === '--debug') || !!process.env.PWDEBUG;
if (wantsHeaded && process.env.OW_ALLOW_HEADED !== '1') {
  throw new Error('Omniwatch E2E runs headless only. Set OW_ALLOW_HEADED=1 to allow --headed/--ui/--debug.');
}

// Headless browsers still reach the speakers: launchOptions() adds
// --mute-audio for Chromium; every context also gets the silent audio stub
// (e2e/fixtures.mjs).
const launch = (name) => {
  const { headless, ...opts } = launchOptions(name); // eslint-disable-line no-unused-vars
  return opts;
};

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.mjs$/,
  globalSetup: './e2e/global-setup.mjs',
  fullyParallel: false,
  workers: process.env.OW_E2E_WORKERS ? Number(process.env.OW_E2E_WORKERS) : 4,
  retries: 0,
  timeout: 30000,
  expect: { timeout: 6000 },
  reporter: [['list']],
  use: {
    headless: true,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    colorScheme: 'dark',
    contextOptions: { reducedMotion: 'reduce' }, // not a top-level `use` option in @playwright/test
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', headless: true, launchOptions: launch('chromium') } },
    { name: 'webkit', use: { browserName: 'webkit', headless: true, launchOptions: launch('webkit') } },
  ],
});
