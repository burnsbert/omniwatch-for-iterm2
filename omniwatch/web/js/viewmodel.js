// viewmodel.js — pure derivations from (server State, UI state, env) to
// what the components render. No DOM, no I/O, no clock reads: every
// "now" is passed in (epoch seconds, server-clock aligned). Components in
// js/components/ only read the objects built here, so the behavior that
// matters for parity (row order, grouping, selection rules, grid
// filtering, status chip, accessible names) is unit-tested in Node.

import { fuzzyMatch } from './fuzzy.js';
import { sortSessions } from './sort.js';
import { ageStr, rowAge, isFresh } from './format.js';

export const VIEWS = Object.freeze(['split', 'list', 'grid']);
export const SPLIT_MIN_WIDTH = 900; // P-38: below this split falls back to list
export const COMPACT_MAX_WIDTH = 420; // §3 P0: sidebar-only layout
export const SPLIT_MIN = 0.2;
export const SPLIT_MAX = 0.8;
export const SPLIT_STEP = 0.05;
export const FONT_SCALE_MIN = 0.8;
export const FONT_SCALE_MAX = 1.6;
export const FONT_SCALE_STEP = 0.1;

export const PROJECT_COLORS = Object.freeze(['blue', 'purple', 'green', 'red', 'yellow']);

/** Human text per classifier state (P-27, P-52 legend). */
export const STATE_META = Object.freeze({
  waiting: { label: 'Waiting', legend: 'waiting for you' },
  busy: { label: 'Busy', legend: 'working' },
  idle: { label: 'Idle', legend: 'idle agent' },
  active: { label: 'Output', legend: 'new output' },
  quiet: { label: 'Quiet', legend: 'quiet shell' },
  unknown: { label: 'Unknown', legend: 'not classified yet' },
});

export function stateKey(state) {
  return Object.prototype.hasOwnProperty.call(STATE_META, state) && state !== 'unknown'
    ? state : 'unknown';
}

export function stateLabel(state) {
  return STATE_META[stateKey(state)].label;
}

/** Short chip text per agent kind (P-28); plain sessions get no chip. */
export function agentLabel(agent) {
  if (agent === 'claude') return 'Claude';
  if (agent === 'codex') return 'Codex';
  return '';
}

/** Long agent name for accessible names (§2.7). */
export function agentLongName(agent) {
  if (agent === 'claude') return 'Claude Code';
  if (agent === 'codex') return 'Codex';
  return '';
}

/** Text the `/` filter matches against (P-59: "{path} {name} {label}"). */
export function filterHaystack(s) {
  return `${s.path_display || ''} ${s.name || ''} ${s.label || ''}`;
}

/**
 * Filtered + sorted session rows (P-59, P-60).
 * @param {object[]} sessions
 * @param {{filter?: string, sort?: string}} opts
 */
export function visibleSessions(sessions, { filter = '', sort = 'natural' } = {}) {
  const list = (sessions || []).filter((s) => fuzzyMatch(filter, filterHaystack(s)));
  return sortSessions(list, sort);
}

/**
 * Grid sessions (P-45): agent sessions only (Ultrawatch dashboards left out,
 * P-50), falling back to every row when none are agents; `gridAll` shows
 * everything.
 */
export function gridSessions(rows, gridAll) {
  if (gridAll) return rows;
  const agents = rows.filter((s) => s.agent && !s.is_dashboard);
  return agents.length ? agents : rows;
}

/**
 * Items for the session list: rows, plus window group headers when the sort
 * is natural and there is more than one window (P-35).
 * @returns {{type:'header'|'row', key:string, session?:object, number?:number, count?:number}[]}
 */
export function listItems(rows, sort, windows) {
  const windowCount = new Set(rows.map((s) => s.window_id)).size;
  const grouped = sort === 'natural' && ((windows && windows.length > 1) || windowCount > 1)
    && windowCount > 0;
  if (!grouped) return rows.map((s) => ({ type: 'row', key: s.uid, session: s }));
  const counts = new Map();
  for (const s of rows) counts.set(s.window_id, (counts.get(s.window_id) || 0) + 1);
  const out = [];
  let lastWindow = null;
  for (const s of rows) {
    if (s.window_id !== lastWindow) {
      lastWindow = s.window_id;
      out.push({
        type: 'header', key: `w-${s.window_id}`, number: s.window_number, count: counts.get(s.window_id),
      });
    }
    out.push({ type: 'row', key: s.uid, session: s });
  }
  return out;
}

