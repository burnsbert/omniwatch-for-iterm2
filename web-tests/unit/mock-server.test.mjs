// Contract tests for the dev mock backend (web-tests/mock-server.mjs) against
// DESIGN.md §4.4/§4.5, so the UI is developed against the same shapes and
// error codes the real server must produce.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startMockServer } from '../mock-server.mjs';

let srv;
before(async () => { srv = await startMockServer({ port: 0, quiet: true, animate: false }); });
after(async () => { await srv.close(); });

const H = () => ({ Authorization: `Bearer ${srv.token}`, 'Content-Type': 'application/json' });
const api = (path, { method = 'GET', body, headers } = {}) => fetch(`${srv.url}${path}`, {
  method, headers: headers || H(), body: body === undefined ? undefined : JSON.stringify(body),
});
const scenario = (name) => api('/api/v1/demo/scenario', { method: 'POST', body: { name } });

function rawRequest({ path, method = 'GET', headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('auth: /api needs the token; /auth sets the HttpOnly cookie and redirects (§4.5)', async () => {
  const r = await fetch(`${srv.url}/api/v1/state`);
  assert.equal(r.status, 401);
  assert.deepEqual((await r.json()).error.code, 'unauthorized');
  const a = await fetch(`${srv.url}/auth?token=${srv.token}`, { redirect: 'manual' });
  assert.equal(a.status, 302);
  assert.equal(a.headers.get('location'), '/');
  assert.match(a.headers.get('set-cookie'), new RegExp(`^ow_session=${srv.token}; HttpOnly; SameSite=Strict; Path=/`));
  const bad = await fetch(`${srv.url}/auth?token=nope`, { redirect: 'manual' });
  assert.equal(bad.status, 401);
  const c = await fetch(`${srv.url}/api/v1/health`, { headers: { Cookie: `ow_session=${srv.token}` } });
  assert.equal(c.status, 200);
});

test('Host and Origin checks (DNS rebinding / CSRF, §4.5)', async () => {
  const badHost = await rawRequest({ path: '/api/v1/health', headers: { Host: 'evil.example:80', Authorization: `Bearer ${srv.token}` } });
  assert.equal(badHost.status, 403);
  const badOrigin = await api('/api/v1/refresh', { method: 'POST', headers: { ...H(), Origin: 'http://evil.example' } });
  assert.equal(badOrigin.status, 403);
  const goodOrigin = await fetch(`${srv.url}/api/v1/refresh`, { method: 'POST', headers: { Cookie: `ow_session=${srv.token}`, Origin: srv.url } });
  assert.equal(goodOrigin.status, 200);
  const cookieNoOrigin = await fetch(`${srv.url}/api/v1/refresh`, { method: 'POST', headers: { Cookie: `ow_session=${srv.token}` } });
  assert.equal(cookieNoOrigin.status, 403, 'no Origin needs Bearer');
});

test('static files carry the CSP; traversal is refused', async () => {
  const r = await fetch(`${srv.url}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(await r.text(), /js\/main\.js/);
  const js = await fetch(`${srv.url}/js/main.js`);
  assert.match(js.headers.get('content-type'), /javascript/);
  const t = await rawRequest({ path: '/..%2f..%2fpackage.json' });
  assert.equal(t.status, 404);
  assert.equal((await fetch(`${srv.url}/nope.css`)).status, 404);
});

test('state, health, summary, diagnostics shapes (§4.4.1)', async () => {
  const st = await (await api('/api/v1/state')).json();
  for (const k of ['version', 'seq', 'server_time', 'demo', 'iterm', 'summary', 'windows', 'sessions', 'screens', 'usage', 'prefs', 'projects', 'capabilities', 'quota_prompt']) assert.ok(k in st, k);
  assert.ok(st.sessions.every((s) => st.screens[s.uid] && st.screens[s.uid].hash === s.screen_hash));
  assert.equal(st.summary.waiting, st.sessions.filter((s) => s.state === 'waiting').length);
  const health = await (await api('/api/v1/health')).json();
  assert.deepEqual([health.ok, health.demo, typeof health.uptime_s], [true, true, 'number']);
  const sum = await (await api('/api/v1/summary')).json();
  assert.equal(sum.waiting_sessions.length, sum.waiting);
  const d = await (await api('/api/v1/diagnostics')).json();
  assert.deepEqual(Object.keys(d).sort(), ['automation', 'claude_credentials', 'codex_credentials', 'config_dir', 'iterm', 'log_path', 'python', 'tab_colors']);
  assert.equal((await api('/api/v1/nope')).status, 404);
  assert.equal((await api('/api/v1/refresh', { method: 'POST', headers: { ...H() }, body: undefined })).status, 200);
});

test('SSE: hello then full state on connect (§4.4.2)', async () => {
  const ctrl = new AbortController();
  const r = await fetch(`${srv.url}/api/v1/events?last_event_id=5`, { headers: H(), signal: ctrl.signal });
  assert.match(r.headers.get('content-type'), /^text\/event-stream/);
  const reader = r.body.getReader();
  let buf = '';
  while (!buf.includes('event: state')) {
    const { value } = await reader.read();
    buf += new TextDecoder().decode(value);
  }
  ctrl.abort();
  const events = [...buf.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
  assert.deepEqual(events.slice(0, 2), ['hello', 'state']);
  assert.match(buf, /^id: \d+$/m);
});

test('session actions: goto/visit 202/200, label, mute, color, close (§4.4)', async () => {
  await scenario('default');
  const st = await (await api('/api/v1/state')).json();
  const uid = st.sessions.find((s) => s.state === 'waiting').uid;
  const enc = encodeURIComponent(uid);
  const g = await api(`/api/v1/sessions/${enc}/goto`, { method: 'POST' });
  assert.equal(g.status, 202);
  assert.match((await g.json()).action_id, /^a-\d+$/);
  assert.equal((await api(`/api/v1/sessions/${enc}/visit`, { method: 'POST' })).status, 200);
  assert.equal((await api('/api/v1/sessions/NOPE/goto', { method: 'POST' })).status, 404);
  const l = await api(`/api/v1/sessions/${enc}/label`, { method: 'PUT', body: { label: '  hi ' } });
  assert.deepEqual(await l.json(), { ok: true, label: 'hi' });
  assert.equal((await api(`/api/v1/sessions/${enc}/label`, { method: 'PUT', body: { label: 5 } })).status, 422);
  assert.equal((await api(`/api/v1/sessions/${enc}/mute`, { method: 'PUT', body: { muted: true } })).status, 200);
  assert.equal((await api(`/api/v1/sessions/${enc}/mute`, { method: 'PUT', body: { muted: 'y' } })).status, 422);
  assert.equal((await api(`/api/v1/sessions/${enc}/color`, { method: 'PUT', body: { project: 2 } })).status, 202);
  assert.equal((await api(`/api/v1/sessions/${enc}/color`, { method: 'PUT', body: { color: null } })).status, 202);
  assert.equal((await api(`/api/v1/sessions/${enc}/color`, { method: 'PUT', body: { project: 9 } })).status, 422);
  assert.equal((await api(`/api/v1/sessions/${enc}/close`, { method: 'POST', body: {} })).status, 400);
  assert.equal((await api(`/api/v1/sessions/${enc}/close`, { method: 'POST', body: { confirm: true } })).status, 202);
  const badJson = await fetch(`${srv.url}/api/v1/sessions/${enc}/label`, { method: 'PUT', headers: H(), body: '{' });
  assert.equal(badJson.status, 400);
});

test('quick reply guards: 409 stale hash, 422 not waiting, 400 control chars, 202 ok (§4.4)', async () => {
  await scenario('default');
  const st = await (await api('/api/v1/state')).json();
  const w = st.sessions.find((s) => s.state === 'waiting' && s.agent);
  const busy = st.sessions.find((s) => s.state === 'busy');
  const enc = encodeURIComponent(w.uid);
  const stale = await api(`/api/v1/sessions/${enc}/reply`, { method: 'POST', body: { text: '1', submit: false, expect_hash: 'deadbeef' } });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, 'stale_screen');
  assert.equal((await api(`/api/v1/sessions/${encodeURIComponent(busy.uid)}/reply`, { method: 'POST', body: { text: '1', expect_hash: busy.screen_hash } })).status, 422);
  assert.equal((await api(`/api/v1/sessions/${enc}/reply`, { method: 'POST', body: { text: 'a\u0007', expect_hash: w.screen_hash } })).status, 400);
  assert.equal((await api(`/api/v1/sessions/${enc}/reply`, { method: 'POST', body: { text: '', expect_hash: w.screen_hash } })).status, 400);
  const ok = await api(`/api/v1/sessions/${enc}/reply`, { method: 'POST', body: { text: '1', submit: false, expect_hash: w.screen_hash } });
  assert.equal(ok.status, 202);
});

test('prefs PATCH validates and echoes; projects PUT/DELETE (§4.4)', async () => {
  const p = await api('/api/v1/prefs', { method: 'PATCH', body: { sort: 'attention', split_ratio: 0.95 } });
  const prefs = await p.json();
  assert.deepEqual([prefs.sort, prefs.split_ratio], ['attention', 0.8]);
  assert.equal((await api('/api/v1/prefs', { method: 'PATCH', body: { sort: 'bogus' } })).status, 422);
  assert.equal((await api('/api/v1/prefs', { method: 'PATCH', body: { nope: 1 } })).status, 422);
  assert.equal((await api('/api/v1/prefs', { method: 'PATCH', body: { sound: 'yes' } })).status, 422);
  assert.equal((await api('/api/v1/prefs')).status, 200);
  const pr = await api('/api/v1/projects/2', { method: 'PUT', body: { name: ' billing2 ' } });
  assert.equal((await pr.json()).project.name, 'billing2');
  assert.equal((await api('/api/v1/projects/9', { method: 'PUT', body: { name: 'x' } })).status, 404);
  assert.equal((await api('/api/v1/projects/1', { method: 'PUT', body: {} })).status, 422);
  assert.equal((await api('/api/v1/projects', { method: 'DELETE', body: {} })).status, 400);
  const cleared = await (await api('/api/v1/projects', { method: 'DELETE', body: { confirm: true } })).json();
  assert.ok(cleared.projects.every((x) => x.name === ''));
});

test('scenarios cover the §2.9 states; tab colors off → 503', async () => {
  for (const [name, check] of [
    ['empty', (s) => s.sessions.length === 0 && s.iterm.status === 'ok'],
    ['not-running', (s) => s.iterm.status === 'not_running'],
    ['not-authorized', (s) => s.iterm.status === 'not_authorized'],
    ['connecting', (s) => s.iterm.status === 'connecting'],
    ['error', (s) => s.iterm.status === 'error' && s.iterm.stale],
    ['stale', (s) => s.iterm.stale],
    ['many', (s) => s.sessions.length === 240],
    ['usage-errors', (s) => s.usage.codex.status === 'error' && s.usage.claude.status === 'stale'],
    ['no-creds', (s) => s.usage.claude.status === 'no_credentials'],
    ['no-agents', (s) => s.usage.claude.status === 'inactive'],
    ['onboarding', (s) => s.prefs.onboarding_done === false],
    ['quota', (s) => s.quota_prompt && s.quota_prompt.pct === 91],
    ['no-colors', (s) => s.capabilities.tab_colors === false],
  ]) {
    await scenario(name);
    const st = await (await api('/api/v1/state')).json();
    assert.ok(check(st), `scenario ${name}`);
  }
  const st = await (await api('/api/v1/state')).json();
  const r = await api(`/api/v1/sessions/${encodeURIComponent(st.sessions[0].uid)}/color`, { method: 'PUT', body: { project: 1 } });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error.code, 'tab_colors_unavailable');
  await scenario('default');
  const step = await (await api('/api/v1/demo/step', { method: 'POST', body: { seconds: 9 } })).json();
  assert.equal(step.ok, true);
  srv.step(1);
  const after9 = await (await api('/api/v1/state')).json();
  assert.equal(after9.sessions.find((s) => s.uid.startsWith('AAAAAAAA-0001')).state, 'waiting', 'scripted busy→waiting at t+8');
  for (const path of ['/api/v1/tabs/new', '/api/v1/iterm/launch', '/api/v1/diagnostics/probe-automation', '/api/v1/quota-email/draft', '/api/v1/quota-email/skip', '/api/v1/plugin/focus']) {
    assert.ok([200, 202].includes((await api(path, { method: 'POST' })).status), path);
  }
});
