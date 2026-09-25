// API contract tests (docs/API.md). By default they run against the dev mock
// (web-tests/mock-server.mjs); with OW_CONTRACT_BACKEND=real they run the
// same assertions against the real demo backend
// (`python3 -m omniwatch serve --demo --ready-json`, temp OMNIWATCH_CONFIG_DIR),
// which is how the mock is kept faithful to the real server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockServer, REAL_SCENARIOS, MOCK_ONLY_SCENARIOS } from '../mock-server.mjs';

const REAL = process.env.OW_CONTRACT_BACKEND === 'real';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let srv;

async function startReal() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-contract-'));
  const child = spawn('python3', ['-m', 'omniwatch', 'serve', '--demo', '--ready-json', '--port', '0'], {
    cwd: REPO, env: { ...process.env, OMNIWATCH_CONFIG_DIR: configDir, PYTHONPATH: REPO }, stdio: ['pipe', 'pipe', 'inherit'],
  });
  const ready = await new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (c) => {
      buf += c;
      if (buf.includes('\n')) resolve(JSON.parse(buf.split('\n')[0]));
    });
    child.on('exit', (code) => reject(new Error(`backend exited ${code}`)));
  });
  const url = `http://127.0.0.1:${ready.port}`;
  return {
    port: ready.port, token: ready.token, url,
    async close() {
      await fetch(`${url}/api/v1/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${ready.token}` } }).catch(() => {});
      await new Promise((r) => { if (child.exitCode !== null) r(); else child.on('exit', r); });
      fs.rmSync(configDir, { recursive: true, force: true });
    },
  };
}

before(async () => { srv = REAL ? await startReal() : await startMockServer({ port: 0, quiet: true, animate: false }); });
after(async () => { await srv.close(); });

const H = () => ({ Authorization: `Bearer ${srv.token}`, 'Content-Type': 'application/json' });
const api = (p, { method = 'GET', body, headers } = {}) => fetch(`${srv.url}${p}`, {
  method, headers: headers || H(), body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
});
const json = async (p, opts) => {
  const r = await api(p, opts);
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
};
const scenario = (name) => json('/api/v1/demo/scenario', { method: 'POST', body: { name } });
const state = async () => (await json('/api/v1/state')).body;
const enc = encodeURIComponent;

function raw({ path: p, method = 'GET', headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, path: p, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Open the SSE stream and collect events until `until(events)` is true. */
async function sse(until, { timeoutMs = 5000, query = '' } = {}) {
  const ctrl = new AbortController();
  const r = await fetch(`${srv.url}/api/v1/events${query}`, { headers: H(), signal: ctrl.signal });
  const reader = r.body.getReader();
  const events = [];
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  let pending = null; // a read that outlived the poll timeout is reused, never dropped
  try {
    while (!until(events) && Date.now() < deadline) {
      if (!pending) pending = reader.read();
      const r = await Promise.race([pending, new Promise((res) => setTimeout(() => res(null), 200))]);
      if (r === null) continue;
      pending = null;
      const { value, done } = r;
      if (done) break;
      if (!value) continue;
      buf += new TextDecoder().decode(value);
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = { raw: block };
        for (const line of block.split('\n')) {
          if (line.startsWith('id: ')) ev.id = Number(line.slice(4));
          else if (line.startsWith('event: ')) ev.event = line.slice(7);
          else if (line.startsWith('data: ')) ev.data = JSON.parse(line.slice(6));
          else if (line.startsWith('retry:')) ev.retry = true;
        }
        events.push(ev);
      }
    }
  } finally {
    ctrl.abort();
  }
  return { status: r.status, headers: r.headers, events };
}

test('auth: token required; /auth sets the HttpOnly cookie; non-GET /auth is 405 (§1)', async () => {
  const r = await fetch(`${srv.url}/api/v1/state`);
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error.code, 'unauthorized');
  const a = await fetch(`${srv.url}/auth?token=${srv.token}`, { redirect: 'manual' });
  assert.equal(a.status, 302);
  assert.equal(a.headers.get('location'), '/');
  assert.match(a.headers.get('set-cookie'), new RegExp(`^ow_session=${srv.token}; HttpOnly; SameSite=Strict; Path=/`));
  assert.equal((await fetch(`${srv.url}/auth?token=nope`, { redirect: 'manual' })).status, 401);
  assert.equal((await fetch(`${srv.url}/auth?token=${srv.token}`, { method: 'POST', redirect: 'manual' })).status, 405);
  assert.equal((await fetch(`${srv.url}/api/v1/health`, { headers: { Cookie: `ow_session=${srv.token}` } })).status, 200);
  assert.equal((await fetch(`${srv.url}/api/v1/health`, { headers: { Authorization: `bearer ${srv.token}` } })).status, 200, 'scheme is case-insensitive');
});

