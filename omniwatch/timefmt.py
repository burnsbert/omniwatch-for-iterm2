"""Time parsing and human-readable reset formatting.

Ported verbatim from ultrawatch_lib/timefmt.py (see docs/DESIGN.md §4.2).
All functions that compare against the current time accept an optional
``now`` parameter so tests can be deterministic.
"""
import re
from datetime import datetime, timezone


def parse_iso(iso_string):
    """Parse an ISO 8601 datetime string (Python 3.7+ compatible)."""
    try:
        return datetime.fromisoformat(iso_string)
    except (ValueError, AttributeError):
        # Python < 3.11: fromisoformat doesn't handle +HH:MM offsets
        s = re.sub(r'([+-]\d{2}):(\d{2})$', r'\1\2', iso_string)
        fmt = '%Y-%m-%dT%H:%M:%S.%f%z' if '.' in s else '%Y-%m-%dT%H:%M:%S%z'
        return datetime.strptime(s, fmt)


def format_abs_time(dt_local, now=None):
    """Format a local datetime as 'Today at 2:59pm', 'Friday at 11:59am', etc."""
    now = now or datetime.now()
    today = now.date()
    delta_days = (dt_local.date() - today).days
    time_str = dt_local.strftime('%-I:%M') + dt_local.strftime('%p').lower()

    if delta_days == 0:
        return f'Today at {time_str}'
    if delta_days == 1:
        return f'Tomorrow at {time_str}'
    if delta_days < 7:
        return f'{dt_local.strftime("%A")} at {time_str}'
    return f'{dt_local.strftime("%b %-d")} at {time_str}'


def format_reset_time(iso_string, now=None):
    """Format ISO timestamp as '2h 15m (Today at 2:59pm)' or '5d 3h (Friday at 11:59am)'."""
    if not iso_string:
        return ''
    try:
        now = now or datetime.now(timezone.utc)
        reset_utc = parse_iso(iso_string)
        total_seconds = int((reset_utc - now).total_seconds())
        if total_seconds <= 0:
            return 'now'
        days = total_seconds // 86400
        hours = (total_seconds % 86400) // 3600
        minutes = (total_seconds % 3600) // 60
        if days > 0:
            relative = f'{days}d {hours}h'
        elif hours > 0:
            relative = f'{hours}h {minutes}m'
        else:
            relative = f'{minutes}m'
        reset_local = reset_utc.astimezone()
        return f'{relative} ({format_abs_time(reset_local, now=now.astimezone())})'
    except Exception:
        return ''


def format_epoch_reset_time(epoch_seconds, now=None):
    """Format epoch seconds as a reset countdown."""
    if not epoch_seconds:
        return ''
    try:
        now = now or datetime.now(timezone.utc)
        reset_utc = datetime.fromtimestamp(epoch_seconds, timezone.utc)
        total_seconds = int((reset_utc - now).total_seconds())
        if total_seconds <= 0:
            return 'now'
        days = total_seconds // 86400
        hours = (total_seconds % 86400) // 3600
        minutes = (total_seconds % 3600) // 60
        if days > 0:
            relative = f'{days}d {hours}h'
        elif hours > 0:
            relative = f'{hours}h {minutes}m'
        else:
            relative = f'{minutes}m'
        return (f'{relative} '
                f'({format_abs_time(reset_utc.astimezone(), now=now.astimezone())})')
    except Exception:
        return ''


def format_reset_delta(reset_dt, now=None):
    """Format a local reset datetime as a countdown plus absolute time."""
    try:
        now = now or datetime.now()
        total_seconds = int((reset_dt - now).total_seconds())
        if total_seconds <= 0:
            return 'now'
        days = total_seconds // 86400
        hours = (total_seconds % 86400) // 3600
        minutes = (total_seconds % 3600) // 60
        if days > 0:
            relative = f'{days}d {hours}h'
        elif hours > 0:
            relative = f'{hours}h {minutes}m'
        else:
            relative = f'{minutes}m'
        return f'{relative} ({format_abs_time(reset_dt, now=now)})'
    except Exception:
        return ''


def next_month_start(now=None):
    """Return local midnight on the first day of the next month."""
    now = now or datetime.now()
    month_start = datetime(now.year, now.month, 1)
    if now.month == 12:
        return month_start.replace(year=now.year + 1, month=1)
    return month_start.replace(month=now.month + 1)
