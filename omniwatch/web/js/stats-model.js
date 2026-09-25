// stats-model.js — "blocked on you" (API.md §5 Stats). The backend object only
// changes on transitions, so the live total adds every in-progress wait
// (`active[].since`) against the client's server-aligned clock.

import { duration } from './activity.js';

/** Minutes for the hero number, "83 min"; hours past 99 min, "1h 43m". */
export function blockedText(seconds) {
  const m = Math.floor(Math.max(0, seconds) / 60);
  if (m < 100) return `${m} min`;
  return duration(m * 60);
}

/**
 * @param {object|null} stats
 * @param {number} now epoch seconds (server clock)
 * @param {object[]} [sessions] to resolve active waits to titles
 */
export function statsModel(stats, now, sessions = []) {
  if (!stats) return null;
  const active = (stats.active || []).map((a) => {
    const s = sessions.find((x) => x.uid === a.uid) || null;
    const seconds = Math.max(0, now - a.since);
    return { uid: a.uid, since: a.since, seconds, text: duration(seconds), title: s ? (s.title || s.display_name || s.uid) : a.uid, agent: s ? s.agent : null };
  });
  const live = active.reduce((sum, a) => sum + a.seconds, 0);
  const total = (stats.waiting_seconds || 0) + live;
  const longest = Math.max(stats.longest_wait_s || 0, ...active.map((a) => a.seconds), 0);
  const answered = stats.answered || 0;
  const waits = stats.waits || 0;
  return {
    day: stats.day,
    totalSeconds: total,
    totalText: blockedText(total),
    longestSeconds: longest,
    longestText: duration(longest),
    answered,
    waits,
    waitingNow: active.length,
    active,
    chipText: `${blockedText(total)} blocked`,
    detailText: `longest ${duration(longest)} · ${answered} answered`,
    summary: `${blockedText(total)} blocked today · longest ${duration(longest)} · ${answered} answered`,
    answerRate: waits ? Math.round((answered / waits) * 100) : null,
    averageSeconds: waits ? total / waits : 0,
  };
}