/**
 * The layout actually rendered for a window width: ≤420 px is the compact
 * sidebar-only layout, split below 900 px falls back to list (P-38).
 */
export function effectiveView(view, width) {
  if (typeof width === 'number' && width <= COMPACT_MAX_WIDTH) return 'compact';
  const v = VIEWS.includes(view) ? view : 'split';
  if (v === 'split' && typeof width === 'number' && width < SPLIT_MIN_WIDTH) return 'list';
  return v;
}

/** `v` cycles split → list → grid (P-37). */
export function nextView(view) {
  const i = VIEWS.indexOf(view);
  return VIEWS[(i + 1) % VIEWS.length];
}

/** Selection follows the uid; snaps to the first row when it's gone (P-55). */
export function resolveSelection(rows, selectedUid) {
  if (!rows.length) return null;
  if (selectedUid && rows.some((s) => s.uid === selectedUid)) return selectedUid;
  return rows[0].uid;
}

export function indexOfUid(rows, uid) {
  return rows.findIndex((s) => s.uid === uid);
}

/** Move the selection by `delta` rows, clamped (P-55, P-46 uses ±columns). */
export function moveSelection(rows, selectedUid, delta) {
  if (!rows.length) return null;
  let i = indexOfUid(rows, selectedUid);
  if (i < 0) i = 0;
  const next = Math.max(0, Math.min(rows.length - 1, i + delta));
  return rows[next].uid;
}

/**
 * `a` (P-58): next waiting session, longest-waiting first, cycling from the
 * current selection. Returns null when nobody is waiting.
 */
export function nextWaitingUid(sessions, selectedUid) {
  const waiting = (sessions || [])
    .filter((s) => s.state === 'waiting')
    .sort((a, b) => (a.state_since || 0) - (b.state_since || 0))
    .map((s) => s.uid);
  if (!waiting.length) return null;
  const i = waiting.indexOf(selectedUid);
  return i < 0 ? waiting[0] : waiting[(i + 1) % waiting.length];
}

/** Clamp/round a split ratio to the persisted range (P-38). */
export function clampSplit(ratio) {
  const r = Number.isFinite(ratio) ? ratio : 0.42;
  return Math.round(Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, r)) * 100) / 100;
}

export function stepSplit(ratio, direction) {
  return clampSplit((Number.isFinite(ratio) ? ratio : 0.42) + direction * SPLIT_STEP);
}

export function clampFontScale(scale) {
  const s = Number.isFinite(scale) ? scale : 1;
  return Math.round(Math.max(FONT_SCALE_MIN, Math.min(FONT_SCALE_MAX, s)) * 10) / 10;
}

/** Split a display path into a truncatable head and a kept tail (middle truncation). */
export function splitPath(pathDisplay) {
  const p = pathDisplay || '';
  if (!p) return { head: '', tail: '' };
  const trimmed = p.length > 1 ? p.replace(/\/+$/, '') : p;
  const i = trimmed.lastIndexOf('/');
  if (i < 0 || i === trimmed.length - 1) return { head: '', tail: trimmed };
  return { head: trimmed.slice(0, i + 1), tail: trimmed.slice(i + 1) };
}

/** Grid/zoom tile name: label, else the path basename, else the session name (P-45). */
export function tileName(s) {
  if (s.label) return s.label;
  const p = s.path_display || '';
  if (p) {
    const { tail } = splitPath(p);
    return tail || p;
  }
  return s.name || s.uid.slice(0, 8);
}

/** Title used in toasts (P-24): the backend's `title`, else a local fallback. */
export function sessionTitle(s) {
  if (!s) return '';
  return s.title || s.label || tileName(s);
}