test('Host and Origin checks (DNS rebinding / CSRF, §1)', async () => {
  assert.equal((await raw({ path: '/api/v1/health', headers: { Host: 'evil.example:80', Authorization: `Bearer ${srv.token}` } })).status, 403);
  assert.equal((await raw({ path: '/', headers: { Host: 'evil.example:80' } })).status, 403);
  assert.equal((await api('/api/v1/refresh', { method: 'POST', headers: { ...H(), Origin: 'http://evil.example' } })).status, 403);
  assert.equal((await api('/api/v1/refresh', { method: 'POST', headers: { ...H(), Origin: 'null' } })).status, 403);
  assert.equal((await fetch(`${srv.url}/api/v1/refresh`, { method: 'POST', headers: { Cookie: `ow_session=${srv.token}`, Origin: srv.url } })).status, 200);
  assert.equal((await fetch(`${srv.url}/api/v1/refresh`, { method: 'POST', headers: { Cookie: `ow_session=${srv.token}` } })).status, 403, 'cookie-only write without Origin');
});

test('static files: CSP + no-cache; traversal is a plain-text 404; API is no-store', async () => {
  const r = await fetch(`${srv.url}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /style-src 'self'/);
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.match(await r.text(), /js\/main\.js/);
  assert.match((await fetch(`${srv.url}/js/main.js`)).headers.get('content-type'), /javascript/);
  const t = await raw({ path: '/js/../index.html' });
  assert.equal(t.status, 404);
  assert.match(t.headers['content-type'], /^text\/plain/);
  assert.equal((await fetch(`${srv.url}/nope.css`)).status, 404);
  assert.equal((await api('/api/v1/health')).headers.get('cache-control'), 'no-store');
});

test('routing: unknown route 404, wrong method 405 (§2)', async () => {
  const nf = await json('/api/v1/nope');
  assert.deepEqual([nf.status, nf.body.error.code], [404, 'not_found']);
  const st = await state();
  const na = await json(`/api/v1/sessions/${enc(st.sessions[0].uid)}/goto`);
  assert.deepEqual([na.status, na.body.error.code], [405, 'method_not_allowed']);
  assert.equal((await json('/api/v1/state', { method: 'DELETE' })).status, 405);
  assert.equal((await json('/api/v1/refresh', { method: 'POST', body: '[1]' })).status, 400, 'body must be an object');
  assert.equal((await json('/api/v1/refresh', { method: 'POST', body: '{' })).status, 400, 'invalid JSON');
});

test('shapes: state, health, summary, diagnostics (§4, §5)', async () => {
  await scenario('default');
  const st = await state();
  for (const k of ['version', 'seq', 'server_time', 'demo', 'iterm', 'summary', 'windows', 'sessions', 'screens', 'usage', 'prefs', 'projects', 'capabilities', 'quota_prompt']) assert.ok(k in st, k);
  assert.equal(st.demo, true);
  assert.ok(st.sessions.every((s) => st.screens[s.uid] && st.screens[s.uid].hash === s.screen_hash && /^[0-9a-f]{8}$/.test(s.screen_hash)));
  assert.equal(st.summary.tabs, st.sessions.length, 'summary.tabs counts sessions');
  assert.equal(st.summary.waiting, st.sessions.filter((s) => s.state === 'waiting').length);
  assert.ok(st.summary.waiting >= 1, 'default scenario has someone waiting');
  const waits = st.summary.waiting_uids.map((u) => st.sessions.find((s) => s.uid === u).state_since);
  assert.deepEqual(waits, [...waits].sort((a, b) => a - b), 'waiting_uids longest wait first');
  for (const s of st.sessions) {
    assert.equal(s.display_name, s.label || s.name);
    assert.ok(!('rule' in s) || st.capabilities.debug_rule, 'rule only with debug_rule');
    assert.ok(s.prompt === null || s.state === 'waiting');
  }
  assert.equal(st.projects.map((p) => p.color).join(), 'blue,purple,green,red,yellow');
  const h = (await json('/api/v1/health')).body;
  assert.deepEqual([h.ok, h.demo, typeof h.uptime_s, typeof h.pid], [true, true, 'number', 'number']);
  const sum = (await json('/api/v1/summary')).body;
  assert.equal(sum.waiting_sessions.length, sum.waiting);
  const d = (await json('/api/v1/diagnostics')).body;
  for (const k of ['python', 'iterm', 'automation', 'tab_colors', 'claude_credentials', 'codex_credentials', 'config_dir', 'log_path', 'demo']) assert.ok(k in d, k);
  assert.equal(d.automation, 'ok');
});

test('SSE: hello then state with the current seq as id; no retry:, no replay (§6)', async () => {
  const { status, headers, events } = await sse((ev) => ev.length >= 2, { query: '?last_event_id=3' });
  assert.equal(status, 200);
  assert.match(headers.get('content-type'), /^text\/event-stream; charset=utf-8/);
  assert.deepEqual(events.slice(0, 2).map((e) => e.event), ['hello', 'state']);
  assert.equal(events[0].id, events[1].id);
  assert.equal(events[1].data.seq, events[1].id);
  assert.ok(!events.some((e) => e.retry));
  assert.deepEqual(Object.keys(events[0].data).sort(), ['demo', 'server_time', 'version']);
});

test('color: 202 and an immediate `action` event with the human detail (§3, §10.2)', async () => {
  await scenario('default');
  const st = await state();
  const s = st.sessions[0];
  const run = sse((ev) => ev.some((e) => e.event === 'action' && e.data.kind === 'color'));
  await new Promise((r) => setTimeout(r, 300));
  const r = await json(`/api/v1/sessions/${enc(s.uid)}/color`, { method: 'PUT', body: { project: 2 } });
  assert.equal(r.status, 202);
  assert.deepEqual([r.body.ok, /^a-\d+$/.test(r.body.action_id)], [true, true]);
  const { events } = await run;
  const ev = events.find((e) => e.event === 'action' && e.data.kind === 'color');
  assert.ok(ev, 'color action event');
  assert.equal(ev.data.id, r.body.action_id);
  assert.equal(ev.data.ok, true);
  assert.match(ev.data.detail, new RegExp(`^tab ${s.tab_label.replace('.', '\\.')} → purple`));
  const u = enc(s.uid);
  assert.equal((await json(`/api/v1/sessions/${u}/color`, { method: 'PUT', body: {} })).status, 400);
  assert.equal((await json(`/api/v1/sessions/${u}/color`, { method: 'PUT', body: { project: true } })).status, 400);
  assert.equal((await json(`/api/v1/sessions/${u}/color`, { method: 'PUT', body: { project: 9 } })).status, 422);
  assert.equal((await json(`/api/v1/sessions/${u}/color`, { method: 'PUT', body: { color: 'teal' } })).status, 422);
  assert.equal((await json(`/api/v1/sessions/${u}/color`, { method: 'PUT', body: { color: 5 } })).status, 400);
  assert.equal((await json(`/api/v1/sessions/${u}/color`, { method: 'PUT', body: { color: null } })).status, 202);
  assert.equal((await json('/api/v1/sessions/NOPE/color', { method: 'PUT', body: { project: 1 } })).status, 404);
});

test('goto / visit / label / mute / close (§4 Sessions)', async () => {
  await scenario('default');
  const st = await state();
  const w = st.sessions.find((s) => s.state === 'waiting');
  const u = enc(w.uid);
  const g = await json(`/api/v1/sessions/${u}/goto`, { method: 'POST' });
  assert.deepEqual([g.status, g.body.ok], [202, true]);
  assert.equal((await json('/api/v1/sessions/NOPE/goto', { method: 'POST' })).status, 404);
  assert.deepEqual((await json(`/api/v1/sessions/${u}/visit`, { method: 'POST' })).body, { ok: true });
  assert.deepEqual((await json(`/api/v1/sessions/${u}/label`, { method: 'PUT', body: { label: '  hi ✨ ' } })).body, { ok: true, label: 'hi ✨' });
  assert.equal((await json(`/api/v1/sessions/${u}/label`, { method: 'PUT', body: {} })).status, 400);
  assert.equal((await json(`/api/v1/sessions/${u}/label`, { method: 'PUT', body: { label: 5 } })).status, 400);
  assert.equal((await json(`/api/v1/sessions/${u}/label`, { method: 'PUT', body: { label: 'x'.repeat(81) } })).status, 422);
  assert.equal((await json(`/api/v1/sessions/${u}/label`, { method: 'PUT', body: { label: 'a\u0007' } })).status, 422);
  assert.deepEqual((await json(`/api/v1/sessions/${u}/mute`, { method: 'PUT', body: { muted: true } })).body, { ok: true, muted: true });
  assert.equal((await json(`/api/v1/sessions/${u}/mute`, { method: 'PUT', body: { muted: 1 } })).status, 400);
  const after = await state();
  const s2 = after.sessions.find((s) => s.uid === w.uid);
  assert.deepEqual([s2.label, s2.display_name, s2.title, s2.muted], ['hi ✨', 'hi ✨', 'hi ✨', true]);
  assert.equal((await json(`/api/v1/sessions/${u}/close`, { method: 'POST', body: {} })).status, 400);
  assert.equal((await json(`/api/v1/sessions/${u}/close`, { method: 'POST', body: { confirm: true } })).status, 202);
  assert.equal((await json('/api/v1/plugin/focus', { method: 'POST', body: {} })).status, 400);
  assert.equal((await json('/api/v1/plugin/focus', { method: 'POST', body: { uid: 'NOPE' } })).status, 404);
});

test('quick reply guards in order: 400, 422, 404, 422, 409 stale_screen, 202 (§4)', async () => {
  await scenario('default');
  const st = await state();
  const w = st.sessions.find((s) => s.state === 'waiting' && s.agent);
  const busy = st.sessions.find((s) => s.state !== 'waiting');
  const u = enc(w.uid);
  const reply = (body, uid = u) => json(`/api/v1/sessions/${uid}/reply`, { method: 'POST', body });
  assert.equal((await reply({ text: 1, expect_hash: w.screen_hash })).status, 400);
  assert.equal((await reply({ text: '1', submit: 'no', expect_hash: w.screen_hash })).status, 400);
  assert.equal((await reply({ text: '1' })).status, 400, 'expect_hash required');
  assert.equal((await reply({ text: '', expect_hash: w.screen_hash })).status, 422);
  assert.equal((await reply({ text: 'a\u0007', expect_hash: w.screen_hash })).status, 422);
  assert.equal((await reply({ text: 'x'.repeat(2001), expect_hash: w.screen_hash })).status, 422);
  assert.equal((await reply({ text: '1', expect_hash: 'x' }, 'NOPE')).status, 404);
  assert.equal((await reply({ text: '1', expect_hash: busy.screen_hash }, enc(busy.uid))).status, 422);
  const stale = await reply({ text: '1', expect_hash: 'deadbeef' });
  assert.deepEqual([stale.status, stale.body.error.code], [409, 'stale_screen']);
  await json('/api/v1/prefs', { method: 'PATCH', body: { quick_reply: false } });
  assert.equal((await reply({ text: '1', expect_hash: w.screen_hash })).status, 422, 'quick reply off');
  await json('/api/v1/prefs', { method: 'PATCH', body: { quick_reply: true } });
  const ok = await reply({ text: '1', submit: false, expect_hash: w.screen_hash.toUpperCase() });
  assert.deepEqual([ok.status, ok.body.ok], [202, true], 'hash compared case-insensitively');
});

test('prefs: bare object, strict atomic validation, partial notifications (§4, §10.13)', async () => {
  const g = await json('/api/v1/prefs');
  assert.equal(g.body.ok, undefined, 'bare prefs, no envelope');
  for (const k of ['view', 'sort', 'show_dollars', 'sound', 'split_ratio', 'projects_open', 'grid_all', 'usage_strip', 'theme', 'font_scale', 'notifications', 'quick_reply', 'keep_on_top', 'close_window_on_q', 'hint_bar', 'debug_rule', 'onboarding_done']) assert.ok(k in g.body, k);
  const p = await json('/api/v1/prefs', { method: 'PATCH', body: { sort: 'attention', split_ratio: 0.456, font_scale: 1.234 } });
  assert.deepEqual([p.status, p.body.sort, p.body.split_ratio, p.body.font_scale], [200, 'attention', 0.46, 1.23]);
  for (const bad of [{ theme: 'high-contrast' }, { split_ratio: 0.95 }, { font_scale: 2.5 }, { sound: 1 }, { nope: 1 }, { usage_strip: 'hidden' }, { notifications: { click: 'nowhere' } }]) {
    assert.equal((await json('/api/v1/prefs', { method: 'PATCH', body: bad })).status, 422, JSON.stringify(bad));
  }
  assert.equal((await json('/api/v1/prefs', { method: 'PATCH', body: { sort: 'path', theme: 'neon' } })).status, 422);
  assert.equal((await json('/api/v1/prefs')).body.sort, 'attention', 'one bad key rejects the whole patch');
  const n = await json('/api/v1/prefs', { method: 'PATCH', body: { notifications: { click: 'show' } } });
  assert.deepEqual(n.body.notifications, { enabled: true, click: 'show' });
  await json('/api/v1/prefs', { method: 'PATCH', body: { notifications: { click: 'goto' }, sort: 'natural' } });
});

test('projects: PUT returns {ok, project}; DELETE returns {ok}; errors (§4)', async () => {
  const pr = await json('/api/v1/projects/4', { method: 'PUT', body: { name: ' ops ' } });
  assert.deepEqual(pr.body, { ok: true, project: { slot: 4, name: 'ops', color: 'red' } });
  assert.equal((await json('/api/v1/projects/9', { method: 'PUT', body: { name: 'x' } })).status, 404);
  assert.equal((await json('/api/v1/projects/x', { method: 'PUT', body: { name: 'x' } })).status, 404);
  assert.equal((await json('/api/v1/projects/1', { method: 'PUT', body: {} })).status, 400);
  assert.equal((await json('/api/v1/projects/1', { method: 'PUT', body: { name: 'x'.repeat(81) } })).status, 422);
  assert.equal((await json('/api/v1/projects', { method: 'DELETE', body: {} })).status, 400);
  assert.deepEqual((await json('/api/v1/projects', { method: 'DELETE', body: { confirm: true } })).body, { ok: true });
  assert.ok((await state()).projects.every((x) => x.name === ''));
});

test('prefs and labels survive a scenario reset (§9)', async () => {
  await scenario('default');
  const st = await state();
  // Seeded demo labels are re-applied on reset (API.md §9), so use an unlabelled session.
  const uid = st.sessions.find((s) => !s.label).uid;
  await json(`/api/v1/sessions/${enc(uid)}/label`, { method: 'PUT', body: { label: 'kept' } });
  await json('/api/v1/prefs', { method: 'PATCH', body: { view: 'grid' } });
  await scenario('default');
  const again = await state();
  assert.equal(again.prefs.view, 'grid');
  assert.equal(again.sessions.find((s) => s.uid === uid).label, 'kept');
  await json('/api/v1/prefs', { method: 'PATCH', body: { view: 'split' } });
});

test('quota email: pending in the demo; draft/skip clear it; then 404 (§4)', async () => {
  const st = await state();
  if (st.quota_prompt) {
    assert.deepEqual(Object.keys(st.quota_prompt).sort(), ['pct', 'to']);
    const d = await json('/api/v1/quota-email/draft', { method: 'POST' });
    assert.equal(d.status, 200);
    assert.deepEqual(Object.keys(d.body).sort(), ['ok', 'opened']);
  }
  assert.equal((await state()).quota_prompt, null);
  assert.equal((await json('/api/v1/quota-email/draft', { method: 'POST' })).status, 404);
  assert.equal((await json('/api/v1/quota-email/skip', { method: 'POST' })).status, 404);
});

test('demo endpoints: step and scenario validation; the real scenarios (§9)', async () => {
  const step = await json('/api/v1/demo/step', { method: 'POST', body: { seconds: 6 } });
  assert.deepEqual([step.status, step.body.ok, typeof step.body.seq], [200, true, 'number']);
  assert.equal((await json('/api/v1/demo/step', { method: 'POST', body: {} })).status, 200, 'seconds defaults to 0');
  assert.equal((await json('/api/v1/demo/step', { method: 'POST', body: { seconds: 'x' } })).status, 400);
  assert.equal((await json('/api/v1/demo/step', { method: 'POST', body: { seconds: -1 } })).status, 422);
  assert.equal((await json('/api/v1/demo/scenario', { method: 'POST', body: { name: 5 } })).status, 400);
  assert.equal((await json('/api/v1/demo/scenario', { method: 'POST', body: { name: 'nope' } })).status, 422);
  const checks = {
    default: (s) => s.iterm.status === 'ok' && s.summary.waiting >= 1,
    empty: (s) => s.sessions.length === 0 && s.iterm.status === 'ok',
    'not-running': (s) => s.iterm.status === 'not_running' && s.sessions.length === 0,
    'not-authorized': (s) => s.iterm.status === 'not_authorized',
    many: (s) => s.sessions.length >= 40,
    'usage-errors': (s) => ['error', 'stale', 'no_credentials'].includes(s.usage.claude.status) || ['error', 'stale', 'no_credentials'].includes(s.usage.codex.status),
  };
  for (const name of REAL_SCENARIOS) {
    const r = await scenario(name);
    assert.deepEqual([r.status, r.body.scenario], [200, name]);
    assert.ok(checks[name](await state()), `scenario ${name}`);
  }
  const g = await json(`/api/v1/sessions/${enc('x')}/goto`, { method: 'POST' });
  assert.equal(g.status, 404);
  await scenario('not-running');
  assert.equal((await json('/api/v1/tabs/new', { method: 'POST' })).body.error.code, 'iterm_unavailable');
  for (const p of ['/api/v1/iterm/launch', '/api/v1/diagnostics/probe-automation', '/api/v1/refresh']) {
    assert.ok([200, 202].includes((await json(p, { method: 'POST' })).status), p);
  }
  await scenario('default');
});

test('mock-only scenarios and timeline (skipped against the real backend)', { skip: REAL }, async () => {
  for (const [name, check] of [
    ['connecting', (s) => s.iterm.status === 'connecting'],
    ['error', (s) => s.iterm.status === 'error' && s.iterm.stale],
    ['stale', (s) => s.iterm.stale],
    ['no-creds', (s) => s.usage.claude.status === 'no_credentials'],
    ['no-agents', (s) => s.usage.claude.status === 'inactive'],
    ['onboarding', (s) => s.prefs.onboarding_done === false],
    ['no-colors', (s) => s.capabilities.tab_colors === false],
  ]) {
    await scenario(name);
    assert.ok(check(await state()), name);
  }
  assert.ok(MOCK_ONLY_SCENARIOS.includes('quota'));
  const st = await state();
  const r = await json(`/api/v1/sessions/${enc(st.sessions[0].uid)}/color`, { method: 'PUT', body: { project: 1 } });
  assert.deepEqual([r.status, r.body.error.code], [503, 'tab_colors_unavailable']);
  await scenario('default');
  await json('/api/v1/demo/step', { method: 'POST', body: { seconds: 9 } });
  const after9 = await state();
  assert.equal(after9.sessions.find((s) => s.uid.startsWith('AAAAAAAA-0001')).state, 'waiting', 'scripted busy→waiting at t+8');
});
