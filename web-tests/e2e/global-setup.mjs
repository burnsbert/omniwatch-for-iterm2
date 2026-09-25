// global-setup.mjs — fail fast if the real backend can't start (python,
// PYTHONPATH, demo package), before any browser is launched. Each worker
// then spawns its own backend (e2e/fixtures.mjs).
import { startBackend } from './backend.mjs';

export default async function globalSetup() {
  const b = await startBackend();
  const h = await b.api('GET', '/api/v1/health');
  await b.stop();
  if (h.status !== 200 || !h.json.demo) throw new Error(`backend health check failed: ${h.status}`);
  console.log(`[e2e] real backend OK: omniwatch ${h.json.version} (demo, frozen clock)`);
}
