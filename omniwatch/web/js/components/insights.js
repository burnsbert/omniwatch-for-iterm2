// insights.js — the "Blocked on you" stats chip + card (API.md §5 Stats,
// live portion from `active[]`) and the per-session activity sheet (8 h
// history from GET /sessions/{uid}/history).

import { h } from '../dom.js';
import { icon, stateIcon } from './icons.js';
import { text, attr, cls } from './patch.js';
import { statsModel } from '../stats-model.js';
import { waitingHistogram, clockTime, duration } from '../activity.js';
import { renderHistogram, renderHistory, createRibbon, updateRibbon } from './activity.js';
import { agentLabel } from '../viewmodel.js';

/** Toolbar chip: "83 min blocked · longest 13m · 14 answered". */
export function createStatsChip(ctx) {
  const main = h('span', { class: 'ow-stats-main' });
  const detail = h('span', { class: 'ow-stats-detail' });
  const el = h('button', {
    class: 'ow-stats-chip', type: 'button', 'aria-haspopup': 'dialog',
    onClick: () => ctx.run('stats.open'),
  }, [h('span', { class: 'ow-stats-icon' }, icon('hourglass', { size: 14 })), main, detail]);
  function update(f) {
    const m = f.stats;
    // Nothing to say before the first wait of the day (e.g. iTerm2 not running).
    el.hidden = !m || (m.waits === 0 && m.waitingNow === 0 && m.totalSeconds < 60);
    if (el.hidden) return;
    text(main, m.chipText);
    text(detail, m.detailText);
    cls(el, 'is-live', m.waitingNow > 0);
    attr(el, 'aria-label', `${m.summary}. Open the blocked-on-you card.`);
    attr(el, 'title', `${m.summary} — click for details`);
  }
  return { el, update };
}

function tile(label, value, sub, tone) {
  const v = h('div', { class: 'ow-st-value' });
  const s = h('div', { class: 'ow-st-sub' });
  const el = h('div', { class: 'ow-st-tile', 'data-tone': tone || null }, [h('div', { class: 'ow-st-label' }, label), v, s]);
  return { el, set: (value2, sub2) => { text(v, value2); text(s, sub2); } };
}

/** Modal card for the stats chip. */
export function createStatsCard(ctx) {
  const hero = h('div', { class: 'ow-st-hero-num' });
  const heroSub = h('div', { class: 'ow-st-hero-sub' });
  const day = h('span', { class: 'ow-st-day' });
  const longest = tile('Longest wait');
  const answered = tile('Answered');
  const now = tile('Waiting now', '', '', 'attention');
  const histoHost = h('div', { class: 'ow-st-histo' });
  const histoFrom = h('span', {});
  const histoTo = h('span', {});
  const list = h('ul', { class: 'ow-st-list' });
  const el = h('div', { class: 'ow-sheet ow-stats-card' }, [
    h('header', { class: 'ow-sheet-head' }, [
      h('h2', {}, [icon('hourglass', { size: 16 }), 'Blocked on you', day]),
      h('button', { class: 'ow-icon-btn', type: 'button', 'aria-label': 'Close', title: 'Close (Esc)', onClick: () => ctx.ui.dispatch({ type: 'closeModal' }) }, icon('close', { size: 15 })),
    ]),
    h('div', { class: 'ow-sheet-body' }, [
      h('div', { class: 'ow-st-hero' }, [hero, heroSub]),
      h('div', { class: 'ow-st-tiles' }, [longest.el, answered.el, now.el]),
      h('section', { class: 'ow-st-section' }, [
        h('h3', {}, 'Agents waiting on you, last 8 hours'),
        histoHost,
        h('div', { class: 'ow-st-axis' }, [histoFrom, histoTo]),
      ]),
      h('section', { class: 'ow-st-section' }, [h('h3', {}, 'Waiting right now'), list]),
      h('p', { class: 'ow-sheet-note' }, 'Counts agent sessions only. The total includes waits that are still open and resets at local midnight.'),
    ]),
  ]);
  let histoKey = '';
  let listKey = '';

  function update(f) {
    const m = f.stats;
    if (!m) {
      text(hero, '—');
      text(heroSub, 'No stats from the backend yet');
      return;
    }
    text(day, m.day ? `· ${m.day}` : '');
    text(hero, m.totalText);
    text(heroSub, `across ${m.waits} wait${m.waits === 1 ? '' : 's'} today · about ${duration(m.averageSeconds)} each`);
    longest.set(m.longestText, 'single wait today');
    answered.set(String(m.answered), m.answerRate != null ? `of ${m.waits} waits · ${m.answerRate}%` : 'no waits yet');
    now.set(String(m.waitingNow), m.waitingNow ? `oldest ${m.active[0].text}` : 'nobody is waiting');
    const hist = waitingHistogram(f.server.sessions);
    const hk = hist ? `${hist.end}:${hist.bars.map((b) => b.count).join('')}` : 'none';
    if (hk !== histoKey) {
      histoKey = hk;
      while (histoHost.firstChild) histoHost.removeChild(histoHost.firstChild);
      const node = renderHistogram(hist);
      if (node) histoHost.appendChild(node);
      text(histoFrom, hist ? clockTime(hist.start) : '');
      text(histoTo, hist ? 'now' : '');
    }
    const lk = m.active.map((a) => `${a.uid}:${a.text}:${a.title}`).join('|');
    if (lk !== listKey) {
      listKey = lk;
      while (list.firstChild) list.removeChild(list.firstChild);
      if (!m.active.length) list.appendChild(h('li', { class: 'ow-st-empty' }, 'Nobody is waiting for you. Nice.'));
      for (const a of m.active) {
        list.appendChild(h('li', {}, h('button', {
          class: 'ow-st-row', type: 'button', title: 'Show this session',
          onClick: () => {
            ctx.ui.dispatch({ type: 'closeModal' });
            ctx.run('session.select', { uid: a.uid });
          },
        }, [
          h('span', { class: 'ow-st-row-state' }, stateIcon('waiting')),
          h('span', { class: 'ow-st-row-title' }, a.title),
          a.agent ? h('span', { class: 'ow-chip', 'data-agent': a.agent }, agentLabel(a.agent)) : null,
          h('span', { class: 'ow-st-row-age' }, a.text),
          icon('chevronRight', { size: 14 }),
        ])));
      }
    }
  }
  return { el, update, label: 'Blocked on you today', size: 'sheet' };
}

