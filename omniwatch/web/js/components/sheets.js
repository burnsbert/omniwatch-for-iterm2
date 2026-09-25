// sheets.js — ShortcutSheet (P-48), ConfirmDialog (P-65/P-67),
// SettingsSheet (theme, text size, keep on top, notifications, sound,
// quick reply, dollars, hints, classifier rule) and Onboarding (§2.10).

import { h } from '../dom.js';
import { icon, stateIcon } from './icons.js';
import { text, attr, cls } from './patch.js';
import { shortcutSections } from '../shortcuts.js';

// ------------------------------------------------------------ shortcuts

export function createShortcutSheet(ctx) {
  const sections = shortcutSections();
  const grid = h('div', { class: 'ow-keys-grid' }, sections.map((s) => h('section', { class: 'ow-keys-section' }, [
    h('h3', {}, s.category),
    h('dl', { class: 'ow-keys-list' }, s.entries.flatMap((e) => [
      h('dt', {}, e.keys.map((k) => h('kbd', {}, k))),
      h('dd', {}, e.title),
    ])),
  ])));
  const legend = h('div', { class: 'ow-legend' }, [
    legendItem('waiting', 'Waiting for you'), legendItem('busy', 'Working'), legendItem('idle', 'Idle agent'),
    legendItem('active', 'New output'), legendItem('quiet', 'Quiet shell'),
  ]);
  const el = h('div', { class: 'ow-sheet' }, [
    sheetHeader(ctx, 'Keyboard shortcuts', 'keyboard'),
    h('div', { class: 'ow-sheet-body' }, [legend, grid, h('p', { class: 'ow-sheet-note' }, 'Single-key shortcuts work when you are not typing in a field. The global show/hide hotkey (⌃⌥⌘O) and ⌘Q are handled by the app.')]),
  ]);
  return { el, update: () => {}, label: 'Keyboard shortcuts', size: 'wide' };
}

function legendItem(state, label) {
  return h('span', { class: 'ow-legend-item', 'data-state': state }, [stateGlyph(state), label]);
}

function stateGlyph(state) {
  return h('span', { class: 'ow-legend-glyph', 'data-state': state }, stateIcon(state));
}

function sheetHeader(ctx, title, iconName) {
  return h('header', { class: 'ow-sheet-head' }, [
    h('h2', {}, [icon(iconName, { size: 16 }), title]),
    h('button', {
      class: 'ow-icon-btn', type: 'button', 'aria-label': 'Close', title: 'Close (Esc)',
      onClick: () => ctx.ui.dispatch({ type: 'closeModal' }),
    }, icon('close', { size: 15 })),
  ]);
}

// -------------------------------------------------------------- confirm

export function createConfirmDialog(ctx) {
  const title = h('h2', { class: 'ow-confirm-title' });
  const body = h('p', { class: 'ow-confirm-body' });
  const cancel = h('button', {
    class: 'ow-btn', type: 'button', onClick: () => ctx.ui.dispatch({ type: 'closeModal' }),
  }, ['Cancel', h('kbd', {}, 'N')]);
  const okLabel = h('span', {});
  const ok = h('button', {
    class: 'ow-btn ow-btn-primary', type: 'button', onClick: () => ctx.run('confirm.accept'),
  }, [okLabel, h('kbd', {}, 'Y')]);
  const el = h('div', { class: 'ow-confirm' }, [
    h('div', { class: 'ow-confirm-icon' }, icon('alert', { size: 20 })),
    h('div', { class: 'ow-confirm-text' }, [title, body]),
    h('div', { class: 'ow-confirm-actions' }, [cancel, ok]),
  ]);
  el.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'y' || (e.key === 'Enter' && document.activeElement !== cancel)) {
      e.preventDefault();
      e.stopPropagation();
      ctx.run('confirm.accept');
    } else if (k === 'n') {
      e.preventDefault();
      e.stopPropagation();
      ctx.ui.dispatch({ type: 'closeModal' });
    }
  });
  function update(f, modal) {
    text(title, modal.title);
    text(body, modal.body || '');
    text(okLabel, modal.confirmLabel || 'OK');
    cls(ok, 'ow-btn-danger', !!modal.danger);
    cls(el, 'is-danger', !!modal.danger);
  }
  return { el, update, label: 'Confirm', size: 'confirm', role: 'alertdialog', focus: () => ok.focus() };
}

