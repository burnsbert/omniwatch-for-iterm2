// format.js — time/age/reset-countdown formatting. Ports, verbatim in
// behavior, `ultrawatch_lib/ui/draw.py:age_str` and
// `ultrawatch_lib/ui/list_view.py:row_age` (P-30), and
// `ultrawatch_lib/timefmt.py:format_abs_time` / `format_epoch_reset_time`
// (used for the client-side-ticking Usage view countdown, §2.4). All
// "epoch"/"now" values here are **seconds** since the Unix epoch (matching
// the server's `server_time`, `state_since`, `resets_at`, ... fields),
// except where a `Date` is explicitly named.

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '3m' style short duration, matching Python's age_str (P-30). */
export function ageStr(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function dateOnly(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function timeOfDay(d) {
  let h = d.getHours() % 12;
  if (h === 0) h = 12;
  const m = String(d.getMinutes()).padStart(2, '0');
  const ap = d.getHours() < 12 ? 'am' : 'pm';
  return `${h}:${m}${ap}`;
}

/**
 * 'Today at 2:59pm' / 'Tomorrow at ...' / 'Friday at ...' / 'Sep 30 at ...',
 * matching Python's `timefmt.format_abs_time`.
 * @param {Date} dtLocal
 * @param {Date} [now]
 */
export function formatAbsTime(dtLocal, now = new Date()) {
  const deltaDays = Math.round((dateOnly(dtLocal) - dateOnly(now)) / 86400000);
  const time = timeOfDay(dtLocal);
  if (deltaDays === 0) return `Today at ${time}`;
  if (deltaDays === 1) return `Tomorrow at ${time}`;
  if (deltaDays > 0 && deltaDays < 7) return `${WEEKDAYS[dtLocal.getDay()]} at ${time}`;
  return `${MONTHS[dtLocal.getMonth()]} ${dtLocal.getDate()} at ${time}`;
}

function relativeDuration(totalSeconds) {
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * '2h 15m (Today at 5:59pm)' countdown to an epoch-seconds reset time,
 * matching Python's `timefmt.format_epoch_reset_time`. Ticks correctly
 * whenever the caller re-invokes it with a fresh `nowEpochSeconds`
 * (Usage view countdowns tick client-side, §2.4).
 * @param {number} epochSeconds
 * @param {number} [nowEpochSeconds] defaults to the current time
 */
export function formatEpochResetTime(epochSeconds, nowEpochSeconds = Date.now() / 1000) {
  if (!epochSeconds) return '';
  try {
    const totalSeconds = Math.floor(epochSeconds - nowEpochSeconds);
    if (totalSeconds <= 0) return 'now';
    const resetDate = new Date(epochSeconds * 1000);
    const nowDate = new Date(nowEpochSeconds * 1000);
    return `${relativeDuration(totalSeconds)} (${formatAbsTime(resetDate, nowDate)})`;
  } catch (_) {
    return '';
  }
}

/**
 * Right-aligned session-row age text: 'wait 3m' (waiting) / 'idle 22m'
 * (idle/quiet, >=60s) / '' otherwise. Ports
 * `ultrawatch_lib/ui/list_view.py:row_age` (P-30) against the Session JSON
 * shape (§4.4.1): `state`, `state_since`, `last_change`.
 * @param {object} session
 * @param {number} nowEpochSeconds
 */
export function rowAge(session, nowEpochSeconds) {
  if (session.state === 'waiting' && session.state_since) {
    return `wait ${ageStr(nowEpochSeconds - session.state_since)}`;
  }
  if ((session.state === 'idle' || session.state === 'quiet') && session.last_change) {
    const age = nowEpochSeconds - session.last_change;
    if (age >= 60) return `idle ${ageStr(age)}`;
  }
  return '';
}

/**
 * Preview footer freshness text (P-41): 'live · updated just now' when the
 * underlying snapshot is <3s old, else 'updated Xs ago'.
 * @param {number} ageSeconds
 */
export function freshnessText(ageSeconds) {
  if (ageSeconds < 3) return 'live · updated just now';
  return `updated ${ageStr(ageSeconds)} ago`;
}

/** True while a row should show the "fresh" (green) tint (P-29). */
export function isFresh(session, nowEpochSeconds) {
  return typeof session.fresh_until === 'number' && nowEpochSeconds < session.fresh_until;
}

/** Status chip text for a stale iTerm snapshot (P-26): 'Stale · 12s'. */
export function staleLabel(ageSeconds) {
  return `Stale · ${ageStr(ageSeconds)}`;
}
