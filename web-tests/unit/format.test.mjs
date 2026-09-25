import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ageStr, formatAbsTime, formatEpochResetTime, rowAge, freshnessText, isFresh, staleLabel,
} from '../../omniwatch/web/js/format.js';

// Parity with ultrawatch_lib/ui/draw.py:age_str (P-30).
test('ageStr(): seconds/minutes/hours/days thresholds, matching Python age_str', () => {
  assert.equal(ageStr(0), '0s');
  assert.equal(ageStr(59), '59s');
  assert.equal(ageStr(60), '1m');
  assert.equal(ageStr(3599), '59m');
  assert.equal(ageStr(3600), '1h');
  assert.equal(ageStr(86399), '23h');
  assert.equal(ageStr(86400), '1d');
  assert.equal(ageStr(-5), '0s'); // clamped, matching Python's max(0, int(seconds))
});

// Parity with ultrawatch_lib/timefmt.py:format_abs_time.
test('formatAbsTime(): Today/Tomorrow/weekday/month-day, matching Python format_abs_time', () => {
  const now = new Date(2026, 8, 25, 14, 0, 0); // Friday, Sep 25 2026, 2:00pm local
  assert.equal(formatAbsTime(new Date(2026, 8, 25, 17, 59), now), 'Today at 5:59pm');
  assert.equal(formatAbsTime(new Date(2026, 8, 26, 8, 0), now), 'Tomorrow at 8:00am');
  assert.equal(formatAbsTime(new Date(2026, 8, 28, 11, 0), now), 'Monday at 11:00am');
  // delta_days == 6 (Oct 1) is still < 7, so it's a weekday name, not "Oct 1"...
  assert.equal(formatAbsTime(new Date(2026, 9, 1, 0, 0), now), 'Thursday at 12:00am');
  // ...delta_days == 7 (Oct 2) crosses the "< 7" boundary into month/day form.
  assert.equal(formatAbsTime(new Date(2026, 9, 2, 0, 0), now), 'Oct 2 at 12:00am');
  // Midday boundary: 12:00 is noon (pm), 00:00 is midnight (am), no leading zero on the hour.
  assert.equal(formatAbsTime(new Date(2026, 8, 25, 12, 5), now), 'Today at 12:05pm');
  assert.equal(formatAbsTime(new Date(2026, 8, 25, 0, 5), now), 'Today at 12:05am');
  assert.equal(formatAbsTime(new Date(2026, 8, 25, 9, 5), now), 'Today at 9:05am');
});

// Parity with ultrawatch_lib/timefmt.py:format_epoch_reset_time.
test('formatEpochResetTime(): "Xh Ym (Today at ...)" countdown, ticks with `now`', () => {
  const now = new Date(2026, 8, 25, 15, 44, 0).getTime() / 1000; // 3:44pm
  const resetAt = new Date(2026, 8, 25, 17, 59, 0).getTime() / 1000; // 5:59pm same day -> 2h15m
  assert.equal(formatEpochResetTime(resetAt, now), '2h 15m (Today at 5:59pm)');
});

test('formatEpochResetTime(): days+hours once past 24h, and "now" once elapsed', () => {
  const now = new Date(2026, 8, 25, 12, 0, 0).getTime() / 1000;
  const in5d3h = now + (5 * 86400) + (3 * 3600);
  assert.match(formatEpochResetTime(in5d3h, now), /^5d 3h \(/);
  assert.equal(formatEpochResetTime(now - 10, now), 'now');
});

test('formatEpochResetTime(): falsy epoch returns empty string', () => {
  assert.equal(formatEpochResetTime(0), '');
  assert.equal(formatEpochResetTime(null), '');
  assert.equal(formatEpochResetTime(undefined), '');
});

// Parity with ultrawatch_lib/ui/list_view.py:row_age (P-30).
test('rowAge(): "wait Xm" for a waiting session with state_since', () => {
  const session = { state: 'waiting', state_since: 1000, last_change: 1000 };
  assert.equal(rowAge(session, 1000 + 190), 'wait 3m');
});

test('rowAge(): "idle Xm" only once idle/quiet age reaches 60s', () => {
  const idleSession = { state: 'idle', state_since: 0, last_change: 1000 };
  assert.equal(rowAge(idleSession, 1000 + 59), '');
  assert.equal(rowAge(idleSession, 1000 + 60), 'idle 1m');
  const quietSession = { state: 'quiet', state_since: 0, last_change: 1000 };
  assert.equal(rowAge(quietSession, 1000 + 1320), 'idle 22m');
});

test('rowAge(): busy/active/no-state sessions have no age text', () => {
  assert.equal(rowAge({ state: 'busy', state_since: 1000, last_change: 1000 }, 2000), '');
  assert.equal(rowAge({ state: 'active', state_since: 1000, last_change: 1000 }, 2000), '');
  assert.equal(rowAge({ state: null, state_since: null, last_change: null }, 2000), '');
});

// P-41.
test('freshnessText(): "live" under 3s, else "updated Xs ago"', () => {
  assert.equal(freshnessText(0), 'live · updated just now');
  assert.equal(freshnessText(2.9), 'live · updated just now');
  assert.equal(freshnessText(3), 'updated 3s ago');
  assert.equal(freshnessText(90), 'updated 1m ago');
});

// P-29.
test('isFresh(): true only while now < fresh_until', () => {
  assert.equal(isFresh({ fresh_until: 1010 }, 1000), true);
  assert.equal(isFresh({ fresh_until: 1010 }, 1010), false);
  assert.equal(isFresh({ fresh_until: null }, 1000), false);
  assert.equal(isFresh({}, 1000), false);
});

test('staleLabel(): "Stale · Xs" (P-26)', () => {
  assert.equal(staleLabel(12), 'Stale · 12s');
});
