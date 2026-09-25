// toolbar.js — Toolbar (+SummaryPill, StatusChip, SearchField, SortMenu
// button, ViewSwitch), §2.1: waiting pill (amber when >0; click = next
// waiting, P-25/P-58), summary text, iTerm2 status chip (P-26), the `/`
// filter with its match count (P-59), sort, view segmented control
// (P-37), command palette and settings.

import { h } from '../dom.js';
import { icon } from './icons.js';
import { text, attr, cls } from './patch.js';

const VIEW_BUTTONS = [
  { id: 'split', icon: 'split', label: 'Split', key: '⌘1' },
  { id: 'list', icon: 'list', label: 'List', key: '⌘2' },
  { id: 'grid', icon: 'grid', label: 'Grid', key: '⌘3' },
];

export function createToolbar(ctx) {
  const pillCount = h('span', { class: 'ow-pill-count' });
  const pillText = h('span', { class: 'ow-pill-text' });
  const pill = h('button', {
    class: 'ow-waiting-pill', type: 'button', onClick: () => ctx.run('select.nextWaiting'),
  }, [h('span', { class: 'ow-waiting-glyph', 'aria-hidden': 'true' }), pillCount, pillText]);
  const summary = h('span', { class: 'ow-summary' });
  const chipText = h('span', {});
  const chip = h('span', { class: 'ow-status-chip', role: 'status', hidden: true }, [icon('alert', { size: 12 }), chipText]);

  const input = h('input', {
    class: 'ow-search-input', type: 'search', placeholder: 'Filter sessions…', spellcheck: 'false',
    autocomplete: 'off', 'aria-label': 'Filter sessions', 'data-region': 'toolbar',
  });
  const count = h('span', { class: 'ow-search-count', 'aria-live': 'polite' });
  const kbd = h('kbd', { class: 'ow-search-kbd', 'aria-hidden': 'true' }, '/');
  const clearBtn = h('button', {
    class: 'ow-search-clear', type: 'button', 'aria-label': 'Clear filter', title: 'Clear filter (Esc)',
    onClick: () => {
      ctx.run('filter.clear');
      input.focus();
    },
  }, icon('close', { size: 12 }));
  const search = h('label', { class: 'ow-search' }, [icon('search', { size: 14, cls: 'ow-search-icon' }), input, count, kbd, clearBtn]);
  input.addEventListener('input', () => ctx.ui.dispatch({ type: 'setFilter', filter: input.value }));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (input.value) ctx.ui.dispatch({ type: 'setFilter', filter: '' });
      input.blur();
      ctx.focusList();
    } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
      // ⏎ keeps the filter and returns to the list (P-59).
      e.preventDefault();
      e.stopPropagation();
      input.blur();
      ctx.focusList();
    }
  });

  const sortText = h('span', { class: 'ow-sort-text' });
  const sortBtn = h('button', {
    class: 'ow-tool-btn', type: 'button', 'aria-haspopup': 'menu', title: 'Sort (s cycles)',
    onClick: (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      ctx.openSortMenu(r.left, r.bottom + 4);
    },
  }, [icon('sort', { size: 14 }), sortText, icon('chevronDown', { size: 12, cls: 'ow-caret' })]);

  const viewBtns = {};
  const viewSwitch = h('div', { class: 'ow-segmented', role: 'radiogroup', 'aria-label': 'View' }, VIEW_BUTTONS.map((v) => {
    const b = h('button', {
      class: 'ow-seg', type: 'button', role: 'radio', title: `${v.label} view (${v.key})`, 'aria-label': `${v.label} view`,
      onClick: () => ctx.run(`view.${v.id}`),
    }, icon(v.icon, { size: 15 }));
    viewBtns[v.id] = b;
    return b;
  }));
  const usageBtn = h('button', {
    class: 'ow-icon-btn', type: 'button', title: 'Usage (u)', 'aria-label': 'Usage',
    onClick: () => ctx.run('usage.toggle'),
  }, icon('gauge', { size: 16 }));
  const paletteBtn = h('button', {
    class: 'ow-icon-btn', type: 'button', title: 'Command palette (⌘K)', 'aria-label': 'Command palette',
    onClick: () => ctx.run('commandPalette.open'),
  }, icon('command', { size: 16 }));
  const settingsBtn = h('button', {
    class: 'ow-icon-btn', type: 'button', title: 'Settings (⌘,)', 'aria-label': 'Settings',
    onClick: () => ctx.run('settings.open'),
  }, icon('gear', { size: 16 }));
  const demoBadge = h('span', { class: 'ow-demo-badge', title: 'Demo mode: fake iTerm2 sessions and usage', hidden: true }, 'Demo');

  const el = h('div', { class: 'ow-toolbar-inner' }, [
    h('div', { class: 'ow-tb-left' }, [pill, summary, chip, demoBadge]),
    h('div', { class: 'ow-tb-center' }, search),
    h('div', { class: 'ow-tb-right' }, [sortBtn, viewSwitch, usageBtn, paletteBtn, settingsBtn]),
  ]);

  function update(f) {
    const w = f.summary.waiting;
    text(pillCount, String(w));
    text(pillText, w === 1 ? 'waiting' : 'waiting');
    cls(pill, 'is-hot', w > 0);
    attr(pill, 'aria-label', w > 0 ? `${w} waiting — select the next waiting session (a)` : 'Nobody waiting');
    attr(pill, 'title', w > 0 ? 'Select the next waiting session (a)' : 'Nobody is waiting for you');
    text(summary, f.summary.text);
    if (f.chip) {
      chip.hidden = false;
      text(chipText, f.chip.text);
      attr(chip, 'data-kind', f.chip.kind);
      attr(chip, 'title', f.chip.title);
    } else chip.hidden = true;
    demoBadge.hidden = !f.server.demo;
    if (document.activeElement !== input && input.value !== f.ui.filter) input.value = f.ui.filter;
    text(count, f.matchText);
    count.hidden = !f.ui.filter;
    kbd.hidden = !!f.ui.filter;
    clearBtn.hidden = !f.ui.filter;
    cls(search, 'is-active', !!f.ui.filter);
    text(sortText, f.sort);
    for (const v of VIEW_BUTTONS) {
      const on = (f.prefs.view || 'split') === v.id;
      attr(viewBtns[v.id], 'aria-checked', on ? 'true' : 'false');
      cls(viewBtns[v.id], 'is-on', on);
    }
    cls(usageBtn, 'is-on', f.ui.overlay === 'usage');
  }

  return { el, update, focusSearch: () => { input.focus(); input.select(); }, input };
}