/** "Waiting 3 minutes, Claude Code, tab 1.1, ~/src/api, label deploy-fix" (§2.7). */
export function accessibleName(s, now) {
  const parts = [];
  const label = stateLabel(s.state);
  if (s.state === 'waiting' && s.state_since) {
    parts.push(`${label} ${spokenDuration(now - s.state_since)}`);
  } else if ((s.state === 'idle' || s.state === 'quiet') && s.last_change && now - s.last_change >= 60) {
    parts.push(`${label} ${spokenDuration(now - s.last_change)}`);
  } else {
    parts.push(label);
  }
  if (s.stalled) parts.push(s.stalled_since ? `possibly stalled for ${spokenDuration(now - s.stalled_since)}` : 'possibly stalled');
  if (s.muted) parts.push('muted');
  const agent = agentLongName(s.agent);
  if (agent) parts.push(agent);
  if (s.tab_label) parts.push(`tab ${s.tab_label}`);
  if (s.path_display) parts.push(s.path_display);
  if (s.label) parts.push(`label ${s.label}`);
  else if (s.name) parts.push(s.name);
  if (s.tab_color) parts.push(`tab color ${s.tab_color}`);
  return parts.join(', ');
}

/** "3 minutes" / "1 hour" style for screen readers. */
export function spokenDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const unit = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (s < 60) return unit(s, 'second');
  if (s < 3600) return unit(Math.floor(s / 60), 'minute');
  if (s < 86400) return unit(Math.floor(s / 3600), 'hour');
  return unit(Math.floor(s / 86400), 'day');
}

/**
 * "Stalled? 14m" (API.md §5 `stalled`/`stalled_since`): busy with an
 * unchanged screen for ≥ prefs.stall_minutes. Empty when not stalled.
 */
export function stalledText(s, now) {
  if (!s || !s.stalled) return '';
  return s.stalled_since ? `Stalled? ${ageStr(now - s.stalled_since)}` : 'Stalled?';
}

/** Row tint (P-29): amber for waiting, green for fresh, amber wins. */
export function rowTone(s, now) {
  if (s.state === 'waiting') return 'waiting';
  if (s.state !== 'busy' && isFresh(s, now)) return 'fresh';
  return '';
}

/** Per-row model shared by the sidebar, list table, grid and palette. */
export function rowModel(s, now, projects) {
  const project = projectForSession(s, projects);
  return {
    uid: s.uid,
    state: stateKey(s.state),
    stateLabel: stateLabel(s.state),
    agent: s.agent || '',
    agentLabel: agentLabel(s.agent),
    tabLabel: s.tab_label || '',
    path: splitPath(s.path_display),
    pathDisplay: s.path_display || '',
    name: s.name || '',
    label: s.label || '',
    displayName: s.display_name || s.label || s.name || '',
    age: rowAge(s, now),
    tone: rowTone(s, now),
    tabColor: s.tab_color || '',
    projectName: project ? project.name : '',
    projectSlot: project ? project.slot : null,
    muted: !!s.muted,
    stalled: !!s.stalled,
    stalledText: stalledText(s, now),
    ribbon: s.ribbon || null,
    attention: !!s.attention,
    dashboard: !!s.is_dashboard,
    a11y: accessibleName(s, now),
  };
}

/** Project whose color matches the session's tab color (§4.4.1 `project`). */
export function projectForSession(s, projects) {
  const list = projects || [];
  if (s.project) {
    const p = list.find((x) => x.slot === s.project);
    if (p) return p;
  }
  if (!s.tab_color) return null;
  return list.find((x) => x.color === s.tab_color) || null;
}

/** Tooltip for the tab-color dot (P-34). */
export function colorDotTitle(s, projects) {
  if (!s.tab_color) return '';
  const p = projectForSession(s, projects);
  return p && p.name ? `Tab color ${s.tab_color} · project ${p.name}` : `Tab color ${s.tab_color}`;
}

/**
 * iTerm2 status chip (P-26, §2.9). Returns null when everything is fine.
 * @returns {{kind:string, text:string, title:string}|null}
 */
