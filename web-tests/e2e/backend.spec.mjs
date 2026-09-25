// Backend behaviour visible through the real API (data collection, model,
// persistence, version): the parity rows that have no pixels of their own.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { startBackend, REPO } from './backend.mjs';

const SPINNERS = '⠁⠂⠄⠈⠐⠠⡀⢀⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✢✻✽✶✳✣∗·';
const spinnerRe = new RegExp(`[${SPINNERS}]`, 'g');
function changeHash(text) {
  const lines = text.split('\n').map((l) => l.replace(spinnerRe, '').replace(/\s+$/u, ''));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return (zlib.crc32(Buffer.from(lines.join('\n'), 'utf8')) >>> 0).toString(16).padStart(8, '0');
}

let b;
test.beforeAll(async () => { b = await startBackend(); });
test.afterAll(async () => { await b.stop(); });
const state = async () => (await b.api('GET', '/api/v1/state')).json;

test('one snapshot carries every session field; poll_ms and last_poll_at are exposed @P-01 @P-02 @P-03', async () => {
  const st = await state();
  for (const s of st.sessions) {
    for (const k of ['window_id', 'tab_index', 'session_index', 'uid', 'tty', 'is_processing', 'name', 'path', 'screen_hash']) expect(s).toHaveProperty(k);
    expect(st.screens[s.uid].text.length).toBeGreaterThan(0);
  }
  expect(st.iterm).toMatchObject({ status: 'ok', poll_ms: 0 });
  expect(typeof st.iterm.last_poll_at).toBe('number');
});

test('actions go through the worker and re-poll at once; argv-safe text is accepted verbatim @P-04 @P-05', async () => {
  const st = await state();
  const w = st.sessions.find((s) => s.uid === 'DEMO-0001');
  const tricky = 'say "hi" & do shell script "echo no"';
  const r = await b.api('POST', '/api/v1/sessions/DEMO-0001/reply', { text: tricky, submit: true, expect_hash: w.screen_hash });
  expect(r.status).toBe(202);
  await b.api('POST', '/api/v1/demo/step', { seconds: 0 }); // the two-snapshot debounce (P-11)
  const after = await state();
  expect(after.sessions.find((s) => s.uid === 'DEMO-0001').state).not.toBe('waiting');
});

test('agent detection per TTY: claude and codex, plain shells have none @P-06 @P-07', async () => {
  const st = await state();
  expect(st.sessions.filter((s) => s.agent === 'claude').length).toBeGreaterThan(0);
  expect(st.sessions.filter((s) => s.agent === 'codex').length).toBeGreaterThan(0);
  for (const s of st.sessions) {
    expect(s.agents).toEqual(s.agent ? [...new Set([s.agent, ...s.agents])].sort() : []);
    expect(s.path_display).toBeTruthy();
  }
});

test('classifier: waiting agents have a parsed prompt; shells are active/quiet @P-08 @P-09', async () => {
  const st = await state();
  for (const s of st.sessions) {
    if (s.agent) expect(['busy', 'waiting', 'idle']).toContain(s.state);
    else expect(['active', 'quiet']).toContain(s.state);
    if (s.state === 'waiting') expect(s.prompt && s.prompt.options.length).toBeGreaterThan(0);
  }
});

test('screen_hash is CRC32 of the screen with spinners stripped and trailing blanks trimmed @P-10', async () => {
  const st = await state();
  for (const s of st.sessions) expect(s.screen_hash).toBe(changeHash(st.screens[s.uid].text));
});

test('debounce: a scripted change publishes within one demo step, with a transition @P-11', async () => {
  await b.api('POST', '/api/v1/demo/scenario', { name: 'default' });
  const r = await b.api('POST', '/api/v1/demo/step', { seconds: 6 });
  expect(r.status).toBe(200);
  expect((await state()).sessions.find((s) => s.uid === 'DEMO-0002').state).toBe('waiting');
});

