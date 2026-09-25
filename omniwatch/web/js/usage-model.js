// usage-model.js — pure models for the usage strip (P-49) and the usage
// view (P-51, §2.4) built from the State `usage` blocks (§4.4.1). Reset
// countdowns are recomputed from `resets_at` against the passed-in `now`
// so they tick client-side; the server's `reset_text` is only a fallback.

import { ageStr, formatEpochResetTime, formatAbsTime } from './format.js';

export const PROVIDERS = Object.freeze([
  { id: 'claude', name: 'Claude', longName: 'Claude Code' },
  { id: 'codex', name: 'Codex', longName: 'Codex' },
]);

/** P-19: green <50, yellow 50–79, red ≥80. */
export function levelForPct(pct) {
  const p = Number(pct) || 0;
  if (p >= 80) return 'red';
  if (p >= 50) return 'yellow';
  return 'green';
}

/** Map a level to the tone class the CSS colors (ok / warn / danger). */
export function toneForLevel(level) {
  if (level === 'red') return 'danger';
  if (level === 'yellow') return 'warn';
  return 'ok';
}

/** '2h 15m (Today at 5:59pm)' → {rel:'2h 15m', abs:'Today at 5:59pm'}. */
export function resetParts(limit, now) {
  const text = limit.resets_at ? formatEpochResetTime(limit.resets_at, now) : (limit.reset_text || '');
  if (!text) return { rel: '', abs: '', text: '' };
  const m = /^(.*?)\s*\((.*)\)$/.exec(text);
  if (!m) return { rel: text, abs: '', text };
  return { rel: m[1], abs: m[2], text };
}

function isMonthly(limit) {
  return limit.window === 'month' || /monthly|extra/i.test(limit.id || '');
}

/** One limit → the fields both the strip meter and the usage card use. */
export function limitModel(limit, { now, showDollars }) {
  const pct = Math.max(0, Math.min(100, Number(limit.pct) || 0));
  const level = limit.level || levelForPct(pct);
  const reset = resetParts(limit, now);
  const proj = limit.projection || null;
  let warning = null;
  if (proj && proj.text) {
    warning = {
      kind: proj.kind === 'hit' ? 'hit' : 'pace',
      text: capitalize(proj.text),
      tone: proj.kind === 'hit' ? 'danger' : 'warn',
    };
  }
  const monthly = isMonthly(limit);
  let dollars = null;
  if (monthly) {
    if (limit.limit_display) dollars = { shown: true, text: limit.limit_display };
    else if (!showDollars) dollars = { shown: false, text: '$ hidden · press $' };
  }
  const burn = burnModel(limit.burn);
  return {
    burn,
    outlook: outlookModel(burn, limit.burn, warning, proj, now),
    id: limit.id,
    label: limit.label || limit.id,
    window: limit.window || '',
    title: limit.window && limit.window !== 'month' ? `${limit.label} · ${limit.window}` : (limit.label || ''),
    pct,
    pctText: `${Math.round(pct)}%`,
    level,
    tone: toneForLevel(level),
    reset,
    resetText: reset.rel ? `Resets in ${reset.rel}${reset.abs ? ` · ${reset.abs}` : ''}` : '',
    warning,
    monthly,
    dollars,
  };
}

/**
 * Burn rate (API.md §5 Burn): "At this rate: 100% Today at 11:49am" in the
 * danger tone when 100 % comes before the reset, muted otherwise.
 */
export function burnModel(burn) {
  if (!burn || !burn.text) return null;
  let tone = 'muted';
  if (burn.text === 'limit hit') tone = 'danger';
  else if (burn.before_reset && burn.eta) tone = 'danger';
  else if (typeof burn.at_reset_pct === 'number' && burn.at_reset_pct >= 80) tone = 'warn';
  const rate = typeof burn.rate_per_hour === 'number' && burn.rate_per_hour > 0 ? `+${formatRate(burn.rate_per_hour)}%/h` : '';
  return { text: capitalize(burn.text), tone, rate, eta: burn.eta || null, beforeReset: !!burn.before_reset };
}

/**
 * One projection per limit (T018): the burn rate when the backend has one,
 * else the legacy on-pace projection. `text` is the full sentence (cards,
 * tooltips); `short` is the strip's compact form; `alert` is false for
 * reassuring outlooks ("~48% at reset", "not rising") the strip can skip.
 */
