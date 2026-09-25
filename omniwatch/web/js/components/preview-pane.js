// preview-pane.js — Preview (+PreviewHeader, ScreenPane, ReplyBar,
// PreviewFooter), §2.1/§2.3. Used three ways: the split-view preview, the
// list/compact bottom drawer (P-44, drag to resize) and the zoom overlay
// (P-47). The screen shows the full text pinned to the bottom; scrolling
// up unpins it (P-42). The reply bar appears only for waiting agent
// sessions with quick reply on (§3 P0).

import { h } from '../dom.js';
import { icon, stateIcon } from './icons.js';
import { text, attr, cls, show, cssVar } from './patch.js';
import { MAX_LABEL_CHARS } from '../reply.js';

export function createPreviewPane(ctx, { variant = 'full' } = {}) {
  // ---- header
  const stateHost = h('span', { class: 'ow-pv-state-icon' });
  const stateText = h('span', { class: 'ow-pv-state-text' });
  const stateEl = h('span', { class: 'ow-pv-state' }, [stateHost, stateText]);
  const pathEl = h('span', { class: 'ow-pv-path' });
  const labelPill = h('button', {
    class: 'ow-pill ow-pill-btn', type: 'button', title: 'Edit label (l)',
    onClick: () => ctx.run('label.edit', { uid: current && current.uid }),
  });
  const addLabel = h('button', {
    class: 'ow-ghost-btn ow-pv-addlabel', type: 'button', title: 'Add a label (l)',
    onClick: () => ctx.run('label.edit', { uid: current && current.uid }),
  }, [icon('tag', { size: 12 }), 'Label']);
  const labelHost = h('span', { class: 'ow-pv-label' }, [labelPill, addLabel]);
  const chip = h('span', { class: 'ow-chip' });
  const tabEl = h('span', { class: 'ow-pv-tab' });
  const dot = h('span', { class: 'ow-dot' });
  const nameEl = h('span', { class: 'ow-pv-name' });
  const muteBtn = h('button', {
    class: 'ow-icon-btn', type: 'button', onClick: () => ctx.run('session.mute.toggle', { uid: current && current.uid }),
  });
  const zoomBtn = h('button', {
    class: 'ow-icon-btn', type: 'button',
    onClick: () => ctx.run('zoom.toggle'),
  });
  const gotoBtn = h('button', {
    class: 'ow-btn ow-btn-primary ow-btn-sm', type: 'button', title: 'Go to this session in iTerm2 (⏎)',
    onClick: () => ctx.run('session.goto', { uid: current && current.uid }),
  }, [icon('goto', { size: 14 }), h('span', { class: 'ow-btn-label' }, 'Go to'), h('kbd', {}, '⏎')]);
  const header = h('header', { class: 'ow-pv-head' }, [
    h('div', { class: 'ow-pv-title' }, [stateEl, pathEl, labelHost]),
    h('div', { class: 'ow-pv-meta' }, [chip, tabEl, dot, nameEl]),
    h('div', { class: 'ow-pv-actions' }, [muteBtn, zoomBtn, gotoBtn]),
  ]);

  // ---- screen
  const pre = h('pre', { class: 'ow-screen', tabindex: '0', 'data-region': 'preview' });
  const jump = h('button', {
    class: 'ow-jump', type: 'button', hidden: true,
    onClick: () => {
      pinned = true;
      pre.scrollTop = pre.scrollHeight;
      jump.hidden = true;
    },
  }, [icon('arrowDown', { size: 12 }), 'Latest']);
  const screenWrap = h('div', { class: 'ow-screen-wrap' }, [pre, jump]);
  let pinned = true;
  pre.addEventListener('scroll', () => {
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 6;
    if (atBottom !== pinned) {
      pinned = atBottom;
      jump.hidden = pinned;
    }
  }, { passive: true });

  // ---- reply bar
  const replyQ = h('div', { class: 'ow-reply-q' });
  const replyOpts = h('div', { class: 'ow-reply-opts' });
  const replyInput = h('input', {
    class: 'ow-input ow-reply-input', type: 'text', maxlength: '2000', spellcheck: 'false', autocomplete: 'off',
    'aria-label': 'Reply text', 'data-reply-input': '1',
  });
  const replySend = h('button', { class: 'ow-btn ow-btn-sm', type: 'button', title: 'Send and press Return (⏎)' }, [icon('send', { size: 13 }), 'Send']);
  const replyForm = h('form', { class: 'ow-reply-form', autocomplete: 'off' }, [replyInput, replySend]);
  const reply = h('section', { class: 'ow-reply', 'aria-label': 'Quick reply', hidden: true }, [
    h('div', { class: 'ow-reply-head' }, [icon('send', { size: 12 }), h('span', {}, 'Reply'), replyQ]),
    replyOpts,
    replyForm,
  ]);
  let sending = false;
  async function sendText(submit) {
    if (!current || sending) return;
    const value = replyInput.value;
    sending = true;
    cls(reply, 'is-sending', true);
    const ok = await ctx.ctl.sendReply(current.uid, value, submit);
    sending = false;
    cls(reply, 'is-sending', false);
    if (ok) replyInput.value = '';
  }
  replyForm.addEventListener('submit', (e) => {
    e.preventDefault();
    sendText(true);
  });
  replySend.addEventListener('click', (e) => {
    e.preventDefault();
    sendText(true);
  });
  replyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      replyInput.blur();
      ctx.focusList();
    }
  });

  // ---- footer
  const liveDot = h('span', { class: 'ow-live-dot', 'aria-hidden': 'true' });
  const freshEl = h('span', { class: 'ow-pv-fresh' });
  const ruleEl = h('span', { class: 'ow-pv-rule' });
  const moreBtn = h('button', {
    class: 'ow-icon-btn', type: 'button', title: 'More actions', 'aria-label': 'More actions', 'aria-haspopup': 'menu',
    onClick: (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      if (current) ctx.openContextMenu(current.uid, r.right, r.top, { alignRight: true, above: true });
    },
  }, icon('more', { size: 16 }));
  const footZoom = h('button', { class: 'ow-ghost-btn', type: 'button', onClick: () => ctx.run('zoom.toggle') });
  const footer = h('footer', { class: 'ow-pv-foot' }, [
    liveDot, freshEl, ruleEl, h('span', { class: 'ow-spacer' }), footZoom, moreBtn,
  ]);

  // ---- drawer handle (list/compact)
  const handle = variant === 'drawer' ? h('div', {
    class: 'ow-drawer-handle', role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Resize preview',
    tabindex: '0', title: 'Drag to resize the preview',
  }, h('span', { class: 'ow-drawer-grip' })) : null;
  if (handle) wireDrawerHandle(ctx, handle, pre);

  const empty = h('div', { class: 'ow-pv-empty' }, [icon('terminal', { size: 28 }), h('p', {}, 'Select a session to see its screen')]);

  const el = h('section', {
    class: `ow-preview ow-preview-${variant}`, 'aria-label': variant === 'zoom' ? 'Zoomed session' : 'Session preview',
  }, [handle, header, screenWrap, reply, footer, empty]);

  let current = null;
  let lastUid = null;
  let labelInput = null;
  let labelCancelled = false;

  function updateLabelEditor(s, editing) {
    if (editing && !labelInput) {
      labelCancelled = false;
      labelInput = h('input', {
        class: 'ow-input ow-label-input', type: 'text', value: s.label || '', maxlength: String(MAX_LABEL_CHARS),
        placeholder: 'Label this session', 'aria-label': 'Session label', spellcheck: 'false',
      });
      const uid = s.uid;
      labelInput.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          ctx.run('label.save', { uid, label: labelInput.value });
          ctx.focusList();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          labelCancelled = true;
          ctx.ui.dispatch({ type: 'stopEditLabel' });
          ctx.focusList();
        }
      });
      labelInput.addEventListener('blur', () => {
        if (!labelCancelled && labelInput && ctx.ui.get().editingLabel === uid) {
          ctx.run('label.save', { uid, label: labelInput.value });
        }
      });
      labelHost.appendChild(labelInput);
      labelInput.focus();
      labelInput.select();
    } else if (!editing && labelInput) {
      const i = labelInput;
      labelInput = null;
      if (i.parentNode) i.parentNode.removeChild(i);
    }
    labelPill.hidden = editing || !s.label;
    addLabel.hidden = editing || !!s.label;
  }

  function update(f, s) {
    current = s;
    const has = !!s;
    show(header, has);
    show(screenWrap, has);
    show(footer, has);
    show(empty, !has);
    if (!has) {
      show(reply, false);
      attr(el, 'data-state', null);
      return;
    }
    const m = f.rowModel(s);
    attr(el, 'data-state', m.state);
    attr(el, 'data-agent', m.agent || null);
    cls(el, 'is-flash', !!f.flashes[s.uid]);

    // header
    const iconKey = `${m.state}:${m.muted}`;
    if (stateHost.__owKey !== iconKey) {
      stateHost.__owKey = iconKey;
      while (stateHost.firstChild) stateHost.removeChild(stateHost.firstChild);
      stateHost.appendChild(stateIcon(m.state, { muted: m.muted, size: 14 }));
    }
    text(stateText, f.stateWithAge(s));
    text(pathEl, m.pathDisplay || '~');
    attr(pathEl, 'title', s.path || m.pathDisplay || '');
    text(labelPill, m.label);
    text(chip, m.agentLabel || (m.dashboard ? 'Ultrawatch' : ''));
    attr(chip, 'data-agent', m.agent || (m.dashboard ? 'dashboard' : null));
    chip.hidden = !(m.agentLabel || m.dashboard);
    text(tabEl, m.tabLabel ? `tab ${m.tabLabel}` : '');
    attr(dot, 'data-color', m.tabColor || null);
    attr(dot, 'title', f.colorTitle(s) || null);
    dot.hidden = !m.tabColor;
    text(nameEl, m.name && m.name !== m.label ? m.name : '');
    updateLabelEditor(s, f.labelHost === variant && f.ui.editingLabel === s.uid);

    setIconButton(muteBtn, m.muted ? 'bellOff' : 'bell', m.muted ? 'Unmute session' : 'Mute session (no notifications, sound or flash)');
    cls(muteBtn, 'is-on', m.muted);
    attr(muteBtn, 'aria-pressed', m.muted ? 'true' : 'false');
    const zoomed = variant === 'zoom';
    setIconButton(zoomBtn, zoomed ? 'close' : 'zoom', zoomed ? 'Exit zoom (Esc)' : 'Zoom (Space)');
    text(footZoom, zoomed ? 'Exit zoom · Esc' : 'Zoom · Space');

    // screen: only touch the text node when it changed, keep the bottom pin
    const screen = f.screens[s.uid];
    const body = screen ? screen.text.replace(/\s+$/u, '') : '';
    if (lastUid !== s.uid) {
      pinned = true;
      jump.hidden = true;
      lastUid = s.uid;
    }
    if (pre.__owText !== body) {
      text(pre, body || ' ');
      pre.__owText = body;
      if (pinned) pre.scrollTop = pre.scrollHeight;
    }
    attr(pre, 'aria-label', `Screen of ${m.pathDisplay || m.name || 'session'}`);

    // reply bar
    const r = f.replyFor(s);
    show(reply, !!r);
    if (r) {
      text(replyQ, r.question);
      const key = r.options.map((o) => `${o.index}:${o.key}:${o.label}:${o.selected}`).join('|');
      if (replyOpts.__owKey !== key) {
        replyOpts.__owKey = key;
        while (replyOpts.firstChild) replyOpts.removeChild(replyOpts.firstChild);
        for (const o of r.options) {
          replyOpts.appendChild(h('button', {
            class: `ow-reply-opt${o.selected ? ' is-default' : ''}`, type: 'button',
            title: `Send “${o.key}” (${o.shortcut})`,
            onClick: () => ctx.run(`reply.send.${o.index}`),
          }, [h('kbd', {}, o.key), h('span', { class: 'ow-reply-opt-label' }, o.label), h('span', { class: 'ow-reply-opt-kbd' }, o.shortcut)]));
        }
      }
      show(replyOpts, r.options.length > 0);
      attr(replyInput, 'placeholder', r.freeTextHint);
    }

    // footer
    const foot = f.footer(s);
    text(freshEl, foot.fresh);
    cls(liveDot, 'is-live', foot.live);
    text(ruleEl, foot.rule);
    ruleEl.hidden = !foot.rule;
    if (variant === 'drawer') cssVar(el, '--ow-drawer-lines', String(f.ui.drawerLines));
  }

  return {
    el,
    update,
    focusReply: () => {
      if (!reply.hidden) {
        replyInput.focus();
        return true;
      }
      return false;
    },
    focusScreen: () => pre.focus(),
  };
}

