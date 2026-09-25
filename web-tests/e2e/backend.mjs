// backend.mjs — spawn the REAL Omniwatch backend in demo mode for E2E and
// screenshots: `python3 -m omniwatch serve --demo --ready-json --port N
// --demo-clock <fixed> --demo-seed 7`, with a fresh temp OMNIWATCH_CONFIG_DIR
// (never ~/.config/omniwatch). stdin stays a pipe so the backend's orphan
// guard exits it if the test process dies.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEMO_CLOCK = 1790000000; // 2026-09-21 10:13:20 America/New_York
export const DEMO_SEED = 7;

export async function startBackend({ port = 0, scenario = null, clock = DEMO_CLOCK, seed = DEMO_SEED, configDir = null } = {}) {
  const dir = configDir || fs.mkdtempSync(path.join(os.tmpdir(), 'ow-e2e-'));
  const args = ['-m', 'omniwatch', 'serve', '--demo', '--ready-json', '--port', String(port), '--demo-seed', String(seed)];
  if (clock != null) args.push('--demo-clock', String(clock));
  if (scenario) args.push('--demo-scenario', scenario);
  const child = spawn('python3', args, {
    cwd: REPO,
    env: { ...process.env, OMNIWATCH_CONFIG_DIR: dir, PYTHONPATH: REPO, PYTHONUNBUFFERED: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  const ready = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`backend: no ready line in 15 s\n${stderr}`)), 15000);
    child.stdout.on('data', (c) => {
      buf += c;
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        clearTimeout(timer);
        try { resolve(JSON.parse(buf.slice(0, nl))); } catch (e) { reject(e); }
      }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`backend exited ${code}\n${stderr}`)); });
  });
  const url = `http://127.0.0.1:${ready.port}`;
  async function api(method, p, body) {
    const r = await fetch(`${url}${p}`, {
      method,
      headers: { Authorization: `Bearer ${ready.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    return { status: r.status, json };
  }
  let stopped = false;
  async function stop({ keepDir = false } = {}) {
    if (stopped) return;
    stopped = true;
    await api('POST', '/api/v1/shutdown').catch(() => {});
    await new Promise((resolve) => {
      if (child.exitCode !== null) { resolve(); return; }
      const t = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 4000);
      child.on('exit', () => { clearTimeout(t); resolve(); });
    });
    if (!keepDir && !configDir) fs.rmSync(dir, { recursive: true, force: true });
  }
  return {
    ready, url, token: ready.token, port: ready.port, authUrl: `${url}/auth?token=${ready.token}`, configDir: dir,
    clock, api, stop, child,
  };
}

/** Every pref back to its default, onboarding done (API.md §4 table). */
export const DEFAULT_PREFS = Object.freeze({
  view: 'split', sort: 'natural', show_dollars: false, sound: false, split_ratio: 0.42, projects_open: false,
  grid_all: false, usage_strip: 'expanded', theme: 'system', font_scale: 1.0,
  notifications: { enabled: true, click: 'goto', stall: true }, quick_reply: true, keep_on_top: false,
  close_window_on_q: true, hint_bar: true, debug_rule: false, onboarding_done: true, stall_minutes: 10, editor: '',
});

export async function resetBackend(backend, { scenario = 'default', prefs = {} } = {}) {
  const r = await backend.api('POST', '/api/v1/demo/scenario', { name: scenario });
  if (r.status !== 200) throw new Error(`scenario reset failed: ${r.status} ${JSON.stringify(r.json)}`);
  const p = await backend.api('PATCH', '/api/v1/prefs', { ...DEFAULT_PREFS, ...prefs });
  if (p.status !== 200) throw new Error(`prefs reset failed: ${p.status} ${JSON.stringify(p.json)}`);
  // Projects: the demo seed re-applies its names on reset; clear slots 4/5 that tests rename.
  await backend.api('PUT', '/api/v1/projects/4', { name: '' });
  await backend.api('PUT', '/api/v1/projects/5', { name: '' });
}
