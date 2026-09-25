// menus.js — popover menus driven by `ui.menu`: the SortMenu and the
// per-session context menu (go to, zoom, label, mute, tab color → project,
// close). `role="menu"` with arrow-key navigation, Esc closes (via the
// global unwind), click outside closes.

import { h } from '../dom.js';
import { icon } from './icons.js';
import { SORT_CYCLE } from '../sort.js';

const SORT_HELP = {
  natural: 'Window, tab, pane',
  attention: 'Waiting first, longest wait on top',
  agents: 'Agent sessions first',
  activity: 'Most recent output first',
  path: 'Alphabetical by path',
};

export function sortMenuItems(current) {
  return SORT_CYCLE.map((s) => ({
    id: `sort.set.${s}`, label: s[0].toUpperCase() + s.slice(1), hint: SORT_HELP[s], checked: s === current, role: 'menuitemradio',
  }));
}

export function contextMenuItems(s, { projects = [], tabColors = null, reply = false } = {}) {
  const args = { uid: s.uid };
  const items = [
    { id: 'session.goto', label: 'Go to session', icon: 'goto', kbd: '⏎', args },
    { id: 'zoom.toggle', label: 'Zoom', icon: 'zoom', kbd: 'Space', select: true },
  ];
  if (reply) items.push({ id: 'reply.focus', label: 'Reply…', icon: 'send', kbd: 'i', select: true });
  items.push({ id: 'history.open', label: 'Activity timeline', icon: 'history', kbd: 'T', args });
  items.push({ sep: true, heading: 'Open in' });
  items.push({ id: 'reveal.editor', label: 'Editor', icon: 'code', kbd: 'E', args, disabled: !s.path });
  items.push({ id: 'reveal.finder', label: 'Finder', icon: 'folder', kbd: 'O', args, disabled: !s.path });
  items.push({ id: 'reveal.copyPath', label: 'Copy path', icon: 'copy', kbd: 'Y', args, disabled: !s.path });
  items.push({ sep: true });
  items.push({ id: 'label.edit', label: s.label ? 'Edit label…' : 'Add label…', icon: 'tag', kbd: 'L', args });
  items.push({ id: 'session.mute.toggle', label: s.muted ? 'Unmute' : 'Mute', icon: s.muted ? 'bell' : 'bellOff', args });
  items.push({ sep: true, heading: 'Tab color' });
  for (const p of projects) {
    items.push({
      id: `color.set.${p.slot}`, label: p.name || p.color, sub: p.name ? p.color : '', dot: p.color, kbd: String(p.slot), args,
      checked: s.tab_color === p.color, disabled: tabColors === false,
    });
  }
  items.push({ id: 'color.clear', label: 'Clear color', kbd: '0', args, disabled: tabColors === false || !s.tab_color });
  items.push({ sep: true });
  items.push({ id: 'tab.close', label: 'Close tab…', icon: 'close', kbd: 'X', args, danger: true });
  return items;
}

