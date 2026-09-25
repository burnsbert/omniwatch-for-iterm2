// session-list.js — SessionList (§2.3): the split-view sidebar list, the
// compact list, and the list-view table (sortable column headers, P-44).
// A `role="listbox"` with `aria-activedescendant` (§2.7); window group
// headers when natural-sorted with >1 window (P-35); virtualized over 200
// rows with the selection always rendered.

import { h } from '../dom.js';
import { icon } from './icons.js';
import { text, attr, cls, cssVar, reconcile } from './patch.js';
import {
  createRow, updateRow, createTableRow, updateTableRow, createGroupHeader, updateGroupHeader, rowDomId,
} from './session-row.js';
import { windowFor, offsetsFor, scrollToReveal } from '../virtual.js';

const TABLE_COLUMNS = [
  { id: 'state', label: 'State', sort: 'attention' },
  { id: 'agent', label: 'Agent', sort: 'agents' },
  { id: 'tab', label: 'Tab', sort: 'natural' },
  { id: 'path', label: 'Path', sort: 'path' },
  { id: 'name', label: 'Name / label', sort: null },
  { id: 'activity', label: 'Last 8 h', sort: null },
  { id: 'age', label: 'Age', sort: 'activity' },
  { id: 'color', label: 'Color', sort: null },
];

export function createSessionList(ctx, { mode = 'sidebar' } = {}) {
  const table = mode === 'table';
  const sortLabel = h('span', { class: 'ow-listhead-sort' });
  const filterChip = h('button', {
    class: 'ow-filter-chip', type: 'button', title: 'Clear filter (Esc)', onClick: () => ctx.run('filter.clear'),
  });
  const title = h('div', { class: 'ow-listhead' }, [
    h('span', { class: 'ow-listhead-title' }, 'Sessions'),
    sortLabel,
    filterChip,
  ]);
  const colButtons = {};
  const colHeader = table ? h('div', { class: 'ow-thead', role: 'presentation' }, TABLE_COLUMNS.map((c) => {
    const b = c.sort
      ? h('button', {
        class: `ow-th ow-th-${c.id}`, type: 'button', title: `Sort by ${c.sort}`,
        onClick: () => ctx.run(`sort.set.${c.sort}`),
      }, [c.label, h('span', { class: 'ow-th-arrow' }, icon('chevronDown', { size: 12 }))])
      : h('span', { class: `ow-th ow-th-${c.id}` }, c.label);
    colButtons[c.id] = b;
    return b;
  })) : null;

  const inner = h('div', { class: 'ow-listbox-inner' });
  const listbox = h('div', {
    class: `ow-listbox${table ? ' ow-listbox-table' : ''}`,
    role: 'listbox',
    tabindex: '0',
    'aria-label': 'Sessions',
    'data-region': 'list',
  }, inner);
  const scroller = h('div', { class: 'ow-list-scroll' }, listbox);
  const el = h('section', { class: `ow-sessions ow-sessions-${mode}` }, [title, colHeader, scroller]);

  const handlers = {
    onSelect: (uid) => {
      ctx.run('session.select', { uid });
      listbox.focus({ preventScroll: true });
    },
    onActivate: (uid) => ctx.run('session.goto', { uid }),
    onContextMenu: (uid, x, y) => {
      ctx.run('session.select', { uid });
      ctx.openContextMenu(uid, x, y);
    },
  };

  let last = { selectedUid: null, count: 0 };
  scroller.addEventListener('scroll', () => ctx.schedule(), { passive: true });
  listbox.addEventListener('focus', () => ctx.schedule());
  listbox.addEventListener('blur', () => ctx.schedule());

  function update(f) {
    const scale = f.fontScale || 1;
    const rowH = Math.round((table ? 34 : 48) * scale);
    const headH = Math.round(28 * scale);
    cssVar(el, '--ow-row-h', `${rowH}px`);
    cssVar(el, '--ow-group-h', `${headH}px`);

    text(sortLabel, `sort: ${f.sort}`);
    const filter = f.ui.filter;
    text(filterChip, filter ? `“${filter}” · ${f.matchText}` : '');
    filterChip.hidden = !filter;
    if (table) {
      for (const c of TABLE_COLUMNS) {
        if (c.sort) cls(colButtons[c.id], 'is-active', c.sort === f.sort);
        if (c.sort) attr(colButtons[c.id], 'aria-pressed', c.sort === f.sort ? 'true' : 'false');
      }
    }

    const items = table ? f.items.filter((i) => i.type === 'row') : f.items;
    const heights = items.map((i) => (i.type === 'header' ? headH : rowH));
    const selIndex = items.findIndex((i) => i.type === 'row' && i.key === f.selectedUid);
    const viewport = scroller.clientHeight || 600;
    const win = windowFor(heights, scroller.scrollTop, viewport, { keep: selIndex });
    cssVar(inner, '--ow-pad-top', `${win.padTop}px`);
    cssVar(inner, '--ow-pad-bottom', `${win.padBottom}px`);
    const slice = items.slice(win.start, win.end);
    const focused = document.activeElement === listbox;
    reconcile(inner, slice, (i) => i.key, (i) => {
      if (i.type === 'header') return createGroupHeader();
      return table ? createTableRow(handlers) : createRow(handlers);
    }, (node, i) => {
      if (i.type === 'header') {
        updateGroupHeader(node, i);
        return;
      }
      const m = f.rowModel(i.session);
      const opts = { selected: i.key === f.selectedUid, flashing: !!f.flashes[i.key], focused };
      if (table) updateTableRow(node, m, opts);
      else updateRow(node, m, opts);
    });
    attr(listbox, 'aria-activedescendant', f.selectedUid ? rowDomId(f.selectedUid) : null);
    cls(el, 'is-focused', focused);

    // Keep the selection in view when it changes (keyboard moves, `a`, palette).
    if (f.selectedUid && (f.selectedUid !== last.selectedUid || items.length !== last.count) && selIndex >= 0) {
      const offsets = offsetsFor(heights);
      const top = scrollToReveal(offsets, selIndex, scroller.scrollTop, viewport);
      if (top !== null) scroller.scrollTop = top;
    }
    last = { selectedUid: f.selectedUid, count: items.length };
  }

  return { el, listbox, update };
}
