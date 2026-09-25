// usage.js — UsageStrip (P-49) and UsageView + LimitCard (P-51, §2.4).
// The strip is a compact meter row per provider (collapsible, persisted
// `usage_strip`); clicking it opens the full view. Countdowns tick
// client-side because the models are rebuilt from `resets_at` each frame.

import { h } from '../dom.js';
import { icon } from './icons.js';
import { text, attr, cls, cssVar } from './patch.js';

function meter(l) {
  const fill = h('span', { class: 'ow-meter-fill' });
  cssVar(fill, '--pct', `${l.pct}%`);
  return h('span', { class: 'ow-meter', 'data-tone': l.tone, role: 'img', 'aria-label': `${l.label} ${l.pctText}` }, fill);
}

export function createUsageStrip(ctx) {
  const body = h('button', {
    class: 'ow-strip-body', type: 'button', title: 'Open usage (u)', onClick: () => ctx.run('usage.open'),
  });
  const toggle = h('button', {
    class: 'ow-icon-btn ow-icon-btn-sm', type: 'button',
    onClick: () => ctx.run('usageStrip.toggle'),
  });
  const el = h('div', { class: 'ow-strip' }, [body, toggle]);
  let lastKey = '';

  function update(f) {
    const m = f.usage;
    // The compact companion layout always shows the one-line summary.
    const collapsed = f.prefs.usage_strip === 'collapsed' || f.layout === 'compact';
    const key = JSON.stringify([collapsed, m.providers.map((p) => [p.id, p.message && p.message.text,
      p.limits.map((l) => [l.label, l.pctText, l.tone, l.reset.rel, l.warning && l.warning.text, l.dollars && l.dollars.text])])]);
    cls(el, 'is-collapsed', collapsed);
    attr(toggle, 'title', collapsed ? 'Expand usage strip' : 'Collapse usage strip');
    attr(toggle, 'aria-label', collapsed ? 'Expand usage strip' : 'Collapse usage strip');
    if (toggle.__owIcon !== collapsed) {
      toggle.__owIcon = collapsed;
      while (toggle.firstChild) toggle.removeChild(toggle.firstChild);
      toggle.appendChild(icon(collapsed ? 'chevronUp' : 'chevronDown', { size: 14 }));
    }
    if (key === lastKey) return;
    lastKey = key;
    while (body.firstChild) body.removeChild(body.firstChild);
    if (m.empty) {
      body.appendChild(h('span', { class: 'ow-strip-empty' }, [icon('gauge', { size: 13 }), 'Usage limits appear while Claude Code or Codex is running']));
      return;
    }
    if (collapsed) {
      const items = [];
      for (const p of m.providers) {
        const peak = p.peak;
        items.push(h('span', { class: 'ow-strip-sum' }, [
          h('span', { class: 'ow-strip-provider', 'data-agent': p.id }, p.name),
          peak ? h('span', { class: 'ow-strip-pct', 'data-tone': peak.tone }, peak.pctText) : null,
          peak ? h('span', { class: 'ow-strip-lbl' }, peak.label) : null,
          p.message ? h('span', { class: 'ow-strip-msg', 'data-tone': p.message.tone }, p.message.text) : null,
        ]));
      }
      body.appendChild(h('span', { class: 'ow-strip-line' }, items));
      return;
    }
    for (const p of m.providers) {
      const cells = [h('span', { class: 'ow-strip-provider', 'data-agent': p.id }, p.name)];
      for (const l of p.limits) {
        cells.push(h('span', { class: 'ow-strip-limit', title: l.resetText || l.label }, [
          h('span', { class: 'ow-strip-lbl' }, l.label),
          h('span', { class: 'ow-strip-pct', 'data-tone': l.tone }, l.pctText),
          meter(l),
          l.reset.rel ? h('span', { class: 'ow-strip-reset' }, l.reset.rel) : null,
          l.dollars ? h('span', { class: 'ow-strip-dollars' }, l.dollars.shown ? l.dollars.text : '$ hidden') : null,
        ]));
        if (l.warning) {
          cells.push(h('span', { class: 'ow-strip-warn', 'data-tone': l.warning.tone }, [icon('alert', { size: 12 }), l.warning.text]));
        }
      }
      if (p.message) cells.push(h('span', { class: 'ow-strip-msg', 'data-tone': p.message.tone }, p.message.text));
      body.appendChild(h('span', { class: 'ow-strip-line' }, cells));
    }
  }

  return { el, update };
}

