// session-row.js — one session row (SessionRow, §2.3) for the split
// sidebar / compact list, and the table-row variant for list view.
// Built once per uid and patched in place; the row's accessible name is
// the full "Waiting 3 minutes, Claude Code, tab 1.1, …" string (§2.7).

import { h } from '../dom.js';
import { icon, stateIcon } from './icons.js';
import { text, attr, cls } from './patch.js';
import { createRibbon, updateRibbon } from './activity.js';

export function rowDomId(uid) {
  return `ow-row-${String(uid).replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

function setStateIcon(host, state, muted) {
  const key = `${state}:${muted}`;
  if (host.__owState === key) return;
  host.__owState = key;
  while (host.firstChild) host.removeChild(host.firstChild);
  host.appendChild(stateIcon(state, { muted }));
}

/** Sidebar/compact row: two lines (path + age, then agent · tab · name · color). */
export function createRow(handlers) {
  const stateEl = h('span', { class: 'ow-row-state' });
  const head = h('span', { class: 'ow-path-head' });
  const tail = h('span', { class: 'ow-path-tail' });
  const pathEl = h('span', { class: 'ow-row-path' }, [head, tail]);
  const age = h('span', { class: 'ow-row-age' });
  const chip = h('span', { class: 'ow-chip' });
  const tab = h('span', { class: 'ow-row-tab' });
  const pill = h('span', { class: 'ow-pill' });
  const name = h('span', { class: 'ow-row-name' });
  const dot = h('span', { class: 'ow-dot', 'aria-hidden': 'true' });
  const muteEl = h('span', { class: 'ow-row-mute', title: 'Muted' }, icon('bellOff', { size: 12 }));
  const stall = h('span', { class: 'ow-stall-chip' });
  const ribbon = createRibbon({ size: 'xs' });
  const el = h('div', {
    class: 'ow-row',
    role: 'option',
    draggable: 'true',
  }, [
    stateEl,
    h('div', { class: 'ow-row-main' }, [
      h('div', { class: 'ow-row-line1' }, [pathEl, stall, age]),
      h('div', { class: 'ow-row-line2' }, [chip, tab, pill, name, ribbon, dot, muteEl]),
    ]),
  ]);
  el.__ow = { stateEl, head, tail, age, chip, tab, pill, name, dot, muteEl, stall, ribbon };
  wireRow(el, handlers);
  return el;
}

export function updateRow(el, m, { selected, flashing, focused }) {
  const r = el.__ow;
  if (el.__owUid !== m.uid) {
    el.__owUid = m.uid;
    el.id = rowDomId(m.uid);
    el.dataset.uid = m.uid;
  }
  setStateIcon(r.stateEl, m.state, m.muted);
  text(r.head, m.path.head);
  text(r.tail, m.path.tail || m.displayName || m.name || '—');
  text(r.age, m.age);
  cls(r.age, 'is-waiting', m.state === 'waiting');
  text(r.chip, m.agentLabel || (m.dashboard ? 'Dashboard' : ''));
  attr(r.chip, 'data-agent', m.agent || (m.dashboard ? 'dashboard' : null));
  r.chip.hidden = !(m.agentLabel || m.dashboard);
  text(r.tab, m.tabLabel);
  text(r.pill, m.label);
  r.pill.hidden = !m.label;
  text(r.name, m.label ? (m.name !== m.label ? m.name : '') : m.name);
  attr(r.dot, 'data-color', m.tabColor || null);
  r.dot.hidden = !m.tabColor;
  attr(r.dot, 'title', m.tabColor ? (m.projectName ? `${m.tabColor} · ${m.projectName}` : m.tabColor) : null);
  r.muteEl.hidden = !m.muted;
  setStall(r.stall, m.stalledText);
  // Row ribbons only for agents: a shell's all-quiet strip is noise (the preview still has one).
  updateRibbon(r.ribbon, m.agent ? m.ribbon : null);
  attr(el, 'aria-label', m.a11y);
  attr(el, 'aria-selected', selected ? 'true' : 'false');
  attr(el, 'data-state', m.state);
  attr(el, 'data-tone', m.tone || null);
  attr(el, 'title', m.pathDisplay || null);
  cls(el, 'is-selected', selected);
  cls(el, 'is-focused', selected && focused);
  cls(el, 'is-flash', flashing);
  cls(el, 'is-muted', m.muted);
  cls(el, 'is-attention', m.attention);
}

/** "Stalled? 14m" chip (API.md §5 `stalled`); hidden when not stalled. */
export function setStall(el, textValue) {
  el.hidden = !textValue;
  if (el.__owText === textValue) return;
  el.__owText = textValue;
  while (el.firstChild) el.removeChild(el.firstChild);
  if (!textValue) return;
  el.appendChild(icon('pause', { size: 11 }));
  el.appendChild(document.createTextNode(textValue));
  el.setAttribute('title', 'Busy, but the screen hasn’t changed for a while — it may be stuck');
}

/** List-view table row: state · agent · tab · path · name/label · activity · age · color. */
export function createTableRow(handlers) {
  const stateEl = h('span', { class: 'ow-td ow-td-state' });
  const stateText = h('span', { class: 'ow-td-state-text' });
  const chip = h('span', { class: 'ow-chip' });
  const tab = h('span', { class: 'ow-td ow-td-tab' });
  const head = h('span', { class: 'ow-path-head' });
  const tail = h('span', { class: 'ow-path-tail' });
  const pill = h('span', { class: 'ow-pill' });
  const name = h('span', { class: 'ow-row-name' });
  const age = h('span', { class: 'ow-td ow-td-age' });
  const dot = h('span', { class: 'ow-dot', 'aria-hidden': 'true' });
  const dotName = h('span', { class: 'ow-td-color-name' });
  const stall = h('span', { class: 'ow-stall-chip' });
  const ribbon = createRibbon({ size: 'sm' });
  const el = h('div', { class: 'ow-row ow-trow', role: 'option', draggable: 'true' }, [
    h('span', { class: 'ow-td ow-td-statecell' }, [stateEl, stateText]),
    h('span', { class: 'ow-td ow-td-agent' }, chip),
    tab,
    h('span', { class: 'ow-td ow-td-path' }, h('span', { class: 'ow-row-path' }, [head, tail])),
    h('span', { class: 'ow-td ow-td-name' }, [pill, name]),
    h('span', { class: 'ow-td ow-td-activity' }, ribbon),
    h('span', { class: 'ow-td ow-td-agecell' }, [stall, age]),
    h('span', { class: 'ow-td ow-td-color' }, [dot, dotName]),
  ]);
  el.__ow = { stateEl, stateText, chip, tab, head, tail, pill, name, age, dot, dotName, stall, ribbon };
  wireRow(el, handlers);
  return el;
}

export function updateTableRow(el, m, { selected, flashing, focused }) {
  const r = el.__ow;
  if (el.__owUid !== m.uid) {
    el.__owUid = m.uid;
    el.id = rowDomId(m.uid);
    el.dataset.uid = m.uid;
  }
  setStateIcon(r.stateEl, m.state, m.muted);
  text(r.stateText, m.muted ? `${m.stateLabel} · muted` : m.stateLabel);
  text(r.chip, m.agentLabel || (m.dashboard ? 'Dashboard' : ''));
  attr(r.chip, 'data-agent', m.agent || (m.dashboard ? 'dashboard' : null));
  r.chip.hidden = !(m.agentLabel || m.dashboard);
  text(r.tab, m.tabLabel);
  text(r.head, m.path.head);
  text(r.tail, m.path.tail || '~');
  text(r.pill, m.label);
  r.pill.hidden = !m.label;
  text(r.name, m.label ? '' : m.name);
  text(r.age, m.age);
  cls(r.age, 'is-waiting', m.state === 'waiting');
  attr(r.dot, 'data-color', m.tabColor || null);
  r.dot.hidden = !m.tabColor;
  text(r.dotName, m.projectName || '');
  setStall(r.stall, m.stalledText);
  updateRibbon(r.ribbon, m.ribbon);
  attr(el, 'aria-label', m.a11y);
  attr(el, 'aria-selected', selected ? 'true' : 'false');
  attr(el, 'data-state', m.state);
  attr(el, 'data-tone', m.tone || null);
  cls(el, 'is-selected', selected);
  cls(el, 'is-focused', selected && focused);
  cls(el, 'is-flash', flashing);
  cls(el, 'is-muted', m.muted);
}

function wireRow(el, handlers) {
  el.addEventListener('click', (e) => handlers.onSelect(el.__owUid, e));
  el.addEventListener('dblclick', () => handlers.onActivate(el.__owUid));
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    handlers.onContextMenu(el.__owUid, e.clientX, e.clientY);
  });
  el.addEventListener('dragstart', (e) => {
    if (!e.dataTransfer) return;
    e.dataTransfer.setData('application/x-omniwatch-uid', el.__owUid);
    e.dataTransfer.setData('text/plain', el.__owUid);
    e.dataTransfer.effectAllowed = 'link';
    document.body.classList.add('is-dragging-session');
  });
  el.addEventListener('dragend', () => document.body.classList.remove('is-dragging-session'));
}

/** Window group header (P-35). */
export function createGroupHeader() {
  const label = h('span', { class: 'ow-group-label' });
  const count = h('span', { class: 'ow-group-count' });
  const el = h('div', { class: 'ow-group', role: 'presentation' }, [label, count]);
  el.__ow = { label, count };
  return el;
}

export function updateGroupHeader(el, item) {
  text(el.__ow.label, `Window ${item.number}`);
  text(el.__ow.count, String(item.count));
}