export function statusChip(iterm, now) {
  if (!iterm) return null;
  const status = iterm.status || 'connecting';
  if (status === 'not_running') return { kind: 'danger', text: 'Not running', title: 'iTerm2 is not running' };
  if (status === 'not_authorized') {
    return { kind: 'danger', text: 'No permission', title: 'Omniwatch is not allowed to control iTerm2' };
  }
  if (status === 'error') return { kind: 'danger', text: 'Error', title: iterm.error || 'iTerm2 query failed' };
  if (status === 'connecting') return { kind: 'muted', text: 'Connecting…', title: 'Connecting to iTerm2…' };
  // Only the backend knows whether polling is healthy: `sessions` events
  // (which carry `iterm`) are sent only when sessions change, so a local
  // age check on `last_poll_at` would flag idle-but-healthy setups as stale.
  if (iterm.stale) {
    const age = iterm.last_poll_at ? now - iterm.last_poll_at : 0;
    const text = age >= 1 ? `Stale · ${ageStr(age)}` : 'Stale';
    return { kind: 'warn', text, title: iterm.error || 'The last iTerm2 snapshot is out of date' };
  }
  // A quiet "still trying" hint (P-26, T028): one or more recent polls
  // failed, but not (yet) enough to go to the full `error`/`stale` state
  // — never alarming, just informational.
  if (iterm.slow) {
    return { kind: 'muted', text: 'Slow…', title: 'iTerm2 is slow to respond, retrying…' };
  }
  return null;
}

/**
 * The stale-data banner shown while `iterm.status === 'error'` and there
 * are still sessions to show (§2.9, T028): friendlier than the raw
 * osascript error — attempts + age, with the raw error meant for a
 * tooltip, not the headline (see components/feedback.js).
 * @returns {{text:string, title:string}|null}
 */
export function staleBannerText(iterm, now) {
  if (!iterm) return null;
  const attempts = iterm.consecutive_failures || 1;
  const age = iterm.last_poll_at != null ? Math.max(0, now - iterm.last_poll_at) : null;
  const ageText = age != null ? `${ageStr(age)} ago` : 'a while ago';
  return {
    text: `iTerm2 isn’t responding (${attempts} attempt${attempts === 1 ? '' : 's'}). `
      + `Showing data from ${ageText}. It may be busy or showing a dialog.`,
    title: iterm.error || '',
  };
}

/**
 * Body empty state (§2.9) or null when sessions should render.
 * @returns {{kind:string, title:string, body:string, actions:{id:string,label:string,primary?:boolean}[]}|null}
 */
export function emptyState({ iterm, sessions, rows, filter, view, connection }) {
  const status = (iterm && iterm.status) || 'connecting';
  const hasSessions = (sessions || []).length > 0;
  if (status === 'not_running' && !hasSessions) {
    return {
      kind: 'not_running',
      title: 'iTerm2 isn’t running',
      body: 'Omniwatch watches your iTerm2 sessions. Launch iTerm2 and your agents will show up here.',
      actions: [{ id: 'iterm.launch', label: 'Launch iTerm2', primary: true }],
    };
  }
  if (status === 'not_authorized') {
    return {
      kind: 'not_authorized',
      title: 'Omniwatch needs permission to read iTerm2',
      body: 'macOS blocked Omniwatch from sending Apple Events to iTerm2. Allow it under System Settings › Privacy & Security › Automation, then try again.',
      actions: [
        { id: 'automation.open', label: 'Open Automation settings', primary: true },
        { id: 'automation.probe', label: 'Try again' },
      ],
    };
  }
  if (status === 'error' && !hasSessions) {
    return {
      kind: 'error',
      title: 'iTerm2 query failed',
      body: (iterm && iterm.error) || 'The last query to iTerm2 failed.',
      actions: [{ id: 'refresh', label: 'Retry', primary: true }],
    };
  }
  if ((status === 'connecting' || connection === 'connecting') && !hasSessions) {
    return { kind: 'connecting', title: 'Connecting to iTerm2…', body: '', actions: [] };
  }
  if (!hasSessions) {
    return {
      kind: 'no_sessions',
      title: 'No iTerm2 sessions',
      body: 'Open a tab in iTerm2 and start Claude Code or Codex.',
      actions: [{ id: 'tab.new', label: 'New tab', primary: true }],
    };
  }
  if (!rows.length && filter) {
    return {
      kind: 'no_match',
      title: `No sessions match “${filter}”`,
      body: '',
      actions: [{ id: 'filter.clear', label: 'Clear filter', hint: 'Esc' }],
    };
  }
  if (!rows.length && view === 'grid') {
    return {
      kind: 'grid_empty',
      title: 'No agent sessions — press A to show all',
      body: '',
      actions: [{ id: 'grid.toggleAll', label: 'Show all sessions', hint: 'A' }],
    };
  }
  return null;
}