export function createUsageView(ctx) {
  const refreshed = h('span', { class: 'ow-usage-refreshed' });
  const dollarsBtn = h('button', {
    class: 'ow-btn ow-btn-sm', type: 'button', onClick: () => ctx.run('dollars.toggle'),
  });
  const refreshBtn = h('button', {
    class: 'ow-btn ow-btn-sm', type: 'button', title: 'Refresh (r)', onClick: () => ctx.run('refresh'),
  }, [icon('refresh', { size: 13 }), 'Refresh']);
  const closeBtn = h('button', {
    class: 'ow-icon-btn', type: 'button', title: 'Back (u or Esc)', 'aria-label': 'Close usage',
    onClick: () => ctx.run('usage.toggle'),
  }, icon('close', { size: 15 }));
  const content = h('div', { class: 'ow-usage-content' });
  const el = h('section', { class: 'ow-usage-view', 'aria-label': 'Usage', tabindex: '-1' }, [
    h('header', { class: 'ow-usage-head' }, [
      h('div', { class: 'ow-usage-heading' }, [h('h2', {}, 'Usage'), refreshed]),
      h('div', { class: 'ow-usage-actions' }, [dollarsBtn, refreshBtn, closeBtn]),
    ]),
    content,
  ]);
  let lastKey = '';

  function update(f) {
    const m = f.usage;
    text(refreshed, m.refreshed);
    while (dollarsBtn.firstChild) dollarsBtn.removeChild(dollarsBtn.firstChild);
    dollarsBtn.appendChild(icon('dollar', { size: 13 }));
    dollarsBtn.appendChild(document.createTextNode(f.prefs.show_dollars ? 'Hide $' : 'Show $'));
    attr(dollarsBtn, 'title', 'Toggle dollar amounts ($)');
    attr(dollarsBtn, 'aria-pressed', f.prefs.show_dollars ? 'true' : 'false');
    const key = JSON.stringify(m);
    if (key === lastKey) return;
    lastKey = key;
    while (content.firstChild) content.removeChild(content.firstChild);
    if (m.empty) {
      content.appendChild(h('div', { class: 'ow-empty ow-empty-inline' }, [
        h('div', { class: 'ow-empty-icon' }, icon('gauge', { size: 28 })),
        h('h3', {}, m.emptyTitle),
        h('p', {}, m.emptyBody),
      ]));
      return;
    }
    for (const p of m.providers) {
      const cards = p.limits.map((l) => limitCard(l));
      content.appendChild(h('section', { class: 'ow-usage-provider', 'data-agent': p.id }, [
        h('h3', { class: 'ow-usage-provider-name' }, [h('span', { class: 'ow-dot', 'data-agent': p.id }), p.longName]),
        p.message ? h('p', { class: 'ow-usage-msg', 'data-tone': p.message.tone }, [icon(p.message.tone === 'muted' ? 'info' : 'alert', { size: 13 }), p.message.text]) : null,
        cards.length ? h('div', { class: 'ow-cards' }, cards) : null,
      ]));
    }
  }

  return { el, update };
}

function limitCard(l) {
  return h('article', { class: 'ow-card', 'data-tone': l.tone, 'aria-label': `${l.title}: ${l.pctText}` }, [
    h('div', { class: 'ow-card-top' }, [
      h('span', { class: 'ow-card-title' }, l.title),
      l.dollars ? h('span', { class: `ow-card-dollars${l.dollars.shown ? '' : ' is-hidden'}` }, l.dollars.text) : null,
    ]),
    h('div', { class: 'ow-card-pct', 'data-tone': l.tone }, l.pctText),
    meter(l),
    h('div', { class: 'ow-card-reset' }, l.resetText || '—'),
    l.warning ? h('div', { class: 'ow-card-warn', 'data-tone': l.warning.tone }, [icon('alert', { size: 13 }), l.warning.text]) : null,
  ]);
}