/** Modal sheet: one session's 8 h activity. */
export function createHistorySheet(ctx) {
  const title = h('span', { class: 'ow-hs-title' });
  const sub = h('span', { class: 'ow-hs-sub' });
  const ribbon = createRibbon({ size: 'lg' });
  const body = h('div', { class: 'ow-hs-body' });
  const el = h('div', { class: 'ow-sheet ow-history-sheet' }, [
    h('header', { class: 'ow-sheet-head' }, [
      h('h2', {}, [icon('history', { size: 16 }), h('span', { class: 'ow-hs-heading' }, [title, sub])]),
      h('div', { class: 'ow-hs-actions' }, [
        h('button', { class: 'ow-icon-btn', type: 'button', 'aria-label': 'Reload', title: 'Reload', onClick: () => ctx.loadHistory(ctx.ui.get().modal.uid, true) }, icon('refresh', { size: 15 })),
        h('button', { class: 'ow-icon-btn', type: 'button', 'aria-label': 'Close', title: 'Close (Esc)', onClick: () => ctx.ui.dispatch({ type: 'closeModal' }) }, icon('close', { size: 15 })),
      ]),
    ]),
    h('div', { class: 'ow-sheet-body' }, [
      h('div', { class: 'ow-hs-label' }, 'Last 8 hours in 10-minute steps'),
      ribbon,
      body,
    ]),
  ]);
  let key = '';
  function update(f, modal) {
    const s = (f.server.sessions || []).find((x) => x.uid === modal.uid);
    text(title, s ? (s.path_display || s.name || s.uid) : 'Session closed');
    text(sub, s ? [s.label, agentLabel(s.agent), s.tab_label && `tab ${s.tab_label}`].filter(Boolean).join(' · ') : '');
    updateRibbon(ribbon, s && s.ribbon);
    const hist = f.ui.history && f.ui.history.uid === modal.uid ? f.ui.history : null;
    const k = hist ? `${hist.at}:${Math.floor(f.now / 30)}` : 'loading';
    if (k === key) return;
    key = k;
    while (body.firstChild) body.removeChild(body.firstChild);
    if (!hist) body.appendChild(h('div', { class: 'ow-hist-loading' }, [h('span', { class: 'ow-banner-spinner' }), 'Loading timeline…']));
    else if (hist.data && hist.data.error) body.appendChild(h('div', { class: 'ow-hist-empty' }, hist.data.error));
    else body.appendChild(renderHistory(hist.data, f.now));
  }
  return { el, update, label: 'Activity timeline', size: 'wide' };
}

export { statsModel };
