#!/usr/bin/env node
// mock-server.mjs — development/E2E stand-in for the Python backend
// (DESIGN.md §4.4/§4.5), node stdlib only. It serves omniwatch/web/
// statically, implements the /api/v1 REST routes and the SSE stream against
// in-memory state seeded from fixtures/state.json, and animates state
// (spinners, a busy agent flipping to waiting, replies resolving) so live
// updates can be exercised without iTerm2.
//
//   node web-tests/mock-server.mjs [--port 8765] [--token dev] [--scenario default]
//                                  [--no-animate] [--ready-json]
//   → open the printed http://127.0.0.1:<port>/auth?token=<token> URL
//
// Scenarios: default, onboarding, empty, connecting, not-running,
// not-authorized, error, stale, many, usage-errors, no-agents, quota,
// no-colors. `POST /api/v1/demo/scenario {"name":…}` switches at runtime.
//
// Also importable: `const srv = await startMockServer({port:0}); srv.url; await srv.close()`.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..', 'omniwatch', 'web');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'state.json'), 'utf8'));

const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'";
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
  '.ico': 'image/x-icon',
};
const PREF_TYPES = {
  view: ['split', 'list', 'grid'], sort: ['natural', 'attention', 'agents', 'activity', 'path'],
  show_dollars: 'boolean', sound: 'boolean', split_ratio: 'number', projects_open: 'boolean', grid_all: 'boolean',
  usage_strip: ['expanded', 'collapsed'], theme: ['system', 'dark', 'light', 'high-contrast'], font_scale: 'number',
  notifications: 'object', quick_reply: 'boolean', keep_on_top: 'boolean', close_window_on_q: 'boolean',
  hint_bar: 'boolean', debug_rule: 'boolean', onboarding_done: 'boolean',
};
const SPINNER = ['✶', '✻', '✽', '✢', '·', '✢', '✽', '✻'];
const BRAILLE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// ---------------------------------------------------------------- screens

