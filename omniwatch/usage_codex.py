"""Codex usage-limit fetching and display rows.

Fetch/merge is unchanged from ultrawatch_lib/usage_codex.py. ``codex_usage_rows``
stays as a thin wrapper (used by the ported test suite); ``limits()`` is
new for Omniwatch (docs/DESIGN.md §4.2, §4.4.1) and returns the structured
rows the HTTP API and web UI consume.
"""
import glob
import json
import os
import time
import urllib.error
import urllib.request

from omniwatch import config
from omniwatch.projection import (project_codex_limit, codex_limit_projection,
                                  usage_level)
from omniwatch.timefmt import format_epoch_reset_time


FIVE_HOURS = 5 * 60 * 60
SEVEN_DAYS = 7 * 24 * 60 * 60
SESSION_LOG_MAX_AGE = 24 * 60 * 60
SESSION_LOG_TAIL_BYTES = 8 * 1024 * 1024


def get_codex_oauth_token():
    """Retrieve Codex OAuth access token from ~/.codex/auth.json."""
    try:
        with open(os.path.join(config.HOME, '.codex', 'auth.json'), 'r') as f:
            creds = json.load(f)
        return creds.get('tokens', {}).get('access_token')
    except Exception:
        return None


def fetch_codex_usage():
    """Fetch Codex account usage limits. Returns (dict, retry_after)."""
    token = get_codex_oauth_token()
    if not token:
        return None, None
    try:
        req = urllib.request.Request(
            'https://chatgpt.com/backend-api/wham/usage',
            method='GET',
            headers={
                'Authorization': f'Bearer {token}',
                'Accept': 'application/json',
                'User-Agent': 'codex-cli/0.128.0',
            }
        )
        with urllib.request.urlopen(req, timeout=config.HTTP_TIMEOUT) as resp:
            usage = json.loads(resp.read().decode())
            return merge_session_rate_limits(usage), None
    except urllib.error.HTTPError as e:
        retry = None
        try:
            retry = int(e.headers.get('Retry-After', ''))
        except (ValueError, TypeError):
            pass
        return None, retry
    except Exception:
        return None, None


def _last_log_rate_limits(path):
    """Return the last rate-limit snapshot from one Codex JSONL session."""
    try:
        with open(path, 'rb') as f:
            size = f.seek(0, os.SEEK_END)
            start = max(0, size - SESSION_LOG_TAIL_BYTES)
            f.seek(start)
            data = f.read()
        if start:
            data = data.partition(b'\n')[2]
        for raw in reversed(data.splitlines()):
            if b'"rate_limits"' not in raw:
                continue
            event = json.loads(raw)
            limits_ = (event.get('payload') or {}).get('rate_limits')
            if limits_:
                return limits_
    except Exception:
        pass
    return None


def session_rate_limit_windows(sessions_root=None, now=None):
    """Collect fresh rate-limit windows reported by local Codex sessions.

    The usage endpoint can expose only the bucket for the most recently used
    model. Active Codex JSONL sessions contain rolling snapshots, so merge the
    freshest value for each duration to retain both the 5-hour and 7-day rows.
    """
    now = time.time() if now is None else now
    root = sessions_root or os.path.join(config.HOME, '.codex', 'sessions')
    paths = glob.glob(os.path.join(root, '*', '*', '*', '*.jsonl'))
    try:
        paths.sort(key=os.path.getmtime, reverse=True)
    except OSError:
        return {}
    windows = {}
    for path in paths[:10]:
        try:
            if now - os.path.getmtime(path) > SESSION_LOG_MAX_AGE:
                break
        except OSError:
            continue
        limits_ = _last_log_rate_limits(path) or {}
        for key in ('primary', 'secondary'):
            window = limits_.get(key) or {}
            minutes = window.get('window_minutes')
            if not minutes:
                continue
            seconds = int(minutes * 60)
            reset_at = window.get('resets_at')
            if reset_at is not None and reset_at <= now:
                continue
            windows.setdefault(seconds, {
                'used_percent': window.get('used_percent'),
                'reset_at': reset_at,
                'limit_window_seconds': seconds,
            })
        if FIVE_HOURS in windows and SEVEN_DAYS in windows:
            break
    return windows


def merge_session_rate_limits(usage, session_windows=None):
    """Merge missing duration buckets into an API usage payload."""
    if not usage:
        return usage
    rate_limit = usage.get('rate_limit') or {}
    by_duration = {}
    for key in ('primary_window', 'secondary_window'):
        window = rate_limit.get(key)
        if window and window.get('limit_window_seconds'):
            by_duration[window['limit_window_seconds']] = window
    if session_windows is None:
        session_windows = session_rate_limit_windows()
    for seconds, window in session_windows.items():
        by_duration.setdefault(seconds, window)

    merged = dict(usage)
    merged_limit = dict(rate_limit)
    ordered = [by_duration[x] for x in sorted(by_duration)]
    merged_limit['primary_window'] = ordered[0] if ordered else None
    merged_limit['secondary_window'] = (ordered[1]
                                                if len(ordered) > 1 else None)
    merged['rate_limit'] = merged_limit
    return merged


def _window_label(window, fallback):
    seconds = window.get('limit_window_seconds')
    if seconds == FIVE_HOURS:
        return 'CX 5h Limit'
    if seconds == SEVEN_DAYS:
        return 'CX 7d Limit'
    return fallback


def codex_usage_rows(usage, now=None):
    """Return display rows for Codex rate-limit windows."""
    if not usage:
        return []
    rate_limit = usage.get('rate_limit') or {}
    rows = []
    windows = [
        ('CX 5h Limit', rate_limit.get('primary_window')),
        ('CX 7d Limit', rate_limit.get('secondary_window')),
    ]
    for label, window in windows:
        if not window:
            continue
        pct = window.get('used_percent')
        if pct is None:
            continue
        label = _window_label(window, label)
        rows.append({
            'label': label,
            'pct': pct,
            'reset': format_epoch_reset_time(window.get('reset_at'), now=now),
            'hit': bool(pct >= 100),
            'projection': codex_limit_projection(label, window, now=now),
        })
    return rows


def _limit_meta(seconds):
    if seconds == FIVE_HOURS:
        return 'codex.five_hour', 'Session', '5h'
    if seconds == SEVEN_DAYS:
        return 'codex.seven_day', 'Weekly', '7d'
    return 'codex.other', 'Limit', ''


def limits(usage, show_dollars=False, now=None):
    """Structured Limit rows for the HTTP API's UsageBlock (§4.4.1).
    `show_dollars` is accepted for a uniform call signature with
    usage_claude.limits(); Codex has no dollar display."""
    if not usage:
        return []
    rate_limit = usage.get('rate_limit') or {}
    out = []
    for window in (rate_limit.get('primary_window'),
                   rate_limit.get('secondary_window')):
        if not window:
            continue
        pct = window.get('used_percent')
        if pct is None:
            continue
        seconds = window.get('limit_window_seconds')
        id_, label, win = _limit_meta(seconds)
        name = win or 'window'
        reset_at = window.get('reset_at')
        out.append({
            'id': id_, 'label': label, 'window': win, 'pct': pct,
            'level': usage_level(pct),
            'resets_at': int(reset_at) if reset_at else None,
            'reset_text': format_epoch_reset_time(reset_at, now=now)
            if reset_at else '',
            'projection': project_codex_limit(name, window, now=now),
        })
    return out
