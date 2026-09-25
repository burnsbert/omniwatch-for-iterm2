import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../../omniwatch/web/js/api.js';

function fakeFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const entry = responses.shift();
    if (!entry) throw new Error(`unexpected fetch call: ${url}`);
    return {
      ok: entry.status < 400,
      status: entry.status,
      text: async () => (entry.body === undefined ? '' : JSON.stringify(entry.body)),
    };
  };
  return { fetchImpl, calls };
}

test('getState() issues GET /api/v1/state and returns parsed JSON', async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 200, body: { ok: true, seq: 1 } }]);
  const api = createApi({ fetchImpl });
  const result = await api.getState();
  assert.deepEqual(result, { ok: true, seq: 1 });
  assert.equal(calls[0].url, '/api/v1/state');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.credentials, 'same-origin');
});

test('setLabel() PUTs a JSON body to the session label route, uid encoded', async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 200, body: { label: 'x' } }]);
  const api = createApi({ fetchImpl });
  await api.setLabel('uid with/slash', 'deploy-fix');
  assert.equal(calls[0].url, '/api/v1/sessions/uid%20with%2Fslash/label');
  assert.equal(calls[0].init.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[0].init.body), { label: 'deploy-fix' });
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
});

test('reply() maps expectHash to expect_hash in the request body', async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 202, body: { ok: true, action_id: 'a-1' } }]);
  const api = createApi({ fetchImpl });
  await api.reply('uid-1', { text: '1', submit: false, expectHash: 'deadbeef' });
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, { text: '1', submit: false, expect_hash: 'deadbeef' });
});

test('throws with .code/.status on a 409 stale_screen error (§4.4 reply guard)', async () => {
  const { fetchImpl } = fakeFetch([{
    status: 409,
    body: { ok: false, error: { code: 'stale_screen', message: 'screen has changed' } },
  }]);
  const api = createApi({ fetchImpl });
  await assert.rejects(
    () => api.reply('uid-1', { text: '1', expectHash: 'stale' }),
    (err) => {
      assert.equal(err.code, 'stale_screen');
      assert.equal(err.status, 409);
      assert.match(err.message, /screen has changed/);
      return true;
    },
  );
});

test('throws on a non-2xx response even without a JSON error body', async () => {
  const { fetchImpl } = fakeFetch([{ status: 500 }]);
  const api = createApi({ fetchImpl });
  await assert.rejects(() => api.health(), (err) => {
    assert.equal(err.code, 'unknown');
    assert.equal(err.status, 500);
    return true;
  });
});

test('setColor() sends {project:N} for a numeric argument, {color} otherwise', async () => {
  const { fetchImpl, calls } = fakeFetch([
    { status: 202, body: { ok: true } },
    { status: 202, body: { ok: true } },
  ]);
  const api = createApi({ fetchImpl });
  await api.setColor('uid-1', 3);
  await api.setColor('uid-1', null);
  assert.deepEqual(JSON.parse(calls[0].init.body), { project: 3 });
  assert.deepEqual(JSON.parse(calls[1].init.body), { color: null });
});

test('GET requests never send a body/content-type header', async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 200, body: { ok: true } }]);
  const api = createApi({ fetchImpl });
  await api.summary();
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[0].init.headers, undefined);
});

test('every remaining §4.4 endpoint method issues the documented method+path', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    return { ok: true, status: init.method === 'POST' && url.endsWith('/goto') ? 202 : 200, text: async () => JSON.stringify({ ok: true }) };
  };
  const api = createApi({ fetchImpl });

  await api.goto('u1');
  await api.visit('u1');
  await api.setMuted('u1', true);
  await api.closeTab('u1');
  await api.newTab();
  await api.launchIterm();
  await api.refresh();
  await api.getPrefs();
  await api.patchPrefs({ sound: true });
  await api.setProject(2, 'billing');
  await api.clearProjects();
  await api.quotaEmailDraft();
  await api.quotaEmailSkip();
  await api.shutdown();
  await api.demoStep(2);
  await api.demoScenario('busy-morning');
  await api.diagnostics();
  await api.probeAutomation();

  const byUrl = Object.fromEntries(calls.map((c) => [`${c.method} ${c.url}`, c]));
  assert.ok(byUrl['POST /api/v1/sessions/u1/goto']);
  assert.ok(byUrl['POST /api/v1/sessions/u1/visit']);
  assert.deepEqual(byUrl['PUT /api/v1/sessions/u1/mute'].body, { muted: true });
  assert.deepEqual(byUrl['POST /api/v1/sessions/u1/close'].body, { confirm: true });
  assert.ok(byUrl['POST /api/v1/tabs/new']);
  assert.ok(byUrl['POST /api/v1/iterm/launch']);
  assert.ok(byUrl['POST /api/v1/refresh']);
  assert.ok(byUrl['GET /api/v1/prefs']);
  assert.deepEqual(byUrl['PATCH /api/v1/prefs'].body, { sound: true });
  assert.deepEqual(byUrl['PUT /api/v1/projects/2'].body, { name: 'billing' });
  assert.deepEqual(byUrl['DELETE /api/v1/projects'].body, { confirm: true });
  assert.ok(byUrl['POST /api/v1/quota-email/draft']);
  assert.ok(byUrl['POST /api/v1/quota-email/skip']);
  assert.ok(byUrl['POST /api/v1/shutdown']);
  assert.deepEqual(byUrl['POST /api/v1/demo/step'].body, { seconds: 2 });
  assert.deepEqual(byUrl['POST /api/v1/demo/scenario'].body, { name: 'busy-morning' });
  assert.ok(byUrl['GET /api/v1/diagnostics']);
  assert.ok(byUrl['POST /api/v1/diagnostics/probe-automation']);
});

test('createApi() throws when no fetch implementation is available', () => {
  const saved = globalThis.fetch;
  delete globalThis.fetch;
  try {
    assert.throws(() => createApi({}), /no fetch implementation/);
  } finally {
    globalThis.fetch = saved;
  }
});