const SCREENS = {
  claudeBusy: (f, secs) => [
    '╭───────────────────────────────────────────────────────────╮',
    '│ ✻ Welcome to Claude Code!                                 │',
    '│   cwd: /Users/me/src/api-gateway                          │',
    '╰───────────────────────────────────────────────────────────╯',
    '',
    '> The retry test flakes about 1 in 20 runs on CI. Find out why and fix it.',
    '',
    '⏺ Read(src/retry.ts)',
    '  ⎿  Read 142 lines (ctrl+r to expand)',
    '',
    '⏺ Read(src/retry.test.ts)',
    '  ⎿  Read 88 lines (ctrl+r to expand)',
    '',
    '⏺ The flake comes from the backoff timer: the test awaits a real',
    '  250 ms sleep, and on a loaded runner the second attempt lands',
    '  after the assertion. Switching the test to fake timers.',
    '',
    '⏺ Update(src/retry.test.ts)',
    '  ⎿  Updated src/retry.test.ts with 6 additions and 2 removals',
    '       12 -  await sleep(250);',
    '       12 +  vi.useFakeTimers();',
    '       13 +  await vi.advanceTimersByTimeAsync(250);',
    '',
    `${SPINNER[f % SPINNER.length]} Running the retry suite 50× to confirm… (${secs}s · ↑ 1.9k tokens · esc to interrupt)`,
    '',
    '╭───────────────────────────────────────────────────────────╮',
    '│ >                                                         │',
    '╰───────────────────────────────────────────────────────────╯',
    '  ⏵⏵ accept edits on (shift+tab to cycle)',
  ].join('\n'),
  claudeEdit: () => [
    '> The retry test flakes about 1 in 20 runs on CI. Find out why and fix it.',
    '',
    '⏺ Ran the suite 50×: 50 passed, 0 failed.',
    '',
    '⏺ One more change: the production retry path has the same real-time',
    '  sleep, so I want to inject the clock there too.',
    '',
    '╭───────────────────────────────────────────────────────────╮',
    '│ Edit file                                                 │',
    '│ ╭───────────────────────────────────────────────────────╮ │',
    '│ │ src/retry.ts                                          │ │',
    '│ │                                                       │ │',
    '│ │  18 - export async function retry(fn, opts) {         │ │',
    '│ │  18 + export async function retry(fn, opts, clock) {  │ │',
    '│ ╰───────────────────────────────────────────────────────╯ │',
    '│ Do you want to make this edit to retry.ts?                │',
    '│ ❯ 1. Yes                                                  │',
    "│   2. Yes, and don't ask again this session (shift+tab)    │",
    '│   3. No, and tell Claude what to do differently (esc)     │',
    '╰───────────────────────────────────────────────────────────╯',
  ].join('\n'),
  claudeBash: () => [
    '> Split BillingService into invoicing and payments modules.',
    '',
    '⏺ I moved the invoice builders into src/invoicing/ and the Stripe',
    '  calls into src/payments/, then updated the 14 import sites.',
    '',
    '⏺ Update(src/billing/index.ts)',
    '  ⎿  Updated src/billing/index.ts with 3 additions and 41 removals',
    '',
    "⏺ Now I'll run the test suite to make sure nothing broke.",
    '',
    '╭───────────────────────────────────────────────────────────╮',
    '│ Bash command                                              │',
    '│                                                           │',
    '│   npm test                                                │',
    '│   Run the billing test suite                              │',
    '│                                                           │',
    '│ Do you want to proceed?                                   │',
    '│ ❯ 1. Yes                                                  │',
    "│   2. Yes, and don't ask again for npm test commands       │",
    '│   3. No, and tell Claude what to do differently (esc)     │',
    '╰───────────────────────────────────────────────────────────╯',
  ].join('\n'),
  claudeReplied: (reply, f) => [
    '> Split BillingService into invoicing and payments modules.',
    '',
    `  ⎿  (you chose ${reply})`,
    '',
    '⏺ Bash(npm test)',
    '  ⎿  PASS src/invoicing/builder.test.ts',
    '     PASS src/payments/stripe.test.ts',
    '     …',
    '',
    `${SPINNER[f % SPINNER.length]} Checking coverage… (4s · esc to interrupt)`,
    '',
    '╭───────────────────────────────────────────────────────────╮',
    '│ >                                                         │',
    '╰───────────────────────────────────────────────────────────╯',
  ].join('\n'),
  zsh: () => [
    'Last login: Thu Sep 24 08:12:40 on ttys003',
    '~/src/infra main ❯ terraform fmt -recursive',
    'modules/cdn/main.tf',
    '~/src/infra main ❯ git status -sb',
    '## main...origin/main',
    ' M modules/cdn/main.tf',
    '~/src/infra main ❯ ',
  ].join('\n'),
  codexIdle: () => [
    '>_ OpenAI Codex (v0.41.0)',
    '',
    '▌ Summarize the open PRs touching the docs site',
    '',
    '• There are 3 open PRs that touch docs/:',
    '  1. #412 "Fix broken anchors in the API guide" — ready, 2 approvals',
    '  2. #418 "Add dark-mode screenshots" — waiting on review',
    '  3. #421 "Move changelog to /releases" — has merge conflicts',
    '',
    '▌ ',
    '',
    '⏎ send   ⇧⏎ newline   ⌃T transcript   ⌃C quit   42% context left',
  ].join('\n'),
  codexApprove: () => [
    '>_ OpenAI Codex (v0.41.0)',
    '',
    '▌ Roll the new CDN cache rules out to staging',
    '',
    '• Ran terraform plan -out=staging.plan',
    '  └ Plan: 2 to add, 1 to change, 0 to destroy.',
    '',
    '• The plan only touches the staging distribution and its cache',
    '  policy. Applying it now.',
    '',
    'Allow command?',
    '',
    '  $ terraform apply staging.plan',
    '',
    '▌ Yes (y)   No (n)',
  ].join('\n'),
  codexBusy: (f) => [
    '>_ OpenAI Codex (v0.41.0)',
    '',
    '▌ Add a /healthz endpoint that checks the database pool',
    '',
    '• Explored',
    '  └ Read server.ts, db/pool.ts, routes/index.ts',
    '• Edited routes/health.ts (+34 -0)',
    '• Edited routes/index.ts (+2 -0)',
    '',
    `${BRAILLE[f % BRAILLE.length]} Running npm test -- health (${8 + (f % 50)}s • esc to interrupt)`,
  ].join('\n'),
  log: (n) => {
    const lines = [];
    const paths = ['/', '/pricing', '/docs/api', '/blog/launch', '/assets/app.css', '/docs/quickstart'];
    for (let i = Math.max(0, n - 16); i < n; i += 1) {
      const t = new Date(Date.UTC(2026, 8, 25, 10, 0, 0) + i * 1700).toISOString().replace('.000', '');
      lines.push(`${t} INFO  GET ${paths[i % paths.length]} 200 ${(12 + (i * 7) % 40)}ms`);
    }
    return lines.join('\n');
  },
  ultrawatch: () => [
    '▛▞ ULTRAWATCH  ·  9 tabs · 4 agents · 2 waiting',
    '──────────────────────────────────────────────',
    ' ◉ CC   1.2  ~/src/billing      refactor   wait 3m',
    ' ⠹ CC   1.1  ~/src/api-gateway             ',
    ' ○ CX   1.4  ~                             idle 22m',
  ].join('\n'),
  docs: () => [
    '> Update the README install section for the new installer.',
    '',
    '⏺ Updated README.md: replaced the manual steps with `./install.sh`,',
    '  documented --no-app and --prefix, and added an uninstall note.',
    '',
    '⏺ Done. Want me to regenerate the keyboard table too?',
    '',
    '╭───────────────────────────────────────────────────────────╮',
    '│ >                                                         │',
    '╰───────────────────────────────────────────────────────────╯',
    '  ? for shortcuts',
  ].join('\n'),
};

// --------------------------------------------------------------- helpers

function crcHex(text) {
  const buf = Buffer.from(text, 'utf8');
  if (typeof zlib.crc32 === 'function') return (zlib.crc32(buf) >>> 0).toString(16).padStart(8, '0');
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ((~c) >>> 0).toString(16).padStart(8, '0');
}

const clone = (x) => JSON.parse(JSON.stringify(x));
const nowS = () => Date.now() / 1000;

function shiftEpochs(obj, delta) {
  // Rebase every epoch-looking number in the fixture onto the current clock.
  const keys = new Set(['server_time', 'last_poll_at', 'state_since', 'last_change', 'fresh_until', 'fetched_at',
    'stale_since', 'resets_at', 'at']);
  const walk = (o) => {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (keys.has(k) && typeof v === 'number' && v > 1e9) o[k] = v + delta;
      else if (v && typeof v === 'object') walk(v);
    }
  };
  walk(obj);
}