test('attention latches on waiting and clears on visit @P-12', async () => {
  await b.api('POST', '/api/v1/demo/scenario', { name: 'default' });
  expect((await state()).sessions.find((s) => s.uid === 'DEMO-0007').attention).toBe(true);
  await b.api('POST', '/api/v1/sessions/DEMO-0007/visit');
  expect((await state()).sessions.find((s) => s.uid === 'DEMO-0007').attention).toBe(false);
});

test('closed sessions are garbage-collected from sessions and screens @P-13', async () => {
  await b.api('POST', '/api/v1/demo/scenario', { name: 'default' });
  await b.api('POST', '/api/v1/sessions/DEMO-0009/close', { confirm: true });
  const st = await state();
  expect(st.sessions.some((s) => s.uid === 'DEMO-0009')).toBe(false);
  expect(st.screens['DEMO-0009']).toBeUndefined();
});

test('tab colors: capability true, a color set shows up after the re-poll @P-14', async () => {
  await b.api('POST', '/api/v1/demo/scenario', { name: 'default' });
  expect((await state()).capabilities.tab_colors).toBe(true);
  await b.api('PUT', '/api/v1/sessions/DEMO-0006/color', { color: 'orange' });
  await b.api('POST', '/api/v1/demo/step', { seconds: 0 });
  expect((await state()).sessions.find((s) => s.uid === 'DEMO-0006').tab_color).toBe('orange');
});

test('usage blocks: structured limits, levels, projections, monthly cap with $ only when shown @P-15 @P-16 @P-18 @P-19 @P-20', async () => {
  const st = await state();
  expect(st.usage.claude.limits.map((l) => l.id)).toEqual(expect.arrayContaining(['claude.five_hour', 'claude.seven_day', 'claude.monthly']));
  expect(st.usage.codex.limits.map((l) => l.id)).toEqual(expect.arrayContaining(['codex.five_hour', 'codex.seven_day']));
  for (const l of [...st.usage.claude.limits, ...st.usage.codex.limits]) {
    expect(l.level).toBe(l.pct >= 80 ? 'red' : l.pct >= 50 ? 'yellow' : 'green');
    if (l.projection) expect(['hit', 'pace']).toContain(l.projection.kind);
  }
  const monthly = st.usage.claude.limits.find((l) => l.id === 'claude.monthly');
  expect([monthly.label, monthly.has_cap, monthly.limit_display]).toEqual(['Monthly cap', true, null]);
  await b.api('PATCH', '/api/v1/prefs', { show_dollars: true });
  expect((await state()).usage.claude.limits.find((l) => l.id === 'claude.monthly').limit_display).toMatch(/^\$/);
  await b.api('PATCH', '/api/v1/prefs', { show_dollars: false });
});

test('usage is gated on running agents: inactive without them @P-17', async () => {
  await b.api('POST', '/api/v1/demo/scenario', { name: 'empty' });
  const st = await state();
  expect([st.usage.claude.status, st.usage.codex.status]).toEqual(['inactive', 'inactive']);
  await b.api('POST', '/api/v1/demo/scenario', { name: 'default' });
});

test('labels persist with last_seen; prefs persist to state.json on shutdown @P-62 @P-74', async () => {
  const own = await startBackend();
  await own.api('PUT', '/api/v1/sessions/DEMO-0006/label', { label: 'kept' });
  await own.api('PATCH', '/api/v1/prefs', { sort: 'path', view: 'grid' });
  await own.stop({ keepDir: true });
  const saved = JSON.parse(fs.readFileSync(path.join(own.configDir, 'state.json'), 'utf8'));
  expect(saved.version).toBe(2);
  expect(saved.labels['DEMO-0006'].label).toBe('kept');
  expect(typeof saved.labels['DEMO-0006'].last_seen).toBe('number');
  expect([saved.sort, saved.view]).toEqual(['path', 'grid']);
  fs.rmSync(own.configDir, { recursive: true, force: true });
});

test('the version is in /health and `omniwatch --version` @P-82', async () => {
  const h = (await b.api('GET', '/api/v1/health')).json;
  const cli = execFileSync('python3', ['-m', 'omniwatch', '--version'], { cwd: REPO, env: { ...process.env, PYTHONPATH: REPO } }).toString().trim();
  expect(cli).toBe(`omniwatch ${h.version}`);
});