export function createMenuHost(ctx, root) {
  let active = null; // {key, el}

  function close() {
    if (!active) return;
    const hadFocus = active.el.contains(document.activeElement);
    if (active.el.parentNode) active.el.parentNode.removeChild(active.el);
    document.removeEventListener('mousedown', onOutside, true);
    active = null;
    if (hadFocus) ctx.focusList();
  }

  function onOutside(e) {
    if (active && !active.el.contains(e.target)) ctx.ui.dispatch({ type: 'closeMenu' });
  }

  function build(menu, f) {
    let items;
    let label;
    if (menu.type === 'sort') {
      items = sortMenuItems(f.sort);
      label = 'Sort sessions';
    } else {
      const s = (f.server.sessions || []).find((x) => x.uid === menu.uid);
      if (!s) return null;
      items = contextMenuItems(s, { projects: f.server.projects || [], tabColors: (f.server.capabilities || {}).tab_colors, reply: !!f.replyFor(s) });
      label = `Actions for ${s.path_display || s.name || 'session'}`;
    }
    const buttons = [];
    const el = h('div', { class: `ow-menu ow-menu-${menu.type}`, role: 'menu', 'aria-label': label, tabindex: '-1' });
    for (const it of items) {
      if (it.sep) {
        el.appendChild(h('div', { class: 'ow-menu-sep', role: 'separator' }));
        if (it.heading) el.appendChild(h('div', { class: 'ow-menu-heading', role: 'presentation' }, it.heading));
        continue;
      }
      const b = h('button', {
        class: `ow-menu-item${it.danger ? ' is-danger' : ''}`, type: 'button', role: it.role || (it.checked !== undefined && it.dot ? 'menuitemradio' : 'menuitem'),
        'aria-checked': it.checked === undefined ? undefined : String(!!it.checked), disabled: it.disabled || undefined,
        onClick: () => {
          ctx.ui.dispatch({ type: 'closeMenu' });
          if (it.select && menu.uid) ctx.run('session.select', { uid: menu.uid });
          ctx.run(it.id, it.args);
        },
      }, [
        h('span', { class: 'ow-menu-lead' }, it.dot ? h('span', { class: 'ow-dot', 'data-color': it.dot })
          : (it.checked ? icon('check', { size: 14 }) : (it.icon ? icon(it.icon, { size: 14 }) : null))),
        h('span', { class: 'ow-menu-label' }, [it.label, it.sub ? h('span', { class: 'ow-menu-sub' }, it.sub) : null,
          it.hint ? h('span', { class: 'ow-menu-hint' }, it.hint) : null]),
        it.dot && it.checked ? h('span', { class: 'ow-menu-check' }, icon('check', { size: 13 })) : null,
        it.kbd ? h('kbd', {}, it.kbd) : null,
      ]);
      buttons.push(b);
      el.appendChild(b);
    }
    if (menu.type === 'context' && (f.server.capabilities || {}).tab_colors === false) {
      el.appendChild(h('div', { class: 'ow-menu-note' }, 'Tab colors need the iTerm2 Python API — see Setup guide'));
    }
    el.addEventListener('keydown', (e) => {
      const enabled = buttons.filter((b) => !b.disabled);
      const i = enabled.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        const n = enabled.length;
        const next = e.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n;
        enabled[next].focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        ctx.ui.dispatch({ type: 'closeMenu' });
      } else if (e.key === 'Tab') {
        e.preventDefault();
      } else if (e.key !== 'Enter' && e.key !== ' ') {
        e.stopPropagation();
      }
    });
    return { el, buttons };
  }

  function position(el, menu) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const r = el.getBoundingClientRect();
    let x = menu.x || 0;
    let y = menu.y || 0;
    if (menu.alignRight) x -= r.width;
    if (menu.above) y -= r.height + 4;
    x = Math.max(6, Math.min(x, vw - r.width - 6));
    y = Math.max(6, Math.min(y, vh - r.height - 6));
    el.style.setProperty('left', `${Math.round(x)}px`);
    el.style.setProperty('top', `${Math.round(y)}px`);
  }

  function update(f) {
    const menu = f.ui.menu;
    const key = menu ? `${menu.type}:${menu.uid || ''}:${menu.x}:${menu.y}` : null;
    if (!menu) {
      close();
      return;
    }
    if (active && active.key === key) return;
    close();
    const built = build(menu, f);
    if (!built) {
      ctx.ui.dispatch({ type: 'closeMenu' });
      return;
    }
    root.appendChild(built.el);
    position(built.el, menu);
    active = { key, el: built.el };
    document.addEventListener('mousedown', onOutside, true);
    const first = built.buttons.find((b) => b.getAttribute('aria-checked') === 'true' && menu.type === 'sort') || built.buttons.find((b) => !b.disabled);
    if (first) first.focus();
  }

  return { update, isOpen: () => !!active };
}