function session(base) {
  return {
    uid: base.uid, window_id: 104, window_number: 1, tab_index: 1, session_index: 1, tab_label: '1.1',
    tty: '/dev/ttys009', name: 'zsh', is_processing: false, path: '/Users/me', path_display: '~',
    agent: null, agents: [], state: 'quiet', state_since: nowS() - 600, rule: null, attention: false,
    last_change: nowS() - 600, fresh_until: null, label: '', display_name: 'zsh', title: 'zsh',
    tab_color: null, project: null, muted: false, is_dashboard: false, screen_hash: '', prompt: null,
    ...base,
  };
}

// ------------------------------------------------------------- scenarios

function baseState() {
  const st = clone(FIXTURE);
  shiftEpochs(st, nowS() - FIXTURE.server_time);
  st.demo = true;
  return st;
}

function defaultScenario() {
  const st = baseState();
  const t = nowS();
  const by = (uid) => st.sessions.find((s) => s.uid === uid);
  const [c1, c2, z3, x4, x5, l6, u7] = st.sessions;
  c1.label = 'flaky-test'; c1.display_name = 'flaky-test'; c1.title = 'flaky-test';
  c1.tab_color = 'blue'; c1.project = 1; c1.state_since = t - 48;
  c2.tab_color = 'purple'; c2.project = 2; c2.state_since = t - 184;
  x4.path = '/Users/me/src/site'; x4.path_display = '~/src/site'; x4.name = 'codex'; x4.display_name = 'docs PRs';
  x4.label = 'docs PRs'; x4.title = 'docs PRs'; x4.last_change = t - 22 * 60; x4.state_since = t - 22 * 60;
  x5.state_since = t - 41; x5.tab_color = 'green'; x5.project = 3; x5.name = 'codex'; x5.display_name = 'cdn-rollout';
  x5.label = 'cdn-rollout'; x5.title = 'cdn-rollout';
  x5.path = '/Users/me/src/infra'; x5.path_display = '~/src/infra';
  z3.last_change = t - 7 * 60;
  l6.name = 'tail -f access.log'; l6.display_name = l6.name; l6.title = l6.name; l6.last_change = t - 1;
  u7.is_dashboard = true; u7.name = 'Ultrawatch'; u7.display_name = 'Ultrawatch'; u7.title = 'Ultrawatch';
  st.projects[2].name = 'infra';
  // Two more agents so the grid has a real wall.
  st.sessions.push(session({
    uid: 'CCCCCCCC-0001-4CCC-8CCC-000000000001', window_id: 311, window_number: 2, tab_index: 4, session_index: 1,
    tab_label: '2.4', tty: '/dev/ttys012', name: '✳ Healthz endpoint', path: '/Users/me/src/api-gateway',
    path_display: '~/src/api-gateway', agent: 'codex', agents: ['codex'], state: 'busy', is_processing: true,
    state_since: t - 95, last_change: t - 1, display_name: '✳ Healthz endpoint', title: '✳ Healthz endpoint',
    tab_color: 'blue', project: 1,
  }));
  st.sessions.push(session({
    uid: 'CCCCCCCC-0002-4CCC-8CCC-000000000002', window_id: 104, window_number: 1, tab_index: 5, session_index: 1,
    tab_label: '1.5', tty: '/dev/ttys013', name: '✳ README install', path: '/Users/me/src/omniwatch',
    path_display: '~/src/omniwatch', agent: 'claude', agents: ['claude'], state: 'idle', state_since: t - 20,
    last_change: t - 20, fresh_until: t + 10, display_name: '✳ README install', title: '✳ README install',
  }));
  st.sessions.sort((a, b) => (a.window_id - b.window_id) || (a.tab_index - b.tab_index));
  st.screens = {};
  const put = (uid, text) => { st.screens[uid] = { hash: crcHex(text), text }; const s = by(uid); if (s) s.screen_hash = crcHex(text); };
  put(c1.uid, SCREENS.claudeBusy(0, 12));
  put(c2.uid, SCREENS.claudeBash());
  put(z3.uid, SCREENS.zsh());
  put(x4.uid, SCREENS.codexIdle());
  put(x5.uid, SCREENS.codexApprove());
  put(l6.uid, SCREENS.log(30));
  put(u7.uid, SCREENS.ultrawatch());
  put('CCCCCCCC-0001-4CCC-8CCC-000000000001', SCREENS.codexBusy(0));
  put('CCCCCCCC-0002-4CCC-8CCC-000000000002', SCREENS.docs());
  st.iterm.last_poll_at = t;
  recomputeSummary(st);
  return st;
}

