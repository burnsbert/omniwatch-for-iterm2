// feedback.js — ToastStack (P-52: bottom-right, 5 s, hover pauses),
// ConnectionBanner ("Reconnecting…", §2.9), the quota-email banner (P-21),
// EmptyState panels (§2.9, P-54) and the shortcut HintBar (P-53).

import { h } from '../dom.js';
import { icon } from './icons.js';
import { text, reconcile } from './patch.js';

// ---------------------------------------------------------------- toasts

const TOAST_ICONS = { info: 'info', warn: 'alert', error: 'alert', attention: 'bell' };

export function createToastStack(ctx, root) {
  function create(t) {
    const msg = h('span', { class: 'ow-toast-msg' });
    const action = h('button', { class: 'ow-toast-action', type: 'button' });
    const close = h('button', {
      class: 'ow-toast-close', type: 'button', 'aria-label': 'Dismiss',
      onClick: (e) => {
        e.stopPropagation();
        ctx.ui.dispatch({ type: 'dismissToast', id: el.__owId });
      },
    }, icon('close', { size: 12 }));
    // Attention toasts already start with the ◉ glyph (P-32 text), so they get no extra icon.
    const glyph = t.level === 'attention' ? null : h('span', { class: 'ow-toast-icon' }, icon(TOAST_ICONS[t.level] || 'info', { size: 14 }));
    const el = h('div', { class: 'ow-toast', 'data-level': t.level }, [glyph, msg, action, close]);
    el.__ow = { msg, action };
    el.__owId = t.id;
    el.addEventListener('mouseenter', () => ctx.ui.dispatch({ type: 'pauseToast', id: el.__owId, now: Date.now() }));
    el.addEventListener('mouseleave', () => ctx.ui.dispatch({ type: 'resumeToast', id: el.__owId, now: Date.now() }));
    action.addEventListener('click', () => {
      const cur = el.__owToast;
      if (cur && cur.command) ctx.run(cur.command, cur.args);
      ctx.ui.dispatch({ type: 'dismissToast', id: el.__owId });
    });
    return el;
  }
  function update(f) {
    reconcile(root, f.ui.toasts, (t) => t.id, create, (el, t) => {
      el.__owToast = t;
      text(el.__ow.msg, t.message);
      text(el.__ow.action, t.actionLabel || '');
      el.__ow.action.hidden = !t.command;
    });
  }
  return { update };
}

// --------------------------------------------------------------- banners

export function createBanners(ctx, root) {
  const conn = h('div', { class: 'ow-banner', 'data-tone': 'warn', role: 'status', hidden: true }, [
    h('span', { class: 'ow-banner-spinner', 'aria-hidden': 'true' }), h('span', {}, 'Reconnecting to the Omniwatch backend…'),
  ]);
  const quotaText = h('span', {});
  const quota = h('div', { class: 'ow-banner', 'data-tone': 'attention', role: 'status', hidden: true }, [
    icon('mail', { size: 14 }), quotaText, h('span', { class: 'ow-spacer' }),
    h('button', { class: 'ow-btn ow-btn-sm ow-btn-primary', type: 'button', onClick: () => ctx.run('quota.draft') }, 'Draft email'),
    h('button', { class: 'ow-btn ow-btn-sm', type: 'button', onClick: () => ctx.run('quota.skip') }, 'Skip this month'),
  ]);
  const staleText = h('span', {});
  const stale = h('div', { class: 'ow-banner', 'data-tone': 'danger', role: 'alert', hidden: true }, [
    icon('alert', { size: 14 }), staleText, h('span', { class: 'ow-spacer' }),
    h('button', { class: 'ow-btn ow-btn-sm', type: 'button', onClick: () => ctx.run('refresh') }, 'Retry'),
  ]);
  root.appendChild(conn);
  root.appendChild(stale);
  root.appendChild(quota);
  function update(f) {
    conn.hidden = f.server.connectionStatus !== 'reconnecting';
    const q = f.server.quota_prompt;
    quota.hidden = !q;
    if (q) text(quotaText, `Claude usage is at ${Math.round(q.pct || 0)}% of your monthly limit. Draft a heads-up email${q.to ? ` to ${q.to}` : ''}?`);
    const it = f.server.iterm || {};
    // Stale data stays visible with an error line above it (§2.9 `error`).
    const showErr = it.status === 'error' && (f.server.sessions || []).length > 0;
    stale.hidden = !showErr;
    if (showErr) text(staleText, `iTerm2 query failed: ${it.error || 'unknown error'} — showing the last snapshot`);
  }
  return { update };
}

// ------------------------------------------------------------ empty states

const EMPTY_ICONS = {
  not_running: 'terminal', not_authorized: 'shield', error: 'alert', connecting: 'refresh', no_sessions: 'terminal',
  no_match: 'search', grid_empty: 'grid',
};

export function renderEmptyState(ctx, model) {
  const actions = model.actions.map((a) => h('button', {
    class: `ow-btn${a.primary ? ' ow-btn-primary' : ''}`, type: 'button', onClick: () => ctx.run(a.id),
  }, [a.label, a.hint ? h('kbd', {}, a.hint) : null]));
  const skeleton = model.kind === 'connecting'
    ? h('div', { class: 'ow-skeleton', 'aria-hidden': 'true' }, [1, 2, 3, 4].map(() => h('div', { class: 'ow-skel-row' }, [h('span', {}), h('span', {})])))
    : null;
  return h('div', { class: 'ow-empty', 'data-kind': model.kind, role: model.kind === 'error' ? 'alert' : 'status' }, [
    skeleton,
    h('div', { class: `ow-empty-icon${model.kind === 'connecting' ? ' is-spinning' : ''}` }, icon(EMPTY_ICONS[model.kind] || 'info', { size: 28 })),
    h('h2', {}, model.title),
    model.body ? h('p', {}, model.body) : null,
    actions.length ? h('div', { class: 'ow-empty-actions' }, actions) : null,
  ]);
}

// --------------------------------------------------------------- hint bar

export function createHintBar() {
  const el = h('div', { class: 'ow-hints', 'aria-hidden': 'true' });
  let lastKey = '';
  function update(f) {
    el.hidden = f.prefs.hint_bar === false || f.layout === 'compact';
    const key = JSON.stringify(f.hints);
    if (key === lastKey) return;
    lastKey = key;
    while (el.firstChild) el.removeChild(el.firstChild);
    for (const [k, label] of f.hints) el.appendChild(h('span', { class: 'ow-hint' }, [h('kbd', {}, k), label]));
  }
  return { el, update };
}