// ------------------------------------------------------------- settings

function toggle(ctx, { label, hint, get, onChange, disabled }) {
  const sw = h('button', { class: 'ow-switch', type: 'button', role: 'switch' }, h('span', { class: 'ow-switch-knob' }));
  const labelEl = h('span', { class: 'ow-set-label' }, label);
  const hintEl = h('span', { class: 'ow-set-hint' }, hint || '');
  const row = h('div', { class: 'ow-set-row' }, [h('div', { class: 'ow-set-text' }, [labelEl, hintEl]), sw]);
  sw.addEventListener('click', () => onChange(!get()));
  return {
    el: row,
    update(f) {
      const on = !!get(f);
      attr(sw, 'aria-checked', on ? 'true' : 'false');
      attr(sw, 'aria-label', label);
      cls(sw, 'is-on', on);
      const dis = disabled ? disabled(f) : false;
      attr(sw, 'disabled', dis || null);
      cls(row, 'is-disabled', !!dis);
      if (typeof hint === 'function') text(hintEl, hint(f));
    },
  };
}

function segmented(ctx, { label, options, get, onChange }) {
  const buttons = options.map((o) => h('button', {
    class: 'ow-seg ow-seg-text', type: 'button', role: 'radio', onClick: () => onChange(o.value),
  }, [o.icon ? icon(o.icon, { size: 14 }) : null, h('span', {}, o.label)]));
  const row = h('div', { class: 'ow-set-row' }, [
    h('div', { class: 'ow-set-text' }, h('span', { class: 'ow-set-label' }, label)),
    h('div', { class: 'ow-segmented', role: 'radiogroup', 'aria-label': label }, buttons),
  ]);
  return {
    el: row,
    update(f) {
      const v = get(f);
      options.forEach((o, i) => {
        attr(buttons[i], 'aria-checked', o.value === v ? 'true' : 'false');
        cls(buttons[i], 'is-on', o.value === v);
      });
    },
  };
}