function manyScenario() {
  const st = defaultScenario();
  const t = nowS();
  const states = ['busy', 'idle', 'waiting', 'quiet', 'active', 'idle', 'busy', 'quiet'];
  const projects = ['api-gateway', 'billing', 'infra', 'site', 'mobile', 'search', 'etl', 'auth', 'docs', 'ml'];
  const sessions = [];
  const screens = {};
  for (let i = 0; i < 240; i += 1) {
    const w = 1 + Math.floor(i / 40);
    const tab = 1 + (i % 40);
    const state = states[i % states.length];
    const agent = i % 3 === 0 ? 'claude' : (i % 3 === 1 ? 'codex' : null);
    const proj = projects[i % projects.length];
    const uid = `DDDDDDDD-${String(i).padStart(4, '0')}-4DDD-8DDD-${String(i).padStart(12, '0')}`;
    const text = agent === 'claude' ? SCREENS.docs() : (agent === 'codex' ? SCREENS.codexIdle() : SCREENS.zsh());
    screens[uid] = { hash: crcHex(text), text };
    sessions.push(session({
      uid, window_id: 1000 + w, window_number: w, tab_index: tab, tab_label: `${w}.${tab}`, tty: `/dev/ttys${100 + i}`,
      name: agent ? `✳ Task ${i}` : 'zsh', path: `/Users/me/src/${proj}`, path_display: `~/src/${proj}`,
      agent, agents: agent ? [agent] : [], state: agent ? state : (state === 'active' ? 'active' : 'quiet'),
      state_since: t - 30 - i * 13, last_change: t - 5 - i * 11, display_name: agent ? `✳ Task ${i}` : 'zsh',
      title: agent ? `✳ Task ${i}` : 'zsh', screen_hash: screens[uid].hash,
      prompt: agent && state === 'waiting' ? clone(FIXTURE.sessions[1].prompt) : null,
    }));
  }
  st.sessions = sessions;
  st.screens = screens;
  st.windows = Array.from({ length: 6 }, (_, i) => ({ id: 1001 + i, number: i + 1 }));
  recomputeSummary(st);
  return st;
}

function scenario(name) {
  let st;
  switch (name) {
    case 'many': st = manyScenario(); break;
    case 'empty':
      st = defaultScenario(); st.sessions = []; st.screens = {}; st.windows = [];
      st.usage.claude = { status: 'inactive', fetched_at: null, stale_since: null, limits: [] };
      st.usage.codex = { status: 'inactive', fetched_at: null, stale_since: null, limits: [] };
      break;
    case 'connecting':
      st = defaultScenario(); st.sessions = []; st.screens = {}; st.windows = [];
      st.iterm = { status: 'connecting', error: '', last_poll_at: null, poll_ms: null, stale: false };
      break;
    case 'not-running':
      st = defaultScenario(); st.sessions = []; st.screens = {}; st.windows = [];
      st.iterm = { status: 'not_running', error: '', last_poll_at: nowS(), poll_ms: 40, stale: false };
      st.usage.claude = { status: 'inactive', fetched_at: null, stale_since: null, limits: [] };
      st.usage.codex = { status: 'inactive', fetched_at: null, stale_since: null, limits: [] };
      break;
    case 'not-authorized':
      st = defaultScenario(); st.sessions = []; st.screens = {}; st.windows = [];
      st.iterm = { status: 'not_authorized', error: 'Not authorized to send Apple events to iTerm2. (-1743)', last_poll_at: nowS(), poll_ms: 60, stale: false };
      break;
    case 'error':
      st = defaultScenario();
      st.iterm = { status: 'error', error: 'osascript timed out after 10s', last_poll_at: nowS() - 14, poll_ms: 10000, stale: true };
      break;
    case 'stale':
      st = defaultScenario();
      st.iterm = { ...st.iterm, last_poll_at: nowS() - 12, stale: true };
      break;
    case 'usage-errors':
      st = defaultScenario();
      st.usage.claude = { ...st.usage.claude, status: 'stale', stale_since: nowS() - 240, fetched_at: nowS() - 720 };
      st.usage.codex = { status: 'error', fetched_at: null, stale_since: null, limits: [] };
      break;
    case 'no-creds':
      st = defaultScenario();
      st.usage.claude = { status: 'no_credentials', fetched_at: null, stale_since: null, limits: [] };
      st.usage.codex = { status: 'no_credentials', fetched_at: null, stale_since: null, limits: [] };
      break;
    case 'no-agents':
      st = defaultScenario();
      st.usage.claude = { status: 'inactive', fetched_at: null, stale_since: null, limits: [] };
      st.usage.codex = { status: 'inactive', fetched_at: null, stale_since: null, limits: [] };
      break;
    case 'onboarding':
      st = defaultScenario(); st.prefs.onboarding_done = false; break;
    case 'quota':
      st = defaultScenario(); st.quota_prompt = { pct: 91, to: 'me@example.com' }; break;
    case 'no-colors':
      st = defaultScenario(); st.capabilities.tab_colors = false; break;
    default:
      st = defaultScenario();
  }
  recomputeSummary(st);
  return st;
}

function recomputeSummary(st) {
  const tabs = new Set(st.sessions.map((s) => `${s.window_id}:${s.tab_index}`));
  const waiting = st.sessions.filter((s) => s.state === 'waiting').sort((a, b) => a.state_since - b.state_since);
  st.summary = {
    tabs: tabs.size,
    agents: st.sessions.filter((s) => s.agent).length,
    waiting: waiting.length,
    busy: st.sessions.filter((s) => s.state === 'busy').length,
    waiting_uids: waiting.map((s) => s.uid),
  };
  const ids = [...new Set(st.sessions.map((s) => s.window_id))];
  if (st.sessions.length) {
    st.windows = ids.map((id) => ({ id, number: st.sessions.find((s) => s.window_id === id).window_number }));
  }
}

