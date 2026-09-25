// projects.js — ProjectsPanel + ProjectSlot (P-63/64/65): five fixed,
// color-coded project names (blue, purple, green, red, yellow) above the
// session list. Click or ⏎ edits a slot inline (⏎ saves, Esc cancels),
// ↑ from the top session row enters the slots, a row can be dragged onto
// a slot to color its tab, and the ⌫ button clears all (confirmed).

import { h } from '../dom.js';
import { icon } from './icons.js';
import { text, attr, cls } from './patch.js';
import { MAX_PROJECT_CHARS } from '../reply.js';

export function createProjectsPanel(ctx) {
  const toggle = h('button', {
    class: 'ow-panel-toggle', type: 'button', 'aria-expanded': 'false',
    title: 'Show or hide projects (p)', onClick: () => ctx.run('projects.toggle'),
  }, [icon('chevronRight', { size: 12, cls: 'ow-caret' }), h('span', {}, 'Projects')]);
  const preview = h('span', { class: 'ow-projects-peek', 'aria-hidden': 'true' });
  const clearBtn = h('button', {
    class: 'ow-icon-btn ow-icon-btn-sm', type: 'button', title: 'Clear all project names (c)',
    'aria-label': 'Clear all project names', onClick: () => ctx.run('projects.clear'),
  }, icon('trash', { size: 14 }));
  const head = h('div', { class: 'ow-panel-head' }, [toggle, preview, h('span', { class: 'ow-spacer' }), clearBtn]);
  const list = h('div', { class: 'ow-slots', role: 'list', 'data-region': 'projects' });
  const el = h('section', { class: 'ow-projects', 'aria-label': 'Projects' }, [head, list]);

  const slots = [];
  for (let i = 1; i <= 5; i += 1) slots.push(createSlot(ctx, i));
  slots.forEach((s) => list.appendChild(s.el));

  function update(f) {
    const open = !!f.prefs.projects_open;
    cls(el, 'is-open', open);
    attr(toggle, 'aria-expanded', open ? 'true' : 'false');
    list.hidden = !open;
    clearBtn.hidden = !open;
    // Collapsed: a row of the named projects' dots so the panel still says something.
    while (preview.firstChild) preview.removeChild(preview.firstChild);
    if (!open) {
      for (const p of f.projects) {
        if (p.name) preview.appendChild(h('span', { class: 'ow-dot', 'data-color': p.color }));
      }
    }
    slots.forEach((s, i) => s.update(f.projects[i] || { slot: i + 1, name: '', color: '' }, f));
  }

  return { el, update };
}

function createSlot(ctx, slot) {
  const dot = h('span', { class: 'ow-dot ow-dot-lg', 'aria-hidden': 'true' });
  const num = h('kbd', { class: 'ow-slot-num' }, String(slot));
  const name = h('span', { class: 'ow-slot-name' });
  const count = h('span', { class: 'ow-slot-count' });
  const btn = h('button', {
    class: 'ow-slot-btn', type: 'button',
    onClick: () => ctx.run('project.edit', { slot }),
  }, [dot, num, name, count]);
  const el = h('div', { class: 'ow-slot', role: 'listitem', 'data-slot': String(slot) }, btn);
  let input = null;
  let cancelled = false;

  el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('application/x-omniwatch-uid')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'link';
    el.classList.add('is-drop');
  });
  el.addEventListener('dragleave', () => el.classList.remove('is-drop'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('is-drop');
    const uid = e.dataTransfer && e.dataTransfer.getData('application/x-omniwatch-uid');
    if (uid) ctx.run(`color.set.${slot}`, { uid });
  });

  function startEdit(current) {
    cancelled = false;
    input = h('input', {
      class: 'ow-input ow-slot-input', type: 'text', value: current, maxlength: String(MAX_PROJECT_CHARS),
      'aria-label': `Project ${slot} name`, placeholder: `Project ${slot} name`, spellcheck: 'false',
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        ctx.run('project.save', { slot, name: input.value });
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancelled = true;
        ctx.ui.dispatch({ type: 'stopEditProject' });
      }
      e.stopPropagation();
    });
    input.addEventListener('blur', () => {
      if (!cancelled && input && ctx.ui.get().editingProject === slot) ctx.run('project.save', { slot, name: input.value });
    });
    el.appendChild(input);
    btn.hidden = true;
    input.focus();
    input.select();
  }

  function stopEdit() {
    if (!input) return;
    const i = input;
    input = null;
    btn.hidden = false;
    if (i.parentNode) i.parentNode.removeChild(i);
  }

  function update(p, f) {
    attr(dot, 'data-color', p.color);
    text(name, p.name || 'Unnamed');
    cls(name, 'is-empty', !p.name);
    const n = f.colorCounts[p.color] || 0;
    text(count, n ? String(n) : '');
    attr(btn, 'aria-label', `Project ${slot}, ${p.color}${p.name ? `, ${p.name}` : ', unnamed'}${n ? `, ${n} sessions` : ''}. Press to rename; press ${slot} on a session to color its tab.`);
    attr(btn, 'title', `${p.color} · press ${slot} on a session to color its tab`);
    cls(el, 'is-kbd-focus', f.ui.projectFocus === slot && f.ui.editingProject !== slot);
    const editing = f.ui.editingProject === slot;
    if (editing && !input) startEdit(p.name || '');
    if (!editing && input) stopEdit();
  }

  return { el, update };
}
