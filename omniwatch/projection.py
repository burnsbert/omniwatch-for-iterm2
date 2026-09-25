"""Usage-limit pace projections, bars, and severity levels.

Ported from ultrawatch_lib/projection.py, adapted per docs/DESIGN.md §4.2:
the primary API now returns a structured
``{"kind": "hit"|"pace", "at": epoch|None, "text": str}`` (or ``None``)
instead of a pre-indented ``(text, is_hit)`` string tuple. The old
tuple-returning functions (``limit_projection``, ``monthly_limit_projection``,
``codex_limit_projection``) are kept as thin wrappers around the structured
functions so the ported Ultrawatch test suite keeps passing unchanged.

``now`` is injectable for testing and is threaded into the time math and
the formatted output strings.
"""
import calendar
from datetime import datetime, timedelta, timezone

from omniwatch.timefmt import format_abs_time, next_month_start, parse_iso

WINDOW_HOURS = {
    'five_hour': 5,
    'seven_day': 168,
    'seven_day_sonnet': 168,
}

LIMIT_SHORT_NAMES = {
    'five_hour': 'session',
    'seven_day': 'weekly',
    'seven_day_sonnet': 'sonnet',
}


def _epoch(dt):
    return int(dt.timestamp())


def project_limit(key, bucket, now=None):
    """Structured pace projection for a Claude Code rolling window
    (five_hour / seven_day / seven_day_sonnet). Returns
    {"kind": "hit"|"pace", "at": epoch|None, "text": str} or None."""
    if not bucket:
        return None
    pct = bucket.get('utilization') or 0
    resets_at = bucket.get('resets_at')
    if not resets_at or pct <= 0:
        return None
    window_h = WINDOW_HOURS.get(key)
    if not window_h:
        return None
    try:
        reset_utc = parse_iso(resets_at)
        now_dt = now or datetime.now(timezone.utc)
        secs_remaining = max(0, (reset_utc - now_dt).total_seconds())
        window_secs = window_h * 3600
        elapsed_secs = window_secs - secs_remaining
        if elapsed_secs <= 0:
            return None
        elapsed_pct = (elapsed_secs / window_secs) * 100
        name = LIMIT_SHORT_NAMES.get(key, key)
        if pct >= 100:
            return {'kind': 'hit', 'at': None, 'text': f'{name} limit hit'}
        if pct >= elapsed_pct:
            # Project when we'll hit 100% at current rate
            rate = pct / elapsed_secs  # pct per second
            secs_to_100 = (100 - pct) / rate
            hit_time = now_dt + timedelta(seconds=secs_to_100)
            hit_local = hit_time.astimezone()
            text = (f'on pace to hit {name} limit '
                    f'{format_abs_time(hit_local, now=now_dt.astimezone())}')
            return {'kind': 'pace', 'at': _epoch(hit_time), 'text': text}
    except Exception:
        pass
    return None


def limit_projection(key, bucket, now=None):
    """Legacy ``(text, is_hit)`` API kept for the ported Ultrawatch tests."""
    s = project_limit(key, bucket, now=now)
    if not s:
        return None
    return (f'  ⚠ {s["text"]}', s['kind'] == 'hit')


def project_monthly_limit(pct, has_limit, now=None):
    """Structured pace projection for the Claude Code monthly cap. Returns
    {"kind": "hit"|"pace", "at": epoch|None, "text": str} or None."""
    if not has_limit or pct <= 0:
        return None
    now_dt = now or datetime.now()
    if pct >= 100:
        return {'kind': 'hit', 'at': None, 'text': 'monthly limit hit'}
    try:
        days = calendar.monthrange(now_dt.year, now_dt.month)[1]
        month_secs = days * 86400
        elapsed_secs = ((now_dt.day - 1) * 86400 + now_dt.hour * 3600 +
                        now_dt.minute * 60 + now_dt.second)
        if elapsed_secs <= 0:
            return None
        elapsed_pct = (elapsed_secs / month_secs) * 100
        if pct >= elapsed_pct:
            rate = pct / elapsed_secs
            secs_to_100 = (100 - pct) / rate
            hit_time = now_dt + timedelta(seconds=secs_to_100)
            if hit_time < next_month_start(now_dt):
                text = (f'on pace to hit monthly limit '
                        f'{format_abs_time(hit_time, now=now_dt)}')
                return {'kind': 'pace', 'at': _epoch(hit_time), 'text': text}
    except Exception:
        pass
    return None


def monthly_limit_projection(pct, has_limit, now=None):
    """Legacy ``(text, is_hit)`` API kept for the ported Ultrawatch tests."""
    s = project_monthly_limit(pct, has_limit, now=now)
    if not s:
        return None
    return (f'  ⚠ {s["text"]}', s['kind'] == 'hit')


def project_codex_limit(name, window, limit_reached=False, now=None):
    """Structured pace projection for a Codex rate-limit window. `name` is
    a short window label such as '5h' or '7d'. Returns
    {"kind": "hit"|"pace", "at": epoch|None, "text": str} or None."""
    if not window:
        return None
    pct = window.get('used_percent') or 0
    reset_at = window.get('reset_at')
    window_secs = window.get('limit_window_seconds')
    if not reset_at or not window_secs or pct <= 0:
        return None
    if limit_reached or pct >= 100:
        return {'kind': 'hit', 'at': None, 'text': f'Codex {name} limit hit'}
    try:
        reset_utc = datetime.fromtimestamp(reset_at, timezone.utc)
        now_dt = now or datetime.now(timezone.utc)
        secs_remaining = max(0, (reset_utc - now_dt).total_seconds())
        elapsed_secs = window_secs - secs_remaining
        if elapsed_secs <= 0:
            return None
        elapsed_pct = (elapsed_secs / window_secs) * 100
        if pct >= elapsed_pct:
            rate = pct / elapsed_secs
            secs_to_100 = (100 - pct) / rate
            hit_time = now_dt + timedelta(seconds=secs_to_100)
            text = (f'on pace to hit Codex {name} limit '
                    f'{format_abs_time(hit_time.astimezone(), now=now_dt.astimezone())}')
            return {'kind': 'pace', 'at': _epoch(hit_time), 'text': text}
    except Exception:
        pass
    return None


def codex_limit_projection(label, window, limit_reached=False, now=None):
    """Legacy ``(text, is_hit)`` API kept for the ported Ultrawatch tests.
    `label` is the old-style "CX 5h Limit" / "CX 7d Limit" string."""
    name = label.replace('CX ', '').replace(' Limit', '').lower()
    s = project_codex_limit(name, window, limit_reached=limit_reached, now=now)
    if not s:
        return None
    return (f'  ⚠ {s["text"]}', s['kind'] == 'hit')


def usage_bar(pct, width=15):
    """Return a text progress bar for the given percentage."""
    pct = max(0, min(100, pct))
    filled = round(pct / 100 * width)
    return '█' * filled + '░' * (width - filled)


def usage_level(pct):
    """Return a severity level name based on usage percentage.

    The UI maps the level ('red', 'yellow', 'green') to a color token.
    """
    if pct >= 80:
        return 'red'
    if pct >= 50:
        return 'yellow'
    return 'green'
