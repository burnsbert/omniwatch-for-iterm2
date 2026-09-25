// modal-host.js — mounts the active modal (palette, shortcut sheet,
// settings, confirm, onboarding) from `ui.modal`, with a backdrop,
// `role="dialog"` + `aria-modal`, focus trapping (§2.7), Esc handled by
// the global unwind, and focus restored to where it was on close.

import { h } from '../dom.js';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusables(root) {
  return Array.from(root.querySelectorAll(FOCUSABLE)).filter((el) => !el.hidden && el.offsetParent !== null);
}

/**
 * @param {object} ctx
 * @param {Record<string, (ctx) => {el:HTMLElement, update:Function, focus?:Function, size?:string, label:string}>} factories
 */
export function createModalHost(ctx, root, factories) {
  let active = null; // {type, comp, wrap, restore}

  function close() {
    if (!active) return;
    const { wrap, restore } = active;
    active = null;
    wrap.classList.add('is-leaving');
    const done = () => {
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    };
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) done();
    else setTimeout(done, 120);
    if (restore && restore.isConnected && typeof restore.focus === 'function') restore.focus({ preventScroll: true });
    else ctx.focusList();
  }

  function open(modal) {
    const factory = factories[modal.type];
    if (!factory) return;
    const restore = document.activeElement;
    const comp = factory(ctx);
    const dialog = h('div', {
      class: `ow-dialog ow-dialog-${modal.type}${comp.size ? ` ow-dialog-${comp.size}` : ''}`,
      role: comp.role || 'dialog', 'aria-modal': 'true', 'aria-label': comp.label, tabindex: '-1',
    }, comp.el);
    const backdrop = h('div', { class: 'ow-backdrop' });
    const wrap = h('div', { class: `ow-modal-wrap ow-modal-${modal.type}` }, [backdrop, dialog]);
    backdrop.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (comp.dismissable !== false) ctx.ui.dispatch({ type: 'closeModal' });
    });
    dialog.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const items = focusables(dialog);
      if (!items.length) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
      e.stopPropagation();
    });
    root.appendChild(wrap);
    active = { type: modal.type, comp, wrap, restore, dialog, key: modal };
    return active;
  }

  function update(f) {
    const modal = f.ui.modal;
    if (!modal) {
      close();
      return;
    }
    if (active && active.type !== modal.type) close();
    let justOpened = false;
    if (!active) {
      open(modal);
      justOpened = true;
    }
    if (!active) return;
    active.comp.update(f, modal);
    if (justOpened) {
      // Sheets take focus on the dialog itself (Tab then reaches the first
      // control), so no control shows a focus ring the moment it opens.
      if (active.comp.focus) active.comp.focus();
      else active.dialog.focus();
    }
  }

  return { update, isOpen: () => !!active, activeType: () => active && active.type };
}