/** Toolbar summary (P-25). */
export function summaryModel(summary) {
  const s = summary || {};
  return {
    waiting: s.waiting || 0,
    stalled: s.stalled || 0,
    tabs: s.tabs || 0,
    agents: s.agents || 0,
    busy: s.busy || 0,
    text: `${plural(s.tabs || 0, 'tab')} · ${plural(s.agents || 0, 'agent')}`,
  };
}

export function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Document / window title (§2.1: the title carries the waiting count). */
export function windowTitle(waiting) {
  return waiting > 0 ? `Omniwatch — ${waiting} waiting` : 'Omniwatch';
}

/** `N of M match` (P-59). */
export function matchCountText(filter, shown, total) {
  if (!filter) return '';
  return `${shown} of ${total}`;
}

/**
 * Preview footer text (P-41): 'live · updated just now' (<3 s since the
 * last snapshot) else 'updated Xs ago'; plus the debug rule (P-43).
 */
export function previewFooter(iterm, session, now, showRule) {
  const last = iterm && iterm.last_poll_at;
  let fresh = '';
  if (last) {
    const age = Math.max(0, now - last);
    fresh = age < 3 ? 'live · updated just now' : `updated ${ageStr(age)} ago`;
  }
  const rule = showRule && session && session.rule ? `rule: ${session.rule}` : '';
  return { fresh, rule, live: !!last && now - last < 3 };
}

/** Preview header state text (P-40): 'Waiting 3m' / 'Idle 22m' / 'Busy'. */
export function stateWithAge(s, now) {
  const label = stateLabel(s.state);
  if (s.state === 'waiting' && s.state_since) return `${label} ${ageStr(now - s.state_since)}`;
  if (s.state_since && s.state !== 'waiting') {
    if ((s.state === 'idle' || s.state === 'quiet') && s.last_change && now - s.last_change >= 60) {
      return `${label} ${ageStr(now - s.last_change)}`;
    }
  }
  return label;
}

/** Visible uids to report to native for notification suppression (SHELL_CONTRACT §6). */
export function visibleUids({ view, selectedUid, overlay, gridUids, windowFocused }) {
  if (windowFocused === false) return [];
  if (overlay === 'usage') return [];
  if (overlay === 'zoom') return selectedUid ? [selectedUid] : [];
  if (view === 'grid') return [...(gridUids || [])];
  return selectedUid ? [selectedUid] : [];
}

/** The theme value to apply to <html data-theme> and to post to native. */
export function nativeThemeValue(theme) {
  if (theme === 'dark' || theme === 'light') return theme;
  if (theme === 'high-contrast') return 'dark';
  return 'system';
}

/** Count of columns from a computed `grid-template-columns` value (P-46). */
export function gridColumnCount(templateColumns) {
  if (!templateColumns || templateColumns === 'none') return 1;
  const n = templateColumns.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, n);
}

/**
 * The rows every part of the UI agrees on for one frame: the filtered and
 * sorted list, the grid subset, the effective layout, and the resolved
 * selection (which is computed against what's actually on screen, so grid
 * selection follows grid filtering).
 */
export function derive(server, ui, width) {
  const prefs = server.prefs || {};
  const sort = prefs.sort || 'natural';
  const view = effectiveView(prefs.view || 'split', width);
  const rows = visibleSessions(server.sessions || [], { filter: ui.filter, sort });
  const grid = gridSessions(rows, !!prefs.grid_all);
  const active = view === 'grid' ? grid : rows;
  const selectedUid = resolveSelection(active, ui.selectedUid);
  const selected = active.find((s) => s.uid === selectedUid) || null;
  return { view, sort, rows, grid, active, selectedUid, selected };
}