function setIconButton(btn, name, title) {
  if (btn.__owIcon !== name) {
    btn.__owIcon = name;
    while (btn.firstChild) btn.removeChild(btn.firstChild);
    btn.appendChild(icon(name, { size: 15 }));
  }
  attr(btn, 'title', title);
  attr(btn, 'aria-label', title);
}

function wireDrawerHandle(ctx, handle, pre) {
  let startY = 0;
  let startLines = 3;
  let lineH = 16;
  const onMove = (e) => {
    const dy = startY - e.clientY;
    ctx.ui.dispatch({ type: 'setDrawerLines', lines: startLines + dy / lineH });
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    document.body.classList.remove('is-resizing-v');
  };
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    startY = e.clientY;
    startLines = ctx.ui.get().drawerLines;
    lineH = parseFloat(getComputedStyle(pre).lineHeight) || 16;
    document.body.classList.add('is-resizing-v');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
  handle.addEventListener('keydown', (e) => {
    const lines = ctx.ui.get().drawerLines;
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      ctx.ui.dispatch({ type: 'setDrawerLines', lines: lines + 2 });
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      ctx.ui.dispatch({ type: 'setDrawerLines', lines: lines - 2 });
    }
  });
  handle.addEventListener('dblclick', () => {
    const lines = ctx.ui.get().drawerLines;
    ctx.ui.dispatch({ type: 'setDrawerLines', lines: lines > 3 ? 3 : 14 });
  });
}