export function outlookModel(burn, rawBurn, warning, proj, now) {
  if (burn) {
    const b = rawBurn || {};
    let short = burn.text;
    if (b.text === 'limit hit') short = 'limit hit';
    else if (b.before_reset && b.eta) short = `100% ${shortWhen(b.eta, now)}`;
    else if (typeof b.at_reset_pct === 'number') short = `~${Math.round(b.at_reset_pct)}% at reset`;
    else if (b.text === 'not rising') short = 'not rising';
    return { source: 'burn', text: burn.text, short, tone: burn.tone, alert: burn.tone !== 'muted' };
  }
  if (warning) {
    let short = warning.kind === 'hit' ? 'limit hit' : warning.text;
    if (warning.kind === 'pace' && proj && proj.at) short = `hits limit ${shortWhen(proj.at, now)}`;
    return { source: 'projection', text: warning.text, short, tone: warning.tone, alert: true };
  }
  return null;
}

const DAYS = { Sunday: 'Sun', Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat' };

/** "6:10pm" today, "tmrw 8am", "Tue 2:23pm", "Oct 1" — for the crowded strip. */
export function shortWhen(epoch, now) {
  const full = formatAbsTime(new Date(epoch * 1000), new Date((now || epoch) * 1000));
  const m = /^(.*) at (\d+:\d+[ap]m)$/.exec(full);
  if (!m) return full;
  const [, day, time] = m;
  const t = time.replace(':00', '');
  if (day === 'Today') return t;
  if (day === 'Tomorrow') return `tmrw ${t}`;
  if (DAYS[day]) return `${DAYS[day]} ${t}`;
  return day;
}

function formatRate(r) {
  return r >= 10 ? String(Math.round(r)) : String(Math.round(r * 10) / 10);
}

function capitalize(s) {
  const t = String(s).trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

/** Status line for a provider block (P-51 messages; §2.9 no-credentials). */
export function providerMessage(providerId, block, now) {
  if (!block) return null;
  switch (block.status) {
    case 'error':
      return {
        tone: 'danger',
        text: providerId === 'codex' ? 'Codex usage fetch failed' : 'usage API fetch failed',
      };
    case 'stale': {
      const since = block.fetched_at || block.stale_since;
      const ago = since ? ageStr(now - since) : '?';
      return { tone: 'warn', text: `fetch failing — showing data from ${ago} ago` };
    }
    case 'no_credentials':
      return {
        tone: 'muted',
        text: providerId === 'codex' ? 'Codex auth not found' : 'Sign in to Claude Code to see limits',
      };
    default:
      return null;
  }
}

/** Is this provider shown at all? `inactive` (no agent of that kind running) hides it (P-17). */
export function providerVisible(block) {
  return !!block && block.status !== 'inactive';
}

/**
 * Full usage model: providers with their limits, the "refreshed X ago" text,
 * and the no-agents message when every provider is inactive.
 */
export function usageModel(usage, { now, showDollars }) {
  const u = usage || {};
  const providers = [];
  let newest = 0;
  for (const p of PROVIDERS) {
    const block = u[p.id];
    if (!providerVisible(block)) continue;
    const limits = (block.limits || []).map((l) => limitModel(l, { now, showDollars }));
    if (block.fetched_at && limits.length) newest = Math.max(newest, block.fetched_at);
    providers.push({
      id: p.id,
      name: p.name,
      longName: p.longName,
      status: block.status,
      limits,
      message: providerMessage(p.id, block, now),
      peak: limits.reduce((best, l) => (!best || l.pct > best.pct ? l : best), null),
    });
  }
  return {
    providers,
    refreshed: newest ? `Refreshed ${ageStr(now - newest)} ago` : '',
    empty: providers.length === 0,
    emptyTitle: 'No Claude Code or Codex sessions running',
    emptyBody: 'Omniwatch only checks your limits while an agent of that kind is running, so it never polls the usage APIs in the background for nothing.',
  };
}

/** Collapsed strip summary: 'Claude 62% · Codex 84%' (highest limit per provider). */
export function stripSummary(model) {
  return model.providers
    .filter((p) => p.peak)
    .map((p) => ({ id: p.id, name: p.name, pctText: p.peak.pctText, tone: p.peak.tone, label: p.peak.label }));
}
