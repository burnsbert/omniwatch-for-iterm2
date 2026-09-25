// grid-view.js — the camera wall (GridTile, P-45/46): agent sessions only
// unless `A`, chrome-stripped 9-line tails, dimmed unless selected, a bold
// amber border for waiting. `role="grid"`; the column count is read back
// from the computed CSS grid so ↑/↓ move by a full row.

import { h } from '../dom.js';
import { stateIcon } from './icons.js';
import { text, attr, cls, reconcile } from './patch.js';
import { tailLines } from '../preview.js';
import { gridColumnCount } from '../viewmodel.js';
import { MAX_LABEL_CHARS } from '../reply.js';
import { createRibbon, updateRibbon } from './activity.js';
import { setStall } from './session-row.js';

export const TILE_LINES = 9;

export function createGridView(ctx) {
  const row = h('div', { class: 'ow-grid-row', role: 'row' });
  const el = h('div', {
    class: 'ow-grid', role: 'grid', 'aria-label': 'Session grid', tabindex: '0', 'data-region': 'list',
  }, row);
  let cols = 1;
  let lastSel = null;
  el.addEventListener('focus', () => ctx.schedule());
  el.addEventListener('blur', () => ctx.schedule());

  function createTile() {
    const stateHost = h('span', { class: 'ow-tile-state' });
    const tab = h('span', { class: 'ow-tile-tab' });
    const name = h('span', { class: 'ow-tile-name' });
    const chip = h('span', { class: 'ow-chip' });
    const dot = h('span', { class: 'ow-dot' });
    const age = h('span', { class: 'ow-tile-age' });
    const stall = h('span', { class: 'ow-stall-chip' });
    const title = h('div', { class: 'ow-tile-title' }, [stateHost, tab, name, chip, dot, h('span', { class: 'ow-spacer' }), stall, age]);
    const body = h('pre', { class: 'ow-tile-body', 'aria-hidden': 'true' });
    const ribbon = createRibbon({ size: 'sm' });
    const foot = h('div', { class: 'ow-tile-foot' }, ribbon);
    const tile = h('div', { class: 'ow-tile', role: 'gridcell', tabindex: '-1', draggable: 'true' }, [title, body, foot]);
    tile.__ow = { stateHost, tab, name, chip, dot, age, body, title, stall, ribbon, foot };
    tile.addEventListener('click', () => {
      ctx.run('session.select', { uid: tile.__owUid });
      el.focus({ preventScroll: true });
    });
    tile.addEventListener('dblclick', () => ctx.run('session.goto', { uid: tile.__owUid }));
    tile.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      ctx.run('session.select', { uid: tile.__owUid });
      ctx.openContextMenu(tile.__owUid, e.clientX, e.clientY);
    });
    tile.addEventListener('dragstart', (e) => {
      if (!e.dataTransfer) return;
      e.dataTransfer.setData('application/x-omniwatch-uid', tile.__owUid);
      e.dataTransfer.effectAllowed = 'link';
    });
    return tile;
  }

  function updateTile(tile, s, f) {
    const t = tile.__ow;
    const m = f.rowModel(s);
    if (tile.__owUid !== s.uid) {
      tile.__owUid = s.uid;
      tile.id = `ow-tile-${s.uid.replace(/[^A-Za-z0-9_-]/g, '_')}`;
    }
    const key = `${m.state}:${m.muted}`;
    if (t.stateHost.__owKey !== key) {
      t.stateHost.__owKey = key;
      while (t.stateHost.firstChild) t.stateHost.removeChild(t.stateHost.firstChild);
      t.stateHost.appendChild(stateIcon(m.state, { muted: m.muted }));
    }
    text(t.tab, m.tabLabel);
    text(t.name, f.tileName(s));
    text(t.chip, m.agentLabel || (m.dashboard ? 'Ultrawatch' : ''));
    attr(t.chip, 'data-agent', m.agent || (m.dashboard ? 'dashboard' : null));
    t.chip.hidden = !(m.agentLabel || m.dashboard);
    attr(t.dot, 'data-color', m.tabColor || null);
    t.dot.hidden = !m.tabColor;
    text(t.age, m.age);
    setStall(t.stall, m.stalledText);
    updateRibbon(t.ribbon, m.ribbon);
    t.foot.hidden = !m.ribbon;
    attr(tile, 'data-stalled', m.stalled ? 'true' : null);
    const screen = f.screens[s.uid];
    const body = screen ? tailLines(screen.text, TILE_LINES, 400, { stripChrome: true }).join('\n') : '';
    text(t.body, body);
    const selected = s.uid === f.selectedUid;
    attr(tile, 'aria-selected', selected ? 'true' : 'false');
    attr(tile, 'aria-label', m.a11y);
    attr(tile, 'data-state', m.state);
    attr(tile, 'data-agent', m.agent || null);
    cls(tile, 'is-selected', selected);
    cls(tile, 'is-flash', !!f.flashes[s.uid]);
    cls(tile, 'is-muted', m.muted);

    // Inline label editor lives in the tile title in grid view.
    const editing = f.labelHost === 'tile' && f.ui.editingLabel === s.uid;
    if (editing && !t.input) {
      let cancelled = false;
      t.input = h('input', {
        class: 'ow-input ow-label-input', type: 'text', value: s.label || '', maxlength: String(MAX_LABEL_CHARS),
        placeholder: 'Label', 'aria-label': 'Session label',
      });
      t.input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          ctx.run('label.save', { uid: s.uid, label: t.input.value });
          el.focus();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancelled = true;
          ctx.ui.dispatch({ type: 'stopEditLabel' });
          el.focus();
        }
      });
      t.input.addEventListener('blur', () => {
        if (!cancelled && t.input && ctx.ui.get().editingLabel === s.uid) ctx.run('label.save', { uid: s.uid, label: t.input.value });
      });
      t.name.hidden = true;
      t.title.insertBefore(t.input, t.chip);
      t.input.focus();
      t.input.select();
    } else if (!editing && t.input) {
      const i = t.input;
      t.input = null;
      t.name.hidden = false;
      if (i.parentNode) i.parentNode.removeChild(i);
    }
  }

  function update(f) {
    reconcile(row, f.grid, (s) => s.uid, createTile, (tile, s) => updateTile(tile, s, f));
    cls(el, 'is-focused', document.activeElement === el);
    attr(el, 'aria-activedescendant', f.selectedUid ? `ow-tile-${f.selectedUid.replace(/[^A-Za-z0-9_-]/g, '_')}` : null);
    cols = gridColumnCount(getComputedStyle(row).gridTemplateColumns);
    if (f.selectedUid && f.selectedUid !== lastSel) {
      const tile = row.__owKeyed && row.__owKeyed.get(f.selectedUid);
      if (tile && tile.scrollIntoView) tile.scrollIntoView({ block: 'nearest' });
    }
    lastSel = f.selectedUid;
  }

  return { el, update, columns: () => cols };
}
