// activity.js — pure models for the activity timeline (DESIGN §3, API.md §5):
// the compact 48 × 10-minute `session.ribbon`, the full 8 h history from
// `GET /sessions/{uid}/history`, and the "waiting agents over time"
// histogram the stats card draws from every session's ribbon.

export const CODE_STATE = Object.freeze({ w: 'waiting', b: 'busy', i: 'idle', a: 'active', q: 'quiet', '-': 'none' });
export const STATE_NAMES = Object.freeze({
  waiting: 'Waiting', busy: 'Busy', idle: 'Idle', active: 'Output', quiet: 'Quiet', none: 'No data', unknown: 'Unknown',
});

/** "2:05pm" local wall-clock time for an epoch in seconds. */
export function clockTime(epochS) {
  const d = new Date(epochS * 1000);
  let h = d.getHours() % 12;
  if (h === 0) h = 12;
  return `${h}:${String(d.getMinutes()).padStart(2, '0')}${d.getHours() < 12 ? 'am' : 'pm'}`;
}

/** "1h 5m" / "12m" / "40s" duration. */
export function duration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/**
 * Ribbon buckets, oldest first. Bucket i covers
 * [end − (n−i)·bucket_s, end − (n−1−i)·bucket_s).
 * @returns {{key:string, buckets:{code:string, state:string, start:number, end:number, title:string}[], start:number, end:number}|null}
 */
export function ribbonModel(ribbon) {
  if (!ribbon || typeof ribbon.codes !== 'string' || !ribbon.codes.length) return null;
  const n = ribbon.codes.length;
  const size = ribbon.bucket_s || 600;
  const end = ribbon.end || 0;
  const buckets = Array.from(ribbon.codes).map((code, i) => {
    const start = end - (n - i) * size;
    const stop = start + size;
    const state = CODE_STATE[code] || 'none';
    return { code: CODE_STATE[code] ? code : '-', state, start, end: stop, title: `${clockTime(start)}–${clockTime(stop)} · ${STATE_NAMES[state]}` };
  });
  return { key: `${end}:${ribbon.codes}`, buckets, start: end - n * size, end };
}

/** Share of buckets per state (for accessible summaries): {busy: 0.5, …}. */
export function ribbonShares(model) {
  if (!model) return {};
  const out = {};
  for (const b of model.buckets) out[b.state] = (out[b.state] || 0) + 1 / model.buckets.length;
  return out;
}

/** "Last 8 hours: busy 60%, waiting 10%, idle 30%" for aria-label. */
export function ribbonSummary(model) {
  if (!model) return 'No activity recorded yet';
  const hours = Math.round((model.end - model.start) / 3600);
  const parts = Object.entries(ribbonShares(model))
    .filter(([s]) => s !== 'none')
    .sort((a, b) => b[1] - a[1])
    .map(([s, v]) => `${STATE_NAMES[s].toLowerCase()} ${Math.round(v * 100)}%`);
  return `Last ${hours} hours: ${parts.join(', ') || 'no data'}`;
}

/**
 * History (API.md §5) → positioned segments over [from, to] plus totals.
 * `now` closes the ongoing segment (end: null).
 */
export function historyModel(history, now) {
  if (!history || !Array.isArray(history.segments)) return null;
  const from = history.from;
  const to = Math.max(history.to || now || from, now || 0);
  const span = Math.max(1, to - from);
  const segments = history.segments.map((seg) => {
    const start = Math.max(from, seg.start);
    const end = Math.min(to, seg.end == null ? to : seg.end);
    const state = seg.state || 'unknown';
    const secs = Math.max(0, end - start);
    return {
      state,
      start,
      end,
      ongoing: seg.end == null,
      left: ((start - from) / span) * 100,
      width: (secs / span) * 100,
      seconds: secs,
      title: `${STATE_NAMES[state] || state} · ${clockTime(start)}–${seg.end == null ? 'now' : clockTime(end)} · ${duration(secs)}`,
    };
  }).filter((s) => s.width > 0);
  const totals = Object.entries(history.totals || {})
    .map(([state, seconds]) => ({ state, seconds, text: duration(seconds), label: STATE_NAMES[state] || state }))
    .filter((t) => t.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds);
  const ticks = [];
  const firstHour = Math.ceil(from / 3600) * 3600;
  for (let t = firstHour; t <= to; t += 3600) ticks.push({ t, left: ((t - from) / span) * 100, label: clockTime(t).replace(':00', '') });
  return { from, to, segments, totals, ticks, transitions: history.transitions || 0, hours: history.hours || Math.round(span / 3600) };
}

/**
 * Waiting agents per bucket across every session's ribbon (the stats card's
 * "who was blocked on you" histogram). Buckets are aligned because every
 * ribbon shares the same `end` for a given state document.
 */
export function waitingHistogram(sessions) {
  const ribbons = (sessions || []).filter((s) => s.agent && s.ribbon && s.ribbon.codes).map((s) => s.ribbon);
  if (!ribbons.length) return null;
  const end = Math.max(...ribbons.map((r) => r.end || 0));
  const n = Math.max(...ribbons.map((r) => r.codes.length));
  const size = ribbons[0].bucket_s || 600;
  const counts = new Array(n).fill(0);
  for (const r of ribbons) {
    const shift = Math.round((end - (r.end || end)) / size);
    Array.from(r.codes).forEach((c, i) => {
      const j = i - shift + (n - r.codes.length);
      if (c === 'w' && j >= 0 && j < n) counts[j] += 1;
    });
  }
  const max = Math.max(1, ...counts);
  return {
    end,
    start: end - n * size,
    max,
    bars: counts.map((count, i) => ({ count, height: count / max, title: `${clockTime(end - (n - i) * size)} · ${count} waiting` })),
  };
}