export function createSettingsSheet(ctx) {
  const prefs = (f) => (f ? f.prefs : ctx.server.get().prefs || {});
  const patch = (p) => ctx.run('prefs.set', p);
  const native = ctx.isNativeHost();
  const controls = [];
  const add = (c) => {
    controls.push(c);
    return c.el;
  };
  const scaleText = h('span', { class: 'ow-scale-value' });
  const scaleRow = h('div', { class: 'ow-set-row' }, [
    h('div', { class: 'ow-set-text' }, [h('span', { class: 'ow-set-label' }, 'Text size'), h('span', { class: 'ow-set-hint' }, '⌘+ / ⌘− / ⌘0')]),
    h('div', { class: 'ow-stepper' }, [
      h('button', { class: 'ow-btn ow-btn-sm', type: 'button', 'aria-label': 'Smaller text', onClick: () => ctx.run('textSize.decrease') }, 'A−'),
      scaleText,
      h('button', { class: 'ow-btn ow-btn-sm', type: 'button', 'aria-label': 'Larger text', onClick: () => ctx.run('textSize.increase') }, 'A+'),
      h('button', { class: 'ow-ghost-btn', type: 'button', onClick: () => ctx.run('textSize.reset') }, 'Reset'),
    ]),
  ]);
  const permText = h('span', { class: 'ow-set-hint' });
  const permBtn = h('button', { class: 'ow-btn ow-btn-sm', type: 'button', onClick: () => ctx.run('notifications.request') }, 'Allow notifications');
  const permRow = h('div', { class: 'ow-set-row' }, [
    h('div', { class: 'ow-set-text' }, [h('span', { class: 'ow-set-label' }, 'Notification permission'), permText]),
    permBtn,
  ]);
  const version = h('span', { class: 'ow-set-hint' });

  const body = h('div', { class: 'ow-sheet-body ow-settings' }, [
    h('h3', { class: 'ow-set-group' }, 'Appearance'),
    add(segmented(ctx, {
      label: 'Theme',
      options: [
        { value: 'system', label: 'System', icon: 'monitor' }, { value: 'light', label: 'Light', icon: 'sun' },
        { value: 'dark', label: 'Dark', icon: 'moon' }, { value: 'high-contrast', label: 'High contrast', icon: 'contrast' },
      ],
      get: (f) => (f.ui.highContrast ? 'high-contrast' : prefs(f).theme || 'system'),
      onChange: (v) => ctx.run('theme.set', { theme: v }),
    })),
    scaleRow,
    add(toggle(ctx, { label: 'Show shortcut hints', hint: 'A hint bar with the keys that apply right now', get: (f) => prefs(f).hint_bar !== false, onChange: (v) => patch({ hint_bar: v }) })),
    h('h3', { class: 'ow-set-group' }, 'Window'),
    add(toggle(ctx, {
      label: 'Keep window on top', hint: native ? 'Float above iTerm2 as a companion window (⌥⌘T)' : 'Available in the Omniwatch app',
      get: (f) => !!prefs(f).keep_on_top, onChange: (v) => ctx.run('keepOnTop.toggle', { value: v }), disabled: () => !native,
    })),
    add(toggle(ctx, {
      label: 'q closes the window', hint: native ? 'Omniwatch keeps running in the menu bar' : 'Available in the Omniwatch app',
      get: (f) => prefs(f).close_window_on_q !== false, onChange: (v) => patch({ close_window_on_q: v }), disabled: () => !native,
    })),
    h('h3', { class: 'ow-set-group' }, 'Attention'),
    add(toggle(ctx, {
      label: 'Notifications', hint: 'When a session starts waiting for you',
      get: (f) => (prefs(f).notifications || {}).enabled !== false,
      onChange: (v) => patch({ notifications: { ...(prefs().notifications || { click: 'goto' }), enabled: v } }),
    })),
    add(segmented(ctx, {
      label: 'Clicking a notification',
      options: [{ value: 'goto', label: 'Go to session' }, { value: 'show', label: 'Show in Omniwatch' }],
      get: (f) => (prefs(f).notifications || {}).click || 'goto',
      onChange: (v) => patch({ notifications: { ...(prefs().notifications || { enabled: true }), click: v } }),
    })),
    permRow,
    add(toggle(ctx, { label: 'Sound on attention', hint: 'A short chime (b)', get: (f) => !!prefs(f).sound, onChange: () => ctx.run('sound.toggle') })),
    h('h3', { class: 'ow-set-group' }, 'Quick reply'),
    add(toggle(ctx, {
      label: 'Reply from Omniwatch',
      hint: 'Answer an agent’s prompt without switching tabs. Only for waiting agents, and only if the screen hasn’t changed since you looked.',
      get: (f) => prefs(f).quick_reply !== false, onChange: () => ctx.run('quickReply.toggle'),
    })),
    h('h3', { class: 'ow-set-group' }, 'Usage'),
    add(toggle(ctx, { label: 'Show dollar amounts', hint: 'Claude monthly limit in dollars ($)', get: (f) => !!prefs(f).show_dollars, onChange: () => ctx.run('dollars.toggle') })),
    add(toggle(ctx, { label: 'Expanded usage strip', hint: 'Show every limit at the bottom of the window', get: (f) => prefs(f).usage_strip !== 'collapsed', onChange: () => ctx.run('usageStrip.toggle') })),
    h('h3', { class: 'ow-set-group' }, 'Advanced'),
    add(toggle(ctx, { label: 'Show classifier rule', hint: 'Which heuristic rule set each session’s state (in the preview footer)', get: (f) => !!prefs(f).debug_rule, onChange: () => ctx.run('debugRule.toggle') })),
    h('div', { class: 'ow-set-row ow-set-about' }, [
      h('div', { class: 'ow-set-text' }, [h('span', { class: 'ow-set-label' }, 'Omniwatch'), version]),
      h('div', { class: 'ow-set-actions' }, [
        h('button', { class: 'ow-btn ow-btn-sm', type: 'button', onClick: () => ctx.run('onboarding.open') }, [icon('sparkles', { size: 13 }), 'Setup guide']),
        h('button', { class: 'ow-btn ow-btn-sm', type: 'button', onClick: () => ctx.run('help.open') }, [icon('keyboard', { size: 13 }), 'Shortcuts']),
      ]),
    ]),
  ]);
  const el = h('div', { class: 'ow-sheet' }, [sheetHeader(ctx, 'Settings', 'gear'), body]);

  function update(f) {
    controls.forEach((c) => c.update(f));
    text(scaleText, `${Math.round((prefs(f).font_scale || 1) * 100)}%`);
    const st = native ? f.ui.notifyPermission : (typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
    const label = {
      granted: 'Allowed', denied: 'Blocked — change it in System Settings › Notifications', default: 'Not asked yet',
      notDetermined: 'Not asked yet', error: 'Unavailable for this build', unsupported: 'Not supported in this browser',
    }[st] || (native ? 'Unknown' : 'Not asked yet');
    text(permText, label);
    permBtn.hidden = st === 'granted' || st === 'denied' || st === 'unsupported';
    text(version, `Version ${f.server.version || '—'}${f.server.demo ? ' · demo mode' : ''}${native ? ' · app' : ' · browser'}`);
  }
  return { el, update, label: 'Settings', size: 'sheet' };
}

// ------------------------------------------------------------ onboarding

const STEPS = [
  { n: 1, title: 'Control iTerm2', icon: 'terminal', required: true },
  { n: 2, title: 'Tab colors & projects', icon: 'palette', required: false },
  { n: 3, title: 'Notifications', icon: 'bell', required: false },
];

export function onboardingStatus(f) {
  const d = f.ui.diagnostics || {};
  const itermOk = (f.server.iterm || {}).status === 'ok';
  const colors = (f.server.capabilities || {}).tab_colors;
  const perm = f.isNative ? f.ui.notifyPermission : (typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
  return {
    1: itermOk ? 'done' : (d.automation === 'denied' || (f.server.iterm || {}).status === 'not_authorized' ? 'blocked' : 'todo'),
    2: colors === true ? 'done' : (d.tab_colors && d.tab_colors.package === false ? 'todo' : (colors === false ? 'todo' : 'unknown')),
    3: perm === 'granted' ? 'done' : (perm === 'denied' ? 'blocked' : 'todo'),
  };
}

export function createOnboarding(ctx) {
  const stepper = h('ol', { class: 'ow-steps' });
  const panel = h('div', { class: 'ow-step-panel' });
  const back = h('button', { class: 'ow-btn', type: 'button' }, 'Back');
  const next = h('button', { class: 'ow-btn ow-btn-primary', type: 'button' }, 'Next');
  const skip = h('button', { class: 'ow-ghost-btn', type: 'button', onClick: () => ctx.run('onboarding.done') }, 'Skip setup');
  const demo = h('button', { class: 'ow-btn', type: 'button', onClick: () => ctx.run('demo.try') }, [icon('play', { size: 13 }), 'Try the demo']);
  const el = h('div', { class: 'ow-sheet ow-onboarding' }, [
    h('header', { class: 'ow-onb-hero' }, [
      h('div', { class: 'ow-onb-logo' }, icon('logo', { size: 28 })),
      h('div', {}, [h('h2', {}, 'Welcome to Omniwatch'), h('p', {}, 'See which agents need you, and what they’re doing, without switching tabs.')]),
    ]),
    stepper,
    panel,
    h('footer', { class: 'ow-onb-foot' }, [skip, demo, h('span', { class: 'ow-spacer' }), back, next]),
  ]);
  let step = 1;
  back.addEventListener('click', () => ctx.ui.dispatch({ type: 'updateModal', patch: { step: Math.max(1, step - 1) } }));
  next.addEventListener('click', () => {
    if (step >= 3) ctx.run('onboarding.done');
    else ctx.ui.dispatch({ type: 'updateModal', patch: { step: step + 1 } });
  });
  let lastKey = '';

  function update(f, modal) {
    step = modal.step || 1;
    const status = onboardingStatus(f);
    const key = JSON.stringify([step, status, f.ui.diagnostics, f.isNative]);
    back.hidden = step === 1;
    text(next, step >= 3 ? 'Done' : 'Next');
    if (key === lastKey) return;
    lastKey = key;
    while (stepper.firstChild) stepper.removeChild(stepper.firstChild);
    for (const s of STEPS) {
      const st = status[s.n];
      stepper.appendChild(h('li', {
        class: `ow-step${s.n === step ? ' is-current' : ''}`, 'data-status': st,
        'aria-current': s.n === step ? 'step' : null,
      }, h('button', {
        type: 'button', class: 'ow-step-btn', onClick: () => ctx.ui.dispatch({ type: 'updateModal', patch: { step: s.n } }),
      }, [
        h('span', { class: 'ow-step-mark' }, st === 'done' ? icon('check', { size: 12 }) : String(s.n)),
        h('span', { class: 'ow-step-title' }, s.title),
        h('span', { class: 'ow-step-tag' }, s.required ? 'Required' : 'Optional'),
      ])));
    }
    while (panel.firstChild) panel.removeChild(panel.firstChild);
    panel.appendChild(stepBody(ctx, step, status[step], f));
  }

  return { el, update, label: 'Set up Omniwatch', size: 'sheet', dismissable: true };
}

function statusLine(st, doneText, todoText, blockedText) {
  const map = { done: ['ok', 'check', doneText], blocked: ['danger', 'alert', blockedText || todoText], todo: ['muted', 'info', todoText], unknown: ['muted', 'info', todoText] };
  const [tone, ic, msg] = map[st] || map.todo;
  return h('p', { class: 'ow-step-status', 'data-tone': tone }, [icon(ic, { size: 13 }), msg]);
}

function copyable(ctx, cmd) {
  const btn = h('button', {
    class: 'ow-icon-btn ow-icon-btn-sm', type: 'button', 'aria-label': `Copy ${cmd}`, title: 'Copy',
    onClick: async () => {
      try {
        await navigator.clipboard.writeText(cmd);
        ctx.ctl.toast('info', 'copied');
      } catch (_) {
        ctx.ctl.toast('warn', 'copy failed — select the text instead');
      }
    },
  }, icon('copy', { size: 13 }));
  return h('div', { class: 'ow-code' }, [h('code', {}, cmd), btn]);
}

function stepBody(ctx, step, st, f) {
  if (step === 1) {
    return h('div', { class: 'ow-step-body' }, [
      h('h3', {}, 'Let Omniwatch read your iTerm2 sessions'),
      h('p', {}, 'Omniwatch asks iTerm2 for each session’s screen text over Apple Events every two seconds. macOS asks you once to allow it. Nothing leaves your Mac.'),
      statusLine(st, 'Connected — Omniwatch can see your sessions.', 'Not granted yet.', 'macOS denied access. Allow Omniwatch under Privacy & Security › Automation, then try again.'),
      h('div', { class: 'ow-step-actions' }, [
        h('button', { class: 'ow-btn ow-btn-primary', type: 'button', onClick: () => ctx.run('automation.probe') }, [icon('shield', { size: 13 }), 'Grant access']),
        h('button', { class: 'ow-btn', type: 'button', onClick: () => ctx.run('automation.open') }, [icon('external', { size: 13 }), 'Open Automation settings']),
      ]),
    ]);
  }
  if (step === 2) {
    return h('div', { class: 'ow-step-body' }, [
      h('h3', {}, 'Color tabs by project'),
      h('p', {}, 'Name up to five projects, then press 1–5 on a session to color its iTerm2 tab. This uses iTerm2’s Python API, which needs a one-time setup:'),
      h('ol', { class: 'ow-step-list' }, [
        h('li', {}, ['In iTerm2, open Settings › General › Magic and turn on ', h('strong', {}, 'Enable Python API'), '.']),
        h('li', {}, ['Install the iterm2 package for Omniwatch’s Python:', copyable(ctx, 'make install-colors')]),
      ]),
      statusLine(st, 'Tab colors are available.', 'Tab colors aren’t available yet. Everything else works without them.'),
    ]);
  }
  const native = f.isNative;
  return h('div', { class: 'ow-step-body' }, [
    h('h3', {}, 'Get told when an agent needs you'),
    h('p', {}, native
      ? 'Omniwatch posts a notification when a session starts waiting, with Go to session and Show in Omniwatch actions. It stays quiet for muted sessions and when you’re already looking.'
      : 'In the browser, Omniwatch can show a notification while this tab is in the background.'),
    statusLine(st, 'Notifications are allowed.', 'Not allowed yet.', 'Notifications are blocked. You can change this in System Settings › Notifications.'),
    h('div', { class: 'ow-step-actions' }, [
      h('button', { class: 'ow-btn ow-btn-primary', type: 'button', onClick: () => ctx.run('notifications.request') }, [icon('bell', { size: 13 }), 'Allow notifications']),
    ]),
  ]);
}
