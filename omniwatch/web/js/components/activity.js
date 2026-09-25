// activity.js (components) — the activity ribbon (48 × 10 min), the 8 h
// history chart with per-segment tooltips, the "waiting agents" histogram
// for the stats card, and usage sparklines. All geometry comes from the
// pure modules (js/activity.js, js/sparkline.js); these only build DOM/SVG.

import { h, svg } from '../dom.js';
import { attr } from './patch.js';
import { ribbonModel, ribbonSummary, historyModel } from '../activity.js';
import { sparkGeometry } from '../sparkline.js';

/** A ribbon container; call `updateRibbon(el, ribbon)` to (re)draw it. */
export function createRibbon({ size = 'sm', interactive = false, onOpen } = {}) {
  const el = h(interactive ? 'button' : 'div', {
    class: `ow-ribbon ow-ribbon-${size}`, role: interactive ? undefined : 'img', type: interactive ? 'button' : undefined,
  });
  if (interactive && onOpen) el.addEventListener('click', (e) => { e.stopPropagation(); onOpen(); });
  return el;
}

export function updateRibbon(el, ribbon, { label = '' } = {}) {
  const model = ribbonModel(ribbon);
  const key = model ? model.key : 'none';
  el.hidden = !model;
  if (el.__owKey === key) return;
  el.__owKey = key;
  while (el.firstChild) el.removeChild(el.firstChild);
  const summary = ribbonSummary(model);
  attr(el, 'aria-label', label ? `${label}. ${summary}` : summary);
  attr(el, 'title', el.tagName === 'BUTTON' ? `${summary} — click for the full timeline (t)` : summary);
  if (!model) return;
  for (const b of model.buckets) el.appendChild(h('span', { class: 'ow-rb', 'data-code': b.code, title: b.title }));
}

/** Full 8 h history: a segmented bar with hour ticks and totals. */
export function renderHistory(history, now) {
  const m = historyModel(history, now);
  if (!m) return h('div', { class: 'ow-hist-empty' }, 'No activity recorded for this session yet.');
  const bar = h('div', { class: 'ow-hist-bar', role: 'list', 'aria-label': `Activity over the last ${m.hours} hours` },
    m.segments.map((seg) => {
      const el = h('span', {
        class: `ow-hist-seg${seg.ongoing ? ' is-ongoing' : ''}`, 'data-state': seg.state, role: 'listitem',
        title: seg.title, 'aria-label': seg.title, tabindex: '0',
      });
      el.style.setProperty('--l', `${seg.left}%`);
      el.style.setProperty('--w', `${Math.max(0.35, seg.width)}%`);
      return el;
    }));
  const ticks = h('div', { class: 'ow-hist-ticks', 'aria-hidden': 'true' }, m.ticks.map((t) => {
    const el = h('span', { class: 'ow-hist-tick' }, t.label);
    el.style.setProperty('--l', `${t.left}%`);
    return el;
  }));
  const totals = h('ul', { class: 'ow-hist-totals' }, m.totals.map((t) => h('li', { 'data-state': t.state }, [
    h('span', { class: 'ow-hist-swatch', 'data-state': t.state }), h('span', { class: 'ow-hist-total-label' }, t.label), h('strong', {}, t.text),
  ])));
  return h('div', { class: 'ow-hist' }, [
    bar,
    ticks,
    h('div', { class: 'ow-hist-meta' }, [
      totals,
      h('span', { class: 'ow-hist-transitions' }, `${m.transitions} state change${m.transitions === 1 ? '' : 's'}`),
    ]),
  ]);
}

/** Waiting-agents histogram (stats card) from a waitingHistogram() model. */
export function renderHistogram(model) {
  if (!model) return null;
  return h('div', { class: 'ow-histo', role: 'img', 'aria-label': 'Agents waiting for you over the last 8 hours' },
    model.bars.map((b) => {
      const el = h('span', { class: `ow-histo-bar${b.count ? '' : ' is-zero'}`, title: b.title });
      el.style.setProperty('--h', `${Math.max(b.count ? 12 : 4, Math.round(b.height * 100))}%`);
      return el;
    }));
}

/** Usage sparkline SVG; `tone` picks the stroke color via CSS. */
export function sparkline(points, { width = 120, height = 28, from, to, tone = 'ok', label = '' } = {}) {
  const g = sparkGeometry(points, { width, height, from, to });
  if (!g) return null;
  return svg('svg', {
    class: 'ow-spark', 'data-tone': tone, width, height, viewBox: `0 0 ${width} ${height}`,
    role: 'img', 'aria-label': label || `Usage trend, ${Math.round(g.min)}% to ${Math.round(g.max)}%`, preserveAspectRatio: 'none',
  }, [
    svg('path', { class: 'ow-spark-area', d: g.area }),
    svg('path', { class: 'ow-spark-line', d: g.line, fill: 'none' }),
    svg('circle', { class: 'ow-spark-dot', cx: g.last.x, cy: g.last.y, r: 2 }),
  ]);
}
