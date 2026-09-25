// command-palette.js — CommandPalette (⌘K, §2.5): fuzzy search over every
// command and every session, matched characters highlighted, ↑/↓ to
// move, ⏎ runs, ⌥⏎ selects a session without going to it.

import { h } from '../dom.js';
import { icon, stateIcon } from './icons.js';
import { attr, cls } from './patch.js';
import { paletteItems, paletteResults, highlightSegments, moveCursor } from '../palette.js';

export function createCommandPalette(ctx) {
  const input = h('input', {
    class: 'ow-palette-input', type: 'text', placeholder: 'Type a command or a session…', spellcheck: 'false',
    autocomplete: 'off', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'ow-palette-list',
    'aria-autocomplete': 'list', 'aria-label': 'Command palette',
  });
  const list = h('div', { class: 'ow-palette-list', id: 'ow-palette-list', role: 'listbox', 'aria-label': 'Results' });
  const footer = h('div', { class: 'ow-palette-foot' }, [
    h('span', {}, [h('kbd', {}, '↑↓'), ' move']),
    h('span', {}, [h('kbd', {}, '⏎'), ' run']),
    h('span', {}, [h('kbd', {}, '⌥⏎'), ' select session']),
    h('span', {}, [h('kbd', {}, 'Esc'), ' close']),
  ]);
  const el = h('div', { class: 'ow-palette' }, [
    h('div', { class: 'ow-palette-search' }, [icon('search', { size: 16 }), input]),
    list,
    footer,
  ]);
  let results = [];
  let index = 0;
  let lastKey = '';
  let items = [];

  function runItem(r, alt) {
    if (!r) return;
    const it = r.item;
    ctx.ui.dispatch({ type: 'closeModal' });
    if (it.kind === 'session') {
      ctx.run('session.select', { uid: it.uid });
      if (!alt) ctx.run('session.goto', { uid: it.uid });
    } else {
      ctx.run(it.command, it.args);
    }
  }

  input.addEventListener('input', () => {
    index = 0;
    ctx.ui.dispatch({ type: 'updateModal', patch: { query: input.value, index: 0 } });
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      index = moveCursor(index, e.key === 'ArrowDown' ? 1 : -1, results.length);
      ctx.ui.dispatch({ type: 'updateModal', patch: { index } });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      runItem(results[index], e.altKey);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      ctx.ui.dispatch({ type: 'closeModal' });
    } else if (e.key === 'k' && e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      ctx.ui.dispatch({ type: 'closeModal' });
    }
  });

  function update(f, modal) {
    items = paletteItems({ sessions: f.server.sessions || [], projects: f.server.projects || [], reply: f.reply, now: f.now });
    results = paletteResults(modal.query, items);
    index = Math.min(modal.index || 0, Math.max(0, results.length - 1));
    const key = `${modal.query}|${index}|${results.map((r) => `${r.item.key}:${r.item.subtitle}`).join(',')}`;
    if (key === lastKey) return;
    lastKey = key;
    while (list.firstChild) list.removeChild(list.firstChild);
    if (!results.length) {
      list.appendChild(h('div', { class: 'ow-palette-empty' }, `No commands or sessions match “${modal.query}”`));
      attr(input, 'aria-activedescendant', null);
      return;
    }
    let lastGroup = null;
    results.forEach((r, i) => {
      const it = r.item;
      const group = it.kind === 'session' ? 'Sessions' : 'Commands';
      if (!modal.query && group !== lastGroup) {
        list.appendChild(h('div', { class: 'ow-palette-group', role: 'presentation' }, group));
        lastGroup = group;
      }
      const title = h('span', { class: 'ow-palette-title' }, highlightSegments(it.title, r.indices)
        .map((seg) => (seg.match ? h('mark', {}, seg.text) : seg.text)));
      const lead = it.kind === 'session'
        ? h('span', { class: 'ow-palette-lead', 'data-state': it.state }, stateIcon(it.state))
        : h('span', { class: 'ow-palette-lead' }, icon('chevronRight', { size: 14 }));
      const opt = h('div', {
        class: 'ow-palette-item', role: 'option', id: `ow-pal-${i}`, 'aria-selected': i === index ? 'true' : 'false',
        onMousedown: (e) => {
          e.preventDefault();
          runItem(r, e.altKey);
        },
        onMousemove: () => {
          if (index !== i) {
            index = i;
            ctx.ui.dispatch({ type: 'updateModal', patch: { index: i } });
          }
        },
      }, [
        lead,
        h('span', { class: 'ow-palette-text' }, [title, h('span', { class: 'ow-palette-sub' }, it.subtitle || '')]),
        it.shortcut ? h('kbd', { class: 'ow-palette-kbd' }, it.shortcut) : null,
      ]);
      cls(opt, 'is-active', i === index);
      list.appendChild(opt);
      if (i === index) requestAnimationFrame(() => opt.scrollIntoView({ block: 'nearest' }));
    });
    attr(input, 'aria-activedescendant', `ow-pal-${index}`);
  }

  return {
    el, update, label: 'Command palette', size: 'palette', role: 'dialog',
    focus: () => input.focus(),
  };
}
