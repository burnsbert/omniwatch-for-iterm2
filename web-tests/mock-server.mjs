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
// Matches the real backend as documented in docs/API.md (routes, error codes
// and validation order, `ok:true` envelopes, bare prefs, action kinds and
// details, 202 + immediate `action` for color, SSE ids/ordering, no replay,
// no `sessions` event for poll-only changes, prefs/labels/projects kept
// across scenario resets). Scenarios: the real ones (default, empty,
// not-running, not-authorized, many, usage-errors) plus mock-only extras
// (connecting, error, stale, no-creds, no-agents, onboarding, quota,
// no-colors). `POST /api/v1/demo/scenario {"name":…}` switches at runtime.
//
// Also importable: `const srv = await startMockServer({port:0}); srv.url; await srv.close()`.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { formatAbsTime } from '../omniwatch/web/js/format.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..', 'omniwatch', 'web');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'state.json'), 'utf8'));

const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'";
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
  '.ico': 'image/x-icon',
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
  vite: () => [
    '  VITE v5.4.2  ready in 312 ms',
    '',
    '  ➜  Local:   http://localhost:5173/',
    '  ➜  Network: use --host to expose',
    '  ➜  press h + enter to show help',
    '',
    '10:02:11 AM [vite] hmr update /src/components/Nav.tsx',
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
// The mock clock: wall time plus whatever /demo/step has advanced (like the
// real demo clock, API.md §9).
let clockOffset = 0;
const nowS = () => Date.now() / 1000 + clockOffset;

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
    stalled: false, stalled_since: null, ribbon: null,
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
  u7.path = '/Users/me/src/tools'; u7.path_display = '~/src/tools'; u7.name = 'node'; u7.display_name = 'node';
  u7.title = '~/src/tools'; u7.is_dashboard = false; u7.muted = false;
  st.projects[2].name = 'infra';
  st.quota_prompt = { pct: 91.0, to: 'you@example.com' }; // the real demo raises it at startup
  // Two more agents so the grid has a real wall.
  st.sessions.push(session({
    uid: 'CCCCCCCC-0001-4CCC-8CCC-000000000001', window_id: 311, window_number: 2, tab_index: 4, session_index: 1,
    tab_label: '2.4', tty: '/dev/ttys012', name: '✳ Healthz endpoint', path: '/Users/me/src/api-gateway',
    path_display: '~/src/api-gateway', agent: 'codex', agents: ['codex'], state: 'busy', is_processing: true,
    state_since: t - 21 * 60, last_change: t - 14 * 60, display_name: '✳ Healthz endpoint', title: '✳ Healthz endpoint',
    tab_color: 'blue', project: 1, _lastScreenChange: t - 14 * 60, // unchanged screen → stalled at start
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
  put(u7.uid, SCREENS.vite());
  put('CCCCCCCC-0001-4CCC-8CCC-000000000001', SCREENS.codexBusy(0));
  put('CCCCCCCC-0002-4CCC-8CCC-000000000002', SCREENS.docs());
  st.iterm.last_poll_at = t;
  st.stats = { day: localDay(t), waiting_seconds: 4980, longest_wait_s: 780, answered: 14, waits: 16, active: [] };
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

// The real backend's scenarios (omniwatch/demo/scenario.py) plus mock-only
// extras for UI states the real demo can't produce on demand.
export const REAL_SCENARIOS = Object.freeze(['default', 'empty', 'not-running', 'not-authorized', 'many', 'usage-errors']);
export const MOCK_ONLY_SCENARIOS = Object.freeze(['connecting', 'error', 'stale', 'no-creds', 'no-agents', 'onboarding', 'quota', 'no-colors']);
const SCENARIO_NAMES = [...REAL_SCENARIOS, ...MOCK_ONLY_SCENARIOS];

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
      st.iterm = { status: 'error', error: 'osascript timed out after 10s', last_poll_at: nowS() - 14,
                  poll_ms: 10000, stale: true, consecutive_failures: 3, slow: false };
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
      st = defaultScenario(); break;
    case 'no-colors':
      st = defaultScenario(); st.capabilities.tab_colors = false; break;
    default:
      st = defaultScenario();
  }
  recomputeSummary(st);
  return st;
}

function recomputeSummary(st) {
  const waiting = st.sessions.filter((s) => s.state === 'waiting').sort((a, b) => a.state_since - b.state_since);
  st.summary = {
    tabs: st.sessions.length, // API.md §5: summary.tabs counts sessions
    agents: st.sessions.filter((s) => s.agent).length,
    waiting: waiting.length,
    busy: st.sessions.filter((s) => s.state === 'busy').length,
    stalled: st.sessions.filter((s) => s.stalled).length,
    waiting_uids: waiting.map((s) => s.uid),
  };
  const ids = [...new Set(st.sessions.map((s) => s.window_id))];
  if (st.sessions.length) {
    st.windows = ids.map((id) => ({ id, number: st.sessions.find((s) => s.window_id === id).window_number }));
  }
}

function localDay(t) {
  const d = new Date(t * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const STATE_CODE = { waiting: 'w', busy: 'b', idle: 'i', active: 'a', quiet: 'q' };
const CODE_STATE = { w: 'waiting', b: 'busy', i: 'idle', a: 'active', q: 'quiet' };
const RIBBON_N = 48;
const BUCKET = 600;

/** Deterministic 8 h ribbon (API.md §5) ending in the session's live state. */
function seedRibbon(s) {
  if (!s.state) return null;
  let seed = parseInt(crcHex(s.uid), 16) || 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const codes = [];
  if (!s.agent) {
    const c = STATE_CODE[s.state] || 'q';
    for (let i = 0; i < RIBBON_N; i += 1) codes.push(i < 6 && rnd() < 0.5 ? '-' : (rnd() < 0.15 ? (c === 'a' ? 'q' : 'a') : c));
  } else {
    let cur = 'i';
    for (let i = 0; i < RIBBON_N; i += 1) {
      const r = rnd();
      if (cur === 'b') cur = r < 0.12 ? 'w' : (r < 0.2 ? 'i' : 'b');
      else if (cur === 'w') cur = r < 0.6 ? 'b' : 'w';
      else cur = r < 0.3 ? 'b' : 'i';
      codes.push(cur);
    }
  }
  codes[RIBBON_N - 1] = STATE_CODE[s.state] || 'q';
  return { end: Math.ceil(nowS() / BUCKET) * BUCKET, bucket_s: BUCKET, codes: codes.join('') };
}

/** Keep a ribbon current: roll buckets forward and stamp the live state. */
function touchRibbon(s) {
  if (!s.state) {
    s.ribbon = null;
    return;
  }
  if (!s.ribbon) s.ribbon = seedRibbon(s);
  const end = Math.ceil(nowS() / BUCKET) * BUCKET;
  let { codes } = s.ribbon;
  const shift = Math.round((end - s.ribbon.end) / BUCKET);
  if (shift > 0) codes = (codes + codes.slice(-1).repeat(Math.min(shift, RIBBON_N))).slice(-RIBBON_N);
  const c = STATE_CODE[s.state] || 'q';
  const last = codes.slice(-1);
  // The live bucket shows the state that "held longest"; a waiting/busy flip wins (ties w > b > …).
  const rank = 'wbiaq-';
  if (rank.indexOf(c) < rank.indexOf(last) || shift > 0) codes = codes.slice(0, -1) + c;
  s.ribbon = { end, bucket_s: BUCKET, codes };
}

/** GET /sessions/{uid}/history from the ribbon (API.md §5 History shape). */
function historyFor(s, hours) {
  const to = nowS();
  const from = to - hours * 3600;
  const r = s.ribbon || seedRibbon(s) || { end: to, codes: '' };
  const segs = [];
  Array.from(r.codes).forEach((c, i) => {
    const start = r.end - (r.codes.length - i) * BUCKET;
    const end = start + BUCKET;
    if (end <= from || c === '-') return;
    const state = CODE_STATE[c];
    const last = segs[segs.length - 1];
    if (last && last.state === state && last.end === Math.max(from, start)) last.end = Math.min(to, end);
    else segs.push({ state, start: Math.max(from, start), end: Math.min(to, end) });
  });
  if (segs.length) segs[segs.length - 1].end = null;
  const totals = {};
  for (const seg of segs) {
    const k = seg.state || 'unknown';
    totals[k] = (totals[k] || 0) + ((seg.end == null ? to : seg.end) - seg.start);
  }
  return { uid: s.uid, from, to, hours, segments: segs, totals, transitions: Math.max(0, segs.length - 1) };
}

const WINDOW_S = { '5h': 5 * 3600, '7d': 7 * 86400, month: 30 * 86400 };

/** Sawtooth usage points ending at the live percentage, plus Burn (API.md §5). */
function usageSeries(limit, now, hours) {
  const L = WINDOW_S[limit.window] || 7 * 86400;
  const cur = Number(limit.pct) || 0;
  const elapsed = Math.min(L * 0.8, { '5h': 3 * 3600, '7d': 36 * 3600, month: 20 * 86400 }[limit.window] || 36 * 3600);
  const s0 = now - elapsed;
  const pts = [];
  for (let t = now - hours * 3600; t <= now + 1; t += 900) {
    const v = t >= s0 ? cur * ((t - s0) / Math.max(1, now - s0)) : 70 * ((((t - (s0 - L)) % L) + L) % L) / L;
    pts.push([Math.round(t), Math.round(Math.max(0, v) * 10) / 10]);
  }
  pts[pts.length - 1] = [Math.round(now), cur];
  const rate = cur / Math.max(1 / 60, (now - s0) / 3600);
  const base = { rate_per_hour: Math.round(rate * 100) / 100, eta: null, before_reset: false, at_reset_pct: null };
  let burn;
  if (cur >= 100) burn = { ...base, text: 'limit hit' };
  else if (rate <= 0) burn = { ...base, rate_per_hour: 0, text: 'not rising' };
  else {
    const eta = Math.round(now + ((100 - cur) / rate) * 3600);
    if (!limit.resets_at || eta < limit.resets_at) {
      burn = { ...base, eta, before_reset: true, text: `at this rate: 100% ${formatAbsTime(new Date(eta * 1000), new Date(now * 1000))}` };
    } else {
      const atReset = Math.round((cur + rate * ((limit.resets_at - now) / 3600)) * 10) / 10;
      burn = { ...base, at_reset_pct: atReset, text: `at this rate: ~${Math.round(atReset)}% at reset` };
    }
  }
  return { points: pts, burn };
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
    demo: true,
  };
}

// ----------------------------------------------------------------- server

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const bad = (m) => new ApiError(400, 'bad_request', m);
const invalid = (m) => new ApiError(422, 'invalid', m);
const notFound = (m) => new ApiError(404, 'not_found', m);

// Same table as omniwatch/server.py ROUTES (the paths this mock implements).
const ROUTES = [
  ['GET', '/api/v1/health', 'health'], ['GET', '/api/v1/state', 'state'], ['GET', '/api/v1/events', 'events'],
  ['GET', '/api/v1/summary', 'summary'], ['GET', '/api/v1/diagnostics', 'diagnostics'],
  ['POST', '/api/v1/diagnostics/probe-automation', 'probe'],
  ['POST', '/api/v1/sessions/{uid}/goto', 'goto'], ['POST', '/api/v1/sessions/{uid}/visit', 'visit'],
  ['PUT', '/api/v1/sessions/{uid}/label', 'label'], ['PUT', '/api/v1/sessions/{uid}/color', 'color'],
  ['PUT', '/api/v1/sessions/{uid}/mute', 'mute'], ['POST', '/api/v1/sessions/{uid}/close', 'close'],
  ['POST', '/api/v1/sessions/{uid}/reply', 'reply'], ['POST', '/api/v1/sessions/{uid}/reveal', 'reveal'],
  ['GET', '/api/v1/sessions/{uid}/history', 'history'], ['GET', '/api/v1/usage/history', 'usage_history'],
  ['GET', '/api/v1/stats', 'stats'], ['POST', '/api/v1/tabs/new', 'new_tab'],
  ['POST', '/api/v1/iterm/launch', 'launch'], ['POST', '/api/v1/refresh', 'refresh'],
  ['GET', '/api/v1/prefs', 'get_prefs'], ['PATCH', '/api/v1/prefs', 'patch_prefs'],
  ['PUT', '/api/v1/projects/{slot}', 'set_project'], ['DELETE', '/api/v1/projects', 'clear_projects'],
  ['POST', '/api/v1/quota-email/draft', 'quota_draft'], ['POST', '/api/v1/quota-email/skip', 'quota_skip'],
  ['POST', '/api/v1/plugin/focus', 'plugin_focus'], ['POST', '/api/v1/shutdown', 'shutdown'],
  ['POST', '/api/v1/demo/step', 'demo_step'], ['POST', '/api/v1/demo/scenario', 'demo_scenario'],
].map(([m, p, n]) => [m, p.split('/').filter(Boolean), n]);

function matchRoute(method, pathname) {
  const segs = pathname.split('/').filter(Boolean);
  const allowed = [];
  for (const [m, pat, name] of ROUTES) {
    if (pat.length !== segs.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pat.length; i += 1) {
      if (pat[i].startsWith('{')) {
        const v = decodeURIComponent(segs[i]);
        if (!v) { ok = false; break; }
        params[pat[i].slice(1, -1)] = v;
      } else if (pat[i] !== segs[i]) { ok = false; break; }
    }
    if (!ok) continue;
    if (m === method) return { name, params };
    allowed.push(m);
  }
  if (allowed.length) throw new ApiError(405, 'method_not_allowed', `use ${[...new Set(allowed)].sort().join(', ')}`);
  throw notFound(`no route for ${pathname}`);
}

const PROJECT_COLORS = ['blue', 'purple', 'green', 'red', 'yellow'];
const TAB_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'];
const isBool = (v) => typeof v === 'boolean';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const choice = (...xs) => (v) => xs.includes(v);
const range = (lo, hi) => (v) => isNum(v) && v >= lo && v <= hi;
// omniwatch/engine.py PREF_RULES (the 17 keys in API.md §4).
const PREF_RULES = {
  view: choice('split', 'list', 'grid'), sort: choice('natural', 'attention', 'agents', 'activity', 'path'),
  show_dollars: isBool, sound: isBool, split_ratio: range(0.2, 0.8), projects_open: isBool, grid_all: isBool,
  usage_strip: choice('expanded', 'collapsed'), theme: choice('system', 'dark', 'light', 'high-contrast'), font_scale: range(0.5, 2.0),
  notifications: (v) => !!v && typeof v === 'object' && !Array.isArray(v), quick_reply: isBool, keep_on_top: isBool,
  close_window_on_q: isBool, hint_bar: isBool, debug_rule: isBool, onboarding_done: isBool,
  stall_minutes: (v) => Number.isInteger(v) && typeof v !== 'boolean' && v >= 0 && v <= 240,
  editor: (v) => typeof v === 'string' && v.length <= 200 && !CONTROL.test(v) && shlexOk(v),
};
const NOTIFICATION_RULES = { enabled: isBool, click: choice('goto', 'show'), stall: isBool };

/** Would Python's shlex.split accept it? (balanced quotes, no trailing escape) */
function shlexOk(v) {
  let q = null;
  for (let i = 0; i < v.length; i += 1) {
    const c = v[i];
    if (c === '\\' && q !== "'") {
      if (i === v.length - 1) return false;
      i += 1;
    } else if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
  }
  return q === null;
}
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** engine.clean_text: str, ≤ max, no control characters (except \n when allowed). */
function hoursParam(url, dflt, max) {
  const raw = url.searchParams.get('hours');
  if (raw === null) return dflt;
  const h = Number(raw);
  if (!Number.isFinite(h) || h <= 0 || h > max) throw bad(`hours must be in (0, ${max}]`);
  return h;
}

function cleanText(value, what, max, allowNewline = false) {
  if (typeof value !== 'string') throw bad(`${what} must be a string`);
  if ([...value].length > max) throw invalid(`${what} is longer than ${max} characters`);
  const probe = allowNewline ? value.replace(/\n/g, '') : value;
  if (CONTROL.test(probe)) throw invalid(`${what} contains control characters`);
  return value;
}

export async function startMockServer({
  port = 0, token = crypto.randomBytes(32).toString('base64url').slice(0, 43), scenarioName = 'default', animate = true,
  quiet = false, requireAuth = true,
} = {}) {
  // Prefs, labels and projects live in the "store" and survive scenario
  // resets, as in the real engine (API.md §9).
  const seed = scenario(scenarioName);
  const store = {
    prefs: {
      ...seed.prefs, onboarding_done: false, stall_minutes: 10, editor: '',
      notifications: { enabled: true, click: 'goto', stall: true },
    },
    projects: seed.projects.map((p) => ({ ...p })),
    labels: {},
    muted: {},
    // Raised once per backend run and cleared for good by draft/skip.
    quota: seed.quota_prompt ? { ...seed.quota_prompt } : null,
  };
  let st = null;
  let currentScenario = scenarioName;
  let seq = 1;
  let actionSeq = 0;
  let frame = 0;
  let cycle = 0;
  let generation = 0; // bumps on every scenario reset; stale timers check it
  const started = Date.now();
  const clients = new Set();
  const timers = new Set();
  const log = quiet ? () => {} : (...a) => console.error('[mock]', ...a);

  function load(name) {
    st = scenario(name);
    if (name === 'onboarding') store.prefs.onboarding_done = false;
    st.prefs = store.prefs;
    st.projects = store.projects;
    if (name === 'quota' && !store.quota) store.quota = { pct: 91, to: 'you@example.com' };
    st.quota_prompt = store.quota;
    st.capabilities = { ...st.capabilities, reply: store.prefs.quick_reply !== false, debug_rule: !!store.prefs.debug_rule };
    // Seeded scenario labels are re-applied on every reset and win (API.md §9).
    for (const s of st.sessions) if (s.label) store.labels[s.uid] = s.label;
    for (const s of st.sessions) applyStore(s);
    for (const s of st.sessions) {
      s.ribbon = seedRibbon(s);
      if (s._lastScreenChange === undefined) s._lastScreenChange = s.last_change || nowS();
    }
    if (!st.stats) st.stats = { day: localDay(nowS()), waiting_seconds: 0, longest_wait_s: 0, answered: 0, waits: 0, active: [] };
    st.stats.active = st.sessions.filter((s) => s.agent && s.state === 'waiting')
      .sort((a, b) => a.state_since - b.state_since).map((s) => ({ uid: s.uid, since: s.state_since }));
    updateStalls([], true);
    for (const block of Object.values(st.usage || {})) {
      for (const l of (block && block.limits) || []) l.burn = usageSeries(l, nowS(), 2).burn;
    }
    recomputeSummary(st);
  }

  /**
   * stalled = busy and the screen unchanged for ≥ stall_minutes (0 = off).
   * A `stall` event goes out once per episode, never for sessions already
   * stalled at load (API.md §5/§6).
   */
  function updateStalls(pendingStalls, initial = false) {
    const mins = store.prefs.stall_minutes;
    let changed = false;
    for (const s of st.sessions) {
      const since = s._lastScreenChange || s.last_change || nowS();
      const stalled = !!(mins > 0 && s.state === 'busy' && nowS() - since >= mins * 60);
      if (stalled !== !!s.stalled) {
        changed = true;
        if (stalled && !initial) {
          pendingStalls.push({ uid: s.uid, title: s.title, agent: s.agent, since, minutes: mins, muted: !!s.muted });
        }
      }
      s.stalled = stalled;
      s.stalled_since = stalled ? since : null;
    }
    return changed;
  }
  function applyStore(s) {
    if (Object.prototype.hasOwnProperty.call(store.labels, s.uid)) s.label = store.labels[s.uid];
    if (Object.prototype.hasOwnProperty.call(store.muted, s.uid)) s.muted = store.muted[s.uid];
    s.display_name = s.label || s.name;
    s.title = s.label || s.path_display || s.name || s.uid.slice(0, 8);
    const slot = PROJECT_COLORS.indexOf(s.tab_color);
    s.project = slot >= 0 ? slot + 1 : null;
    if (store.prefs.debug_rule) s.rule = s.rule || (s.state === 'waiting' ? 'menu-option' : 'fallback');
    else delete s.rule;
  }
  load(scenarioName);

  const later = (ms, fn) => {
    const gen = generation;
    const t = setTimeout(() => {
      timers.delete(t);
      if (gen === generation) fn();
    }, ms);
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
  const eventData = (fields) => ({ seq: seq + 1, ...fields });
  function fullState() {
    st.seq = seq;
    st.server_time = nowS();
    return st;
  }
  function pushSessions() {
    recomputeSummary(st);
    broadcast('sessions', eventData({ sessions: st.sessions, summary: st.summary, windows: st.windows, iterm: st.iterm }));
  }
  function setScreen(uid, text) {
    const hash = crcHex(text);
    st.screens[uid] = { hash, text };
    const s = st.sessions.find((x) => x.uid === uid);
    if (s && s.screen_hash !== hash) s._lastScreenChange = nowS();
    if (s) s.screen_hash = hash;
    return { [uid]: { hash, text } };
  }
  function pushScreens(screens, removed = []) {
    broadcast('screens', eventData({ screens, removed }));
  }
  // A publish is sessions → screens → transitions (API.md §6 ordering).
  function transition(s, from, to, pending) {
    const t = nowS();
    if (s.agent && to === 'waiting' && from !== 'waiting') {
      st.stats.waits += 1;
      st.stats.active.push({ uid: s.uid, since: t });
      statsDirty = true;
    } else if (s.agent && from === 'waiting' && to !== 'waiting') {
      const a = st.stats.active.find((x) => x.uid === s.uid);
      if (a) {
        const d = Math.max(0, t - a.since);
        st.stats.waiting_seconds = Math.round(st.stats.waiting_seconds + d);
        st.stats.longest_wait_s = Math.max(st.stats.longest_wait_s, Math.round(d));
        st.stats.answered += 1;
        st.stats.active = st.stats.active.filter((x) => x.uid !== s.uid);
        statsDirty = true;
      }
    }
    s.state = to;
    s.state_since = t;
    s.attention = to === 'waiting';
    s.fresh_until = null;
    pending.push({ uid: s.uid, from, to, at: nowS(), title: s.title, agent: s.agent, prompt: s.prompt, muted: s.muted });
  }
  let statsDirty = false;
  // Order within one publish: sessions, screens, stats, transitions, stalls (API.md §6).
  function publish({ screens = null, removed = [], transitions = [], sessions = true } = {}) {
    const stalls = [];
    for (const s of st.sessions) touchRibbon(s);
    const stallChanged = updateStalls(stalls);
    if (sessions || stallChanged || transitions.length) pushSessions();
    if ((screens && Object.keys(screens).length) || removed.length) pushScreens(screens || {}, removed);
    if (statsDirty) {
      statsDirty = false;
      broadcast('stats', eventData({ stats: st.stats }));
    }
    for (const t of transitions) broadcast('transition', t);
    for (const x of stalls) broadcast('stall', x);
  }
  function action(kind, uid, detail, ok = true, delay = 250) {
    const id = `a-${++actionSeq}`;
    const send = () => broadcast('action', { id, kind, uid, ok, detail });
    if (delay) later(delay, send);
    else send();
    return id;
  }
  function usageForPrefs() {
    const u = clone(st.usage);
    for (const block of Object.values(u)) {
      for (const l of (block && block.limits) || []) l.burn = usageSeries(l, nowS(), 2).burn;
    }
    const lim = u.claude && u.claude.limits ? u.claude.limits.find((l) => l.id === 'claude.monthly') : null;
    if (lim) lim.limit_display = store.prefs.show_dollars ? '$200' : null;
    return u;
  }
  function requireSession(uid) {
    const s = st.sessions.find((x) => x.uid === uid);
    if (!s) throw notFound('session not found');
    return s;
  }
  function requireIterm() {
    if (st.iterm.status !== 'ok') throw new ApiError(503, 'iterm_unavailable', `iTerm2 is ${st.iterm.status}`);
  }

  // Scripted timeline: the busy Claude (AAAA-0001) needs an edit approval
  // every ~30 s; the busy Codex keeps spinning; the log tails.
  function tick() {
    frame += 1;
    cycle += 1;
    st.iterm.last_poll_at = nowS(); // rides along; never triggers a sessions event (API.md §10.11)
    const screens = {};
    const pending = [];
    const c1 = st.sessions.find((s) => s.uid === 'AAAAAAAA-0001-4AAA-8AAA-000000000001');
    const cx = st.sessions.find((s) => s.uid === 'CCCCCCCC-0001-4CCC-8CCC-000000000001');
    const log6 = st.sessions.find((s) => s.uid === 'BBBBBBBB-0002-4BBB-8BBB-000000000002');
    let sessionsChanged = false;
    if (c1 && c1.state === 'busy' && !c1._replied) {
      Object.assign(screens, setScreen(c1.uid, SCREENS.claudeBusy(frame, 12 + cycle)));
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
        transition(c1, 'busy', 'waiting', pending);
      }
      c1.last_change = nowS();
      sessionsChanged = true;
    } else if (c1 && c1.state === 'waiting' && cycle % 30 === 0) {
      c1.prompt = null;
      c1.is_processing = true;
      Object.assign(screens, setScreen(c1.uid, SCREENS.claudeBusy(frame, 1)));
      transition(c1, 'waiting', 'busy', pending);
      sessionsChanged = true;
    }
    for (const s of st.sessions) {
      if (s._replied && s.state === 'busy') {
        Object.assign(screens, setScreen(s.uid, SCREENS.claudeReplied(s._replied, frame)));
        s.last_change = nowS();
        sessionsChanged = true;
      }
    }
    // cx (CCCC-0001) keeps a frozen screen: it's the demo's stalled agent.
    if (cx && cx.state === 'busy' && cx._animate) {
      Object.assign(screens, setScreen(cx.uid, SCREENS.codexBusy(frame)));
      cx.last_change = nowS();
      sessionsChanged = true;
    }
    if (log6 && frame % 2 === 0) {
      Object.assign(screens, setScreen(log6.uid, SCREENS.log(30 + frame / 2)));
      log6.last_change = nowS();
      sessionsChanged = true;
    }
    publish({ screens, transitions: pending, sessions: sessionsChanged });
  }

  let interval = null;
  if (animate) interval = setInterval(tick, 1000);
  const heartbeat = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 15000);

  function headers(extra = {}) {
    return {
      'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY', ...extra,
    };
  }
  function sendJson(res, status, body) {
    res.writeHead(status, headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }));
    res.end(JSON.stringify(body));
  }
  function sendError(res, e) {
    sendJson(res, e.status, { ok: false, error: { code: e.code, message: e.message } });
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      if (req.headers['transfer-encoding']) { reject(bad('chunked bodies are not supported')); return; }
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 262144) req.destroy(); });
      req.on('end', () => {
        if (!raw) { resolve({}); return; }
        let body;
        try { body = JSON.parse(raw); } catch (_) { reject(bad('invalid JSON')); return; }
        if (!body || typeof body !== 'object' || Array.isArray(body)) { reject(bad('body must be a JSON object')); return; }
        resolve(body);
      });
    });
  }
  function authorized(req) {
    if (!requireAuth) return true;
    const auth = req.headers.authorization || '';
    if (/^bearer /i.test(auth) && auth.slice(7) === token) return true;
    const cookie = req.headers.cookie || '';
    return cookie.split(/;\s*/).some((c) => c === `ow_session=${token}`);
  }
  function serveStatic(res, pathname) {
    const segs = pathname.split('/').slice(1);
    const rel = pathname === '/' ? 'index.html' : segs.join('/');
    const badPath = segs.some((x) => x === '..' || x === '.' || x === '' || x.includes('\\') || x.includes('\0'));
    const file = path.resolve(WEB_ROOT, rel);
    const deny = () => {
      res.writeHead(404, headers({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }));
      res.end('not found\n');
    };
    if ((badPath && pathname !== '/') || !file.startsWith(WEB_ROOT + path.sep)) { deny(); return; }
    fs.readFile(file, (e, buf) => {
      if (e) { deny(); return; }
      res.writeHead(200, headers({ 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }));
      res.end(buf);
    });
  }

  // ---- routes (validation order mirrors omniwatch/engine.py) -------------
  const routes = {
    health: () => [200, { ok: true, version: st.version, demo: true, pid: process.pid, uptime_s: (Date.now() - started) / 1000 }],
    state: () => [200, fullState()],
    summary: () => {
      recomputeSummary(st);
      const waiting = st.sessions.filter((x) => x.state === 'waiting').sort((a, b) => a.state_since - b.state_since);
      return [200, {
        tabs: st.summary.tabs, agents: st.summary.agents, waiting: st.summary.waiting, busy: st.summary.busy,
        stalled: st.summary.stalled,
        waiting_sessions: waiting.map((x) => ({ uid: x.uid, title: x.title, since: x.state_since, agent: x.agent })),
        stats: st.stats,
      }];
    },
    diagnostics: () => [200, diagnosticsFor(st)],
    probe: () => {
      const id = action('probe', null, '');
      if (st.iterm.status === 'not_authorized') {
        later(1200, () => {
          const fresh = scenario('default');
          st.sessions = fresh.sessions; st.screens = fresh.screens; st.iterm = fresh.iterm;
          st.sessions.forEach(applyStore);
          publish({ screens: st.screens });
        });
      }
      return [202, { ok: true, action_id: id }];
    },
    stats: () => [200, st.stats],
    history: ({ uid }, _b, url) => {
      const hours = hoursParam(url, 8, 8);
      return [200, historyFor(requireSession(uid), hours)];
    },
    usage_history: (_p, _b, url) => {
      const hours = hoursParam(url, 24, 168);
      const now = nowS();
      const limits = {};
      for (const [provider, block] of Object.entries(st.usage || {})) {
        if (!block || !['ok', 'stale'].includes(block.status)) continue;
        for (const l of block.limits || []) {
          const series = usageSeries(l, now, hours);
          limits[l.id] = { provider, points: series.points, latest: { t: now, pct: l.pct, resets_at: l.resets_at }, burn: series.burn };
        }
      }
      return [200, { from: now - hours * 3600, to: now, hours, limits }];
    },
    reveal: ({ uid }, body) => {
      if (typeof body.target !== 'string') throw bad('target must be a string');
      if (!['finder', 'editor', 'copy_path'].includes(body.target)) throw invalid('target must be one of finder, editor, copy_path');
      const s = requireSession(uid);
      if (!s.path) throw invalid('no known path for this session');
      const shown = s.path_display || s.path;
      const editor = (store.prefs.editor || 'code').split(/\s+/)[0].split('/').pop();
      const detail = { finder: `revealed ${shown} in Finder`, editor: `opened ${shown} in ${editor}`, copy_path: `copied ${shown}` }[body.target];
      return [202, { ok: true, action_id: action('reveal', uid, detail, true, 150) }];
    },
    goto: ({ uid }) => {
      const s = requireSession(uid);
      requireIterm();
      return [202, { ok: true, action_id: action('goto', uid, `→ tab ${s.tab_label}`) }];
    },
    visit: ({ uid }) => {
      const s = requireSession(uid);
      if (s.attention) { s.attention = false; publish(); }
      return [200, { ok: true }];
    },
    plugin_focus: (_p, body) => {
      if (typeof body.uid !== 'string' || !body.uid) throw bad('uid is required');
      return routes.visit({ uid: body.uid });
    },
    label: ({ uid }, body) => {
      if (!('label' in body)) throw bad('label is required');
      const label = cleanText(body.label, 'label', 80).trim();
      const s = requireSession(uid);
      store.labels[uid] = label;
      applyStore(s);
      publish();
      return [200, { ok: true, label }];
    },
    color: ({ uid }, body) => {
      let color;
      if ('project' in body) {
        const n = body.project;
        if (!Number.isInteger(n) || typeof n === 'boolean') throw bad('project must be an integer');
        if (n < 1 || n > 5) throw invalid('project must be 1-5');
        color = PROJECT_COLORS[n - 1];
      } else if ('color' in body) {
        color = body.color;
        if (color !== null && typeof color !== 'string') throw bad('color must be a string or null');
        if (color !== null && !TAB_COLORS.includes(color)) throw invalid(`unknown color '${color}'`);
      } else throw bad('project or color is required');
      const s = requireSession(uid);
      if (st.capabilities.tab_colors === false) throw new ApiError(503, 'tab_colors_unavailable', 'tab colors unavailable — see onboarding step 2');
      let detail;
      if (color === null) detail = `tab ${s.tab_label}: color cleared`;
      else {
        const slot = PROJECT_COLORS.indexOf(color) + 1;
        const project = slot ? store.projects[slot - 1].name : '';
        detail = `tab ${s.tab_label} → ${color}${project ? ` (${project})` : ''}`;
      }
      const id = action('color', uid, detail, true, 0); // emitted immediately (API.md §10.2)
      later(300, () => {
        s.tab_color = color;
        applyStore(s);
        publish();
      });
      return [202, { ok: true, action_id: id }];
    },
    mute: ({ uid }, body) => {
      if (!isBool(body.muted)) throw bad('muted must be a boolean');
      const s = requireSession(uid);
      store.muted[uid] = body.muted;
      applyStore(s);
      publish();
      return [200, { ok: true, muted: body.muted }];
    },
    close: ({ uid }, body) => {
      if (body.confirm !== true) throw bad('confirm must be true');
      const s = requireSession(uid);
      requireIterm();
      const id = action('close', uid, '', true, 400);
      later(350, () => {
        st.sessions = st.sessions.filter((x) => !(x.window_id === s.window_id && x.tab_index === s.tab_index));
        const removed = Object.keys(st.screens).filter((k) => !st.sessions.some((x) => x.uid === k));
        removed.forEach((k) => delete st.screens[k]);
        publish({ removed });
      });
      return [202, { ok: true, action_id: id }];
    },
    reply: ({ uid }, body) => {
      const { text } = body;
      if (typeof text !== 'string') throw bad('text must be a string');
      if ('submit' in body && !isBool(body.submit)) throw bad('submit must be a boolean');
      if (typeof body.expect_hash !== 'string' || !body.expect_hash) throw bad('expect_hash is required');
      // API.md order: replies are one line — \n / \r get 422 multiline_reply (before "empty").
      if (/[\n\r]/.test(text)) throw new ApiError(422, 'multiline_reply', 'replies must be a single line');
      if (!text) throw invalid('text is empty');
      cleanText(text, 'text', 2000, true);
      const s = requireSession(uid);
      if (!store.prefs.quick_reply) throw invalid('quick reply is turned off in Settings');
      requireIterm();
      if (!s.agent || s.state !== 'waiting') throw invalid('not an agent session waiting for input');
      if (body.expect_hash.toLowerCase() !== s.screen_hash) throw new ApiError(409, 'stale_screen', 'the screen changed');
      if (!st.iterm.last_poll_at || nowS() - st.iterm.last_poll_at > 5) throw new ApiError(409, 'stale_screen', 'the snapshot is too old');
      const id = action('reply', uid, '', true, 600);
      later(550, () => {
        const opt = ((s.prompt && s.prompt.options) || []).find((o) => o.key === text);
        s._replied = opt ? `${opt.key}. ${opt.label}` : JSON.stringify(text);
        s.prompt = null;
        s.is_processing = true;
        const pending = [];
        transition(s, 'waiting', 'busy', pending);
        publish({ screens: setScreen(s.uid, SCREENS.claudeReplied(s._replied, frame)), transitions: pending });
        later(8000, () => {
          if (s.state !== 'busy' || !st.sessions.includes(s)) return;
          delete s._replied;
          const p2 = [];
          transition(s, 'busy', 'idle', p2);
          s.is_processing = false;
          s.last_change = nowS();
          s.fresh_until = nowS() + 30;
          publish({ screens: setScreen(s.uid, SCREENS.docs()), transitions: p2 });
        });
      });
      return [202, { ok: true, action_id: id }];
    },
    new_tab: () => {
      requireIterm();
      const id = action('new_tab', null, 'opening new tab…', true, 500);
      later(450, () => {
        const w1 = st.sessions.filter((x) => x.window_id === 104);
        const tab = w1.reduce((mx, x) => Math.max(mx, x.tab_index), 0) + 1;
        const uid2 = crypto.randomUUID().toUpperCase();
        st.sessions.push(session({ uid: uid2, window_id: 104, window_number: 1, tab_index: tab, tab_label: `1.${tab}`, state: 'quiet', last_change: nowS(), state_since: nowS() }));
        st.sessions.sort((a, b) => (a.window_id - b.window_id) || (a.tab_index - b.tab_index));
        publish({ screens: setScreen(uid2, 'Last login: Fri Sep 25 10:02:11 on ttys020\n~ ❯ ') });
      });
      return [202, { ok: true, action_id: id }];
    },
    launch: () => {
      const id = action('launch', null, 'launching iTerm2…');
      if (st.iterm.status === 'not_running') {
        later(1200, () => {
          const fresh = scenario('default');
          st.sessions = fresh.sessions; st.screens = fresh.screens; st.iterm = fresh.iterm; st.usage = fresh.usage;
          st.sessions.forEach(applyStore);
          publish({ screens: st.screens });
          broadcast('usage', eventData({ usage: usageForPrefs() }));
        });
      }
      return [202, { ok: true, action_id: id }];
    },
    refresh: () => {
      broadcast('toast', { level: 'info', message: 'refreshing…' });
      return [200, { ok: true }];
    },
    get_prefs: () => [200, store.prefs],
    patch_prefs: (_p, body) => {
      const updates = {};
      for (const [key, value] of Object.entries(body)) {
        const rule = PREF_RULES[key];
        if (!rule) throw invalid(`unknown pref '${key}'`);
        if (key === 'notifications') {
          const okN = rule(value) && Object.entries(value).every(([k, v]) => NOTIFICATION_RULES[k] && NOTIFICATION_RULES[k](v));
          if (!okN) throw invalid('bad value for notifications');
          updates[key] = { ...store.prefs.notifications, ...value };
        } else if (!rule(value)) {
          throw invalid(`bad value for ${key}`);
        } else {
          updates[key] = (key === 'split_ratio' || key === 'font_scale') ? Math.round(value * 100) / 100 : value;
        }
      }
      const dollars = 'show_dollars' in updates && updates.show_dollars !== store.prefs.show_dollars;
      const caps = ('quick_reply' in updates && updates.quick_reply !== store.prefs.quick_reply)
        || ('debug_rule' in updates && updates.debug_rule !== store.prefs.debug_rule);
      const rule = 'debug_rule' in updates && updates.debug_rule !== store.prefs.debug_rule;
      Object.assign(store.prefs, updates);
      st.prefs = store.prefs;
      if ('stall_minutes' in updates) later(0, () => publish({ sessions: false }));
      if (rule) {
        st.sessions.forEach(applyStore);
        pushSessions();
      }
      if (dollars) broadcast('usage', eventData({ usage: usageForPrefs() }));
      broadcast('prefs', eventData({ prefs: store.prefs, projects: store.projects }));
      if (caps) {
        st.capabilities = { ...st.capabilities, reply: !!store.prefs.quick_reply, debug_rule: !!store.prefs.debug_rule };
        broadcast('capabilities', st.capabilities);
      }
      return [200, store.prefs];
    },
    set_project: ({ slot }, body) => {
      const n = /^\d+$/.test(slot) ? Number(slot) : NaN;
      if (!(n >= 1 && n <= 5)) throw notFound('no such project slot');
      if (!('name' in body)) throw bad('name is required');
      const name = cleanText(body.name, 'name', 80).trim();
      store.projects[n - 1] = { ...store.projects[n - 1], name };
      broadcast('prefs', eventData({ prefs: store.prefs, projects: store.projects }));
      return [200, { ok: true, project: store.projects[n - 1] }];
    },
    clear_projects: (_p, body) => {
      if (body.confirm !== true) throw bad('confirm must be true');
      store.projects.forEach((p, i) => { store.projects[i] = { ...p, name: '' }; });
      broadcast('prefs', eventData({ prefs: store.prefs, projects: store.projects }));
      return [200, { ok: true }];
    },
    quota_draft: () => {
      if (!st.quota_prompt) throw notFound('no quota prompt pending');
      store.quota = null;
      st.quota_prompt = null;
      broadcast('state', fullState());
      return [200, { ok: true, opened: false }];
    },
    quota_skip: () => {
      if (!st.quota_prompt) throw notFound('no quota prompt pending');
      store.quota = null;
      st.quota_prompt = null;
      broadcast('state', fullState());
      return [200, { ok: true }];
    },
    shutdown: () => {
      setTimeout(() => close(), 50);
      return [200, { ok: true }];
    },
    demo_step: (_p, body) => {
      const seconds = 'seconds' in body ? body.seconds : 0;
      if (!isNum(seconds) || typeof seconds === 'boolean') throw bad('seconds must be a number');
      if (seconds < 0 || seconds > 86400) throw invalid('seconds must be between 0 and 86400');
      clockOffset += seconds;
      const n = Math.min(60, Math.round(seconds));
      for (let i = 0; i < n; i += 1) tick();
      if (!n) publish({ sessions: false });
      return [200, { ok: true, seq }];
    },
    demo_scenario: (_p, body) => {
      if (typeof body.name !== 'string') throw bad('name must be a string');
      if (!SCENARIO_NAMES.includes(body.name)) throw invalid(`unknown scenario '${body.name}'`);
      generation += 1;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      currentScenario = body.name;
      load(currentScenario);
      cycle = 0;
      broadcast('state', fullState());
      return [200, { ok: true, seq, scenario: currentScenario }];
    },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    // Use the raw path (WHATWG URL would resolve '..'); the real server doesn't normalize.
    const rawPath = req.url.split('?')[0];
    const pathname = /(^|\/)\.\.?(\/|$)/.test(rawPath) ? rawPath : url.pathname;
    const addr = server.address();
    const okHosts = [`127.0.0.1:${addr.port}`, `localhost:${addr.port}`];
    try {
      if (!okHosts.includes(req.headers.host || '')) throw new ApiError(403, 'forbidden', 'bad Host header');
      if (pathname === '/auth') {
        if (req.method !== 'GET') throw new ApiError(405, 'method_not_allowed', 'use GET');
        if (url.searchParams.get('token') !== token) throw new ApiError(401, 'unauthorized', 'bad token');
        res.writeHead(302, headers({ Location: '/', 'Set-Cookie': `ow_session=${token}; HttpOnly; SameSite=Strict; Path=/`, 'Content-Type': 'text/plain; charset=utf-8' }));
        res.end();
        return;
      }
      if (!pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw notFound(pathname);
        serveStatic(res, pathname);
        return;
      }
      if (!authorized(req)) throw new ApiError(401, 'unauthorized', 'missing or bad token');
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        // §4.5: Origin must equal ours, or be absent with a Bearer token (CSRF).
        const origin = req.headers.origin;
        const bearer = /^bearer /i.test(req.headers.authorization || '');
        if (origin ? !okHosts.map((h) => `http://${h}`).includes(origin) : (requireAuth && !bearer)) {
          throw new ApiError(403, 'forbidden', 'bad Origin');
        }
      }
      const { name, params } = matchRoute(req.method, pathname);
      if (name === 'events') {
        res.writeHead(200, headers({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' }));
        // hello + state carry the current seq; nothing is replayed (API.md §6).
        res.write(`id: ${seq}\nevent: hello\ndata: ${JSON.stringify({ version: st.version, server_time: nowS(), demo: true })}\n\n`);
        res.write(`id: ${seq}\nevent: state\ndata: ${JSON.stringify(fullState())}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      const body = req.method === 'GET' ? {} : await readBody(req);
      const [status, out] = routes[name](params, body, url);
      sendJson(res, status, out);
    } catch (e) {
      if (e instanceof ApiError) sendError(res, e);
      else {
        console.error('[mock] internal error', e);
        sendError(res, new ApiError(500, 'internal', 'internal error'));
      }
    }
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actualPort = server.address().port;
  const url = `http://127.0.0.1:${actualPort}`;
  log(`scenario ${currentScenario}; open ${url}/auth?token=${token}`);

  async function close() {
    generation += 1;
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