function diagnosticsFor(st) {
  const status = st.iterm.status;
  return {
    python: { path: '/opt/homebrew/bin/python3', version: '3.13.2' },
    iterm: { status, error: st.iterm.error },
    automation: status === 'not_authorized' ? 'denied' : (status === 'ok' ? 'ok' : 'unknown'),
    tab_colors: { package: st.capabilities.tab_colors !== false, reachable: st.capabilities.tab_colors },
    claude_credentials: st.usage.claude ? st.usage.claude.status !== 'no_credentials' : false,
    codex_credentials: st.usage.codex ? st.usage.codex.status !== 'no_credentials' : false,
    config_dir: '/Users/me/.config/omniwatch',
    log_path: '/Users/me/Library/Logs/Omniwatch/backend.log',
  };
}

// ----------------------------------------------------------------- server

export async function startMockServer({
  port = 0, token = crypto.randomBytes(24).toString('base64url'), scenarioName = 'default', animate = true,
  quiet = false, requireAuth = true,
} = {}) {
  let st = scenario(scenarioName);
  let currentScenario = scenarioName;
  let seq = st.seq || 1;
  let actionSeq = 0;
  let frame = 0;
  const started = Date.now();
  const clients = new Set();
  const timers = new Set();
  const log = quiet ? () => {} : (...a) => console.error('[mock]', ...a);

  const later = (ms, fn) => {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t);
    return t;
  };

  function frameSse(event, data) {
    seq += 1;
    return `id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }
  function broadcast(event, data) {
    const chunk = frameSse(event, data);
    for (const res of clients) res.write(chunk);
  }
  function fullState() {
    st.seq = seq;
    st.server_time = nowS();
    return st;
  }
  function pushSessions() {
    recomputeSummary(st);
    broadcast('sessions', { seq: seq + 1, sessions: st.sessions, summary: st.summary, windows: st.windows, iterm: st.iterm });
  }
  function setScreen(uid, text) {
    const hash = crcHex(text);
    st.screens[uid] = { hash, text };
    const s = st.sessions.find((x) => x.uid === uid);
    if (s) s.screen_hash = hash;
    return { [uid]: { hash, text } };
  }
  function pushScreens(screens, removed = []) {
    broadcast('screens', { seq: seq + 1, screens, removed });
  }
  function transition(s, from, to) {
    s.state = to;
    s.state_since = nowS();
    if (to === 'waiting') s.attention = true;
    else s.attention = false;
    broadcast('transition', {
      uid: s.uid, from, to, at: nowS(), title: s.title, agent: s.agent, prompt: s.prompt, muted: s.muted,
    });
  }
  function actionResult(kind, uid, ok, detail = '') {
    const id = `a-${++actionSeq}`;
    later(250, () => broadcast('action', { id, kind, uid, ok, detail }));
    return id;
  }
  function usageForPrefs() {
    const u = clone(st.usage);
    const lim = u.claude && u.claude.limits ? u.claude.limits.find((l) => l.id === 'claude.monthly') : null;
    if (lim) lim.limit_display = st.prefs.show_dollars ? '$182 of $200' : null;
    return u;
  }

  // Scripted timeline: the busy Claude (1.1) needs an edit approval every
  // ~30 s; the busy Codex keeps spinning; the log tails.
  let cycle = 0;
  function tick() {
    frame += 1;
    cycle += 1;
    st.iterm.last_poll_at = nowS();
    const screens = {};
    const c1 = st.sessions.find((s) => s.uid === 'AAAAAAAA-0001-4AAA-8AAA-000000000001');
    const cx = st.sessions.find((s) => s.uid === 'CCCCCCCC-0001-4CCC-8CCC-000000000001');
    const log6 = st.sessions.find((s) => s.uid === 'BBBBBBBB-0002-4BBB-8BBB-000000000002');
    let sessionsChanged = false;
    if (c1 && c1.state === 'busy') {
      Object.assign(screens, setScreen(c1.uid, SCREENS.claudeBusy(frame, 12 + cycle)));
      c1.last_change = nowS();
      if (cycle % 30 === 8) {
        c1.prompt = {
          question: 'Do you want to make this edit to retry.ts?',
          options: [
            { key: '1', label: 'Yes', selected: true },
            { key: '2', label: "Yes, and don't ask again this session (shift+tab)", selected: false },
            { key: '3', label: 'No, and tell Claude what to do differently (esc)', selected: false },
          ],
          free_text: false,
        };
        c1.is_processing = false;
        Object.assign(screens, setScreen(c1.uid, SCREENS.claudeEdit()));
        transition(c1, 'busy', 'waiting');
        sessionsChanged = true;
      }
    } else if (c1 && c1.state === 'waiting' && cycle % 30 === 0) {
      // "Answered in iTerm2" — goes back to work.
      c1.prompt = null; c1.is_processing = true;
      transition(c1, 'waiting', 'busy');
      sessionsChanged = true;
    }
    for (const s of st.sessions) {
      if (s._replied && s.state === 'busy') {
        Object.assign(screens, setScreen(s.uid, SCREENS.claudeReplied(s._replied, frame)));
        s.last_change = nowS();
      }
    }
    if (cx && cx.state === 'busy') {
      Object.assign(screens, setScreen(cx.uid, SCREENS.codexBusy(frame)));
      cx.last_change = nowS();
    }
    if (log6 && frame % 2 === 0) {
      Object.assign(screens, setScreen(log6.uid, SCREENS.log(30 + frame / 2)));
      log6.last_change = nowS();
      sessionsChanged = sessionsChanged || frame % 10 === 0;
    }
    if (Object.keys(screens).length) pushScreens(screens);
    if (sessionsChanged) pushSessions();
  }

  let interval = null;
  if (animate) interval = setInterval(tick, 1000);

  // Heartbeat (§4.4.2): ": ping" every 15 s.
  const heartbeat = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 15000);

  function sendJson(res, status, body, headers = {}) {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(data);
  }
  function err(res, status, code, message) {
    sendJson(res, status, { ok: false, error: { code, message } });
  }
  function readBody(req) {
    return new Promise((resolve) => {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
      req.on('end', () => {
        if (!raw) return resolve({ ok: true, body: {} });
        try { return resolve({ ok: true, body: JSON.parse(raw) }); } catch (_) { return resolve({ ok: false }); }
      });
    });
  }
  function authorized(req) {
    if (!requireAuth) return true;
    const auth = req.headers.authorization || '';
    if (auth === `Bearer ${token}`) return true;
    const cookie = req.headers.cookie || '';
    return cookie.split(/;\s*/).some((c) => c === `ow_session=${token}`);
  }

  function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.resolve(WEB_ROOT, `.${rel}`);
    if (!file.startsWith(WEB_ROOT + path.sep)) return err(res, 404, 'not_found', 'not found');
    fs.readFile(file, (e, buf) => {
      if (e) return err(res, 404, 'not_found', 'not found');
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Content-Security-Policy': CSP,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(buf);
    });
    return undefined;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const { pathname } = url;
    const host = req.headers.host || '';
    const addr = server.address();
    const okHosts = [`127.0.0.1:${addr.port}`, `localhost:${addr.port}`];
    if (!okHosts.includes(host)) return err(res, 403, 'forbidden', 'bad Host header');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      const bearer = (req.headers.authorization || '').startsWith('Bearer ');
      // §4.5: Origin must equal ours, or be absent with a Bearer token (CSRF).
      if (origin ? !okHosts.map((h) => `http://${h}`).includes(origin) : (requireAuth && !bearer)) {
        return err(res, 403, 'forbidden', 'bad Origin');
      }
    }
    if (pathname === '/auth') {
      if (url.searchParams.get('token') !== token) return err(res, 401, 'unauthorized', 'bad token');
      res.writeHead(302, { Location: '/', 'Set-Cookie': `ow_session=${token}; HttpOnly; SameSite=Strict; Path=/` });
      return res.end();
    }
    if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
    if (!authorized(req)) return err(res, 401, 'unauthorized', 'missing or bad token');

    const m = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/(goto|visit|label|color|mute|close|reply)$/);
    const route = `${req.method} ${m ? `/api/v1/sessions/:uid/${m[2]}` : pathname}`;
    const uid = m ? decodeURIComponent(m[1]) : null;
    const s = uid ? st.sessions.find((x) => x.uid === uid) : null;
    const needsBody = ['PUT', 'POST', 'PATCH', 'DELETE'].includes(req.method);
    const parsed = needsBody ? await readBody(req) : { ok: true, body: {} };
    if (!parsed.ok) return err(res, 400, 'bad_request', 'invalid JSON');
    const body = parsed.body || {};
    if (m && !s) return err(res, 404, 'not_found', 'session not found');

    switch (route) {
      case 'GET /api/v1/health':
        return sendJson(res, 200, { ok: true, version: st.version, demo: true, pid: process.pid, uptime_s: (Date.now() - started) / 1000 });
      case 'GET /api/v1/state':
        return sendJson(res, 200, fullState());
      case 'GET /api/v1/summary': {
        recomputeSummary(st);
        const waiting = st.sessions.filter((x) => x.state === 'waiting').sort((a, b) => a.state_since - b.state_since);
        return sendJson(res, 200, {
          tabs: st.summary.tabs, agents: st.summary.agents, waiting: st.summary.waiting, busy: st.summary.busy,
          waiting_sessions: waiting.map((x) => ({ uid: x.uid, title: x.title, since: x.state_since, agent: x.agent })),
        });
      }
      case 'GET /api/v1/events': {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive',
        });
        res.write('retry: 1000\n\n');
        res.write(frameSse('hello', { version: st.version, server_time: nowS(), demo: true }));
        res.write(frameSse('state', fullState()));
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return undefined;
      }
      case 'GET /api/v1/diagnostics':
        return sendJson(res, 200, diagnosticsFor(st));
      case 'POST /api/v1/diagnostics/probe-automation': {
        const id = actionResult('probe', null, true);
        if (st.iterm.status === 'not_authorized') {
          later(1200, () => {
            const fresh = defaultScenario();
            st.sessions = fresh.sessions; st.screens = fresh.screens; st.iterm = fresh.iterm;
            broadcast('screens', { seq: seq + 1, screens: st.screens, removed: [] });
            pushSessions();
          });
        }
        return sendJson(res, 202, { ok: true, action_id: id });
      }
      case 'POST /api/v1/sessions/:uid/goto':
        return sendJson(res, 202, { ok: true, action_id: actionResult('goto', uid, true) });
      case 'POST /api/v1/sessions/:uid/visit':
        if (s.attention) { s.attention = false; pushSessions(); }
        return sendJson(res, 200, { ok: true });
      case 'PUT /api/v1/sessions/:uid/label': {
        if (typeof body.label !== 'string') return err(res, 422, 'invalid', 'label must be a string');
        const label = body.label.trim().slice(0, 80);
        s.label = label; s.display_name = label || s.name; s.title = label || s.path_display || s.name;
        pushSessions();
        return sendJson(res, 200, { ok: true, label });
      }
      case 'PUT /api/v1/sessions/:uid/color': {
        if (st.capabilities.tab_colors === false) return err(res, 503, 'tab_colors_unavailable', 'tab colors unavailable');
        let color;
        if (Number.isInteger(body.project) && body.project >= 1 && body.project <= 5) color = st.projects[body.project - 1].color;
        else if (body.color === null || typeof body.color === 'string') color = body.color;
        else return err(res, 422, 'invalid', 'project 1..5 or color required');
        const id = actionResult('color', uid, true);
        later(300, () => {
          s.tab_color = color;
          const p = st.projects.find((x) => x.color === color);
          s.project = p ? p.slot : null;
          pushSessions();
        });
        return sendJson(res, 202, { ok: true, action_id: id });
      }
      case 'PUT /api/v1/sessions/:uid/mute':
        if (typeof body.muted !== 'boolean') return err(res, 422, 'invalid', 'muted must be a boolean');
        s.muted = body.muted;
        pushSessions();
        return sendJson(res, 200, { ok: true, muted: s.muted });
      case 'POST /api/v1/sessions/:uid/close': {
        if (body.confirm !== true) return err(res, 400, 'bad_request', 'confirm required');
        const id = actionResult('close', uid, true);
        later(400, () => {
          st.sessions = st.sessions.filter((x) => !(x.window_id === s.window_id && x.tab_index === s.tab_index));
          const removed = Object.keys(st.screens).filter((k) => !st.sessions.some((x) => x.uid === k));
          removed.forEach((k) => delete st.screens[k]);
          pushScreens({}, removed);
          pushSessions();
        });
        return sendJson(res, 202, { ok: true, action_id: id });
      }
      case 'POST /api/v1/sessions/:uid/reply': {
        if (!s.agent || s.state !== 'waiting') return err(res, 422, 'invalid', 'not an agent session waiting for input');
        if (typeof body.text !== 'string' || !body.text.length || body.text.length > 2000) return err(res, 400, 'bad_request', 'text must be 1..2000 chars');
        // eslint-disable-next-line no-control-regex
        if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(body.text)) return err(res, 400, 'bad_request', 'control characters are not allowed');
        const age = nowS() - (st.iterm.last_poll_at || 0);
        if (body.expect_hash !== s.screen_hash || age > 5) return err(res, 409, 'stale_screen', 'the screen changed since the reply was composed');
        const id = actionResult('reply', uid, true);
        later(600, () => {
          const opt = (s.prompt && s.prompt.options || []).find((o) => o.key === body.text);
          s._replied = opt ? `${opt.key}. ${opt.label}` : JSON.stringify(body.text);
          s.prompt = null; s.is_processing = true;
          transition(s, 'waiting', 'busy');
          pushScreens(setScreen(s.uid, SCREENS.claudeReplied(s._replied, frame)));
          pushSessions();
          later(8000, () => {
            if (s.state !== 'busy') return;
            delete s._replied;
            transition(s, 'busy', 'idle');
            s.is_processing = false; s.last_change = nowS(); s.fresh_until = nowS() + 30;
            pushScreens(setScreen(s.uid, SCREENS.docs()));
            pushSessions();
          });
        });
        return sendJson(res, 202, { ok: true, action_id: id });
      }
      case 'POST /api/v1/tabs/new': {
        const id = actionResult('new', null, true);
        later(500, () => {
          const w1 = st.sessions.filter((x) => x.window_id === 104);
          const tab = w1.reduce((mx, x) => Math.max(mx, x.tab_index), 0) + 1;
          const uid2 = crypto.randomUUID().toUpperCase();
          const text = 'Last login: Fri Sep 25 10:02:11 on ttys020\n~ ❯ ';
          st.sessions.push(session({ uid: uid2, window_id: 104, window_number: 1, tab_index: tab, tab_label: `1.${tab}`, state: 'quiet', last_change: nowS(), state_since: nowS() }));
          st.sessions.sort((a, b) => (a.window_id - b.window_id) || (a.tab_index - b.tab_index));
          pushScreens(setScreen(uid2, text));
          pushSessions();
        });
        return sendJson(res, 202, { ok: true, action_id: id });
      }
      case 'POST /api/v1/iterm/launch': {
        const id = actionResult('launch', null, true);
        if (st.iterm.status === 'not_running') {
          later(1200, () => {
            const fresh = defaultScenario();
            st.sessions = fresh.sessions; st.screens = fresh.screens; st.iterm = fresh.iterm; st.usage = fresh.usage;
            broadcast('screens', { seq: seq + 1, screens: st.screens, removed: [] });
            broadcast('usage', { seq: seq + 1, usage: usageForPrefs() });
            pushSessions();
          });
        }
        return sendJson(res, 202, { ok: true, action_id: id });
      }
      case 'POST /api/v1/refresh':
        broadcast('toast', { level: 'info', message: 'refreshing…' });
        later(300, () => { st.iterm.last_poll_at = nowS(); pushSessions(); });
        return sendJson(res, 200, { ok: true });
      case 'GET /api/v1/prefs':
        return sendJson(res, 200, st.prefs);
      case 'PATCH /api/v1/prefs': {
        for (const [k, v] of Object.entries(body)) {
          const t = PREF_TYPES[k];
          if (!t) return err(res, 422, 'invalid', `unknown pref ${k}`);
          const ok = Array.isArray(t) ? t.includes(v) : (typeof v === t && v !== null); // eslint-disable-line valid-typeof
          if (!ok) return err(res, 422, 'invalid', `bad value for ${k}`);
        }
        const dollarsChanged = 'show_dollars' in body && body.show_dollars !== st.prefs.show_dollars;
        st.prefs = { ...st.prefs, ...body };
        if ('split_ratio' in body) st.prefs.split_ratio = Math.max(0.2, Math.min(0.8, body.split_ratio));
        if ('font_scale' in body) st.prefs.font_scale = Math.max(0.8, Math.min(1.6, body.font_scale));
        broadcast('prefs', { seq: seq + 1, prefs: st.prefs, projects: st.projects });
        if (dollarsChanged) broadcast('usage', { seq: seq + 1, usage: usageForPrefs() });
        return sendJson(res, 200, st.prefs);
      }
      case 'DELETE /api/v1/projects':
        if (body.confirm !== true) return err(res, 400, 'bad_request', 'confirm required');
        st.projects = st.projects.map((p) => ({ ...p, name: '' }));
        broadcast('prefs', { seq: seq + 1, prefs: st.prefs, projects: st.projects });
        return sendJson(res, 200, { ok: true, projects: st.projects });
      case 'POST /api/v1/quota-email/draft':
      case 'POST /api/v1/quota-email/skip':
        st.quota_prompt = null;
        return sendJson(res, 200, { ok: true });
      case 'POST /api/v1/shutdown':
        sendJson(res, 200, { ok: true });
        setTimeout(() => close(), 50);
        return undefined;
      case 'POST /api/v1/demo/step': {
        const n = Math.max(1, Math.round(Number(body.seconds) || 1));
        for (let i = 0; i < n; i += 1) tick();
        return sendJson(res, 200, { ok: true, seq });
      }
      case 'POST /api/v1/demo/scenario': {
        currentScenario = String(body.name || 'default');
        st = scenario(currentScenario);
        cycle = 0;
        broadcast('state', fullState());
        return sendJson(res, 200, { ok: true, seq, scenario: currentScenario });
      }
      case 'POST /api/v1/plugin/focus':
        return sendJson(res, 200, { ok: true });
      default: {
        const pm = pathname.match(/^\/api\/v1\/projects\/(\d+)$/);
        if (pm && req.method === 'PUT') {
          const slot = Number(pm[1]);
          if (slot < 1 || slot > 5) return err(res, 404, 'not_found', 'no such project slot');
          if (typeof body.name !== 'string') return err(res, 422, 'invalid', 'name must be a string');
          st.projects[slot - 1] = { ...st.projects[slot - 1], name: body.name.trim().slice(0, 40) };
          broadcast('prefs', { seq: seq + 1, prefs: st.prefs, projects: st.projects });
          return sendJson(res, 200, { ok: true, project: st.projects[slot - 1] });
        }
        return err(res, 404, 'not_found', `no route ${req.method} ${pathname}`);
      }
    }
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actualPort = server.address().port;
  const url = `http://127.0.0.1:${actualPort}`;
  log(`scenario ${currentScenario}; open ${url}/auth?token=${token}`);

  async function close() {
    if (interval) clearInterval(interval);
    clearInterval(heartbeat);
    for (const t of timers) clearTimeout(t);
    for (const res of clients) res.end();
    clients.clear();
    await new Promise((resolve) => server.close(resolve));
  }

  return {
    port: actualPort, token, url, authUrl: `${url}/auth?token=${token}`, close,
    step: (n = 1) => { for (let i = 0; i < n; i += 1) tick(); },
    get state() { return st; },
  };
}

// ------------------------------------------------------------------- CLI

function parseArgs(argv) {
  const out = { port: 8765, token: null, scenarioName: 'default', animate: true, readyJson: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--token') out.token = argv[++i];
    else if (a === '--scenario') out.scenarioName = argv[++i];
    else if (a === '--no-animate') out.animate = false;
    else if (a === '--ready-json') out.readyJson = true;
    else if (a === '--help' || a === '-h') {
      console.log('usage: node web-tests/mock-server.mjs [--port 8765] [--token T] [--scenario NAME] [--no-animate] [--ready-json]');
      process.exit(0);
    }
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const srv = await startMockServer({
    port: args.port, scenarioName: args.scenarioName, animate: args.animate,
    ...(args.token ? { token: args.token } : {}), quiet: true,
  });
  if (args.readyJson) {
    console.log(JSON.stringify({ event: 'ready', port: srv.port, token: srv.token, pid: process.pid, version: '1.0.0', demo: true }));
  } else {
    console.log(`Omniwatch mock server → ${srv.authUrl}`);
  }
  const stop = async () => { await srv.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
