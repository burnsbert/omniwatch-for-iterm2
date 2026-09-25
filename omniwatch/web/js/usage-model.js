// usage-model.js — pure models for the usage strip (P-49) and the usage
// view (P-51, §2.4) built from the State `usage` blocks (§4.4.1). Reset
// countdowns are recomputed from `resets_at` against the passed-in `now`
// so they tick client-side; the server's `reset_text` is only a fallback.

import { ageStr, formatEpochResetTime } from './format.js';

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
  return {
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
