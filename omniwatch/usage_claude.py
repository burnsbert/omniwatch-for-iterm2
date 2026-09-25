"""Claude Code usage-limit fetching and display rows.

Fetch is unchanged from ultrawatch_lib/usage_claude.py. ``claude_extra_usage_row``
stays as a thin wrapper (used by the ported test suite); ``limits()`` is
new for Omniwatch (docs/DESIGN.md §4.2, §4.4.1) and returns the structured
rows the HTTP API and web UI consume.
"""
import json
import subprocess
import urllib.error
import urllib.request

from omniwatch import config
from omniwatch.projection import (project_limit, project_monthly_limit,
                                  monthly_limit_projection, usage_level)
from omniwatch.timefmt import (format_reset_delta, format_reset_time,
                               next_month_start, parse_iso)

# key -> (id, display label, window label) for the rolling-window limits.
_LIMIT_META = {
    'five_hour': ('claude.five_hour', 'Session', '5h'),
    'seven_day': ('claude.seven_day', 'Weekly', '7d'),
    'seven_day_sonnet': ('claude.seven_day_sonnet', 'Sonnet', '7d'),
}


def get_oauth_token():
    """Retrieve Claude Code OAuth token from macOS Keychain."""
    try:
        result = subprocess.run(
            ['security', 'find-generic-password',
             '-s', 'Claude Code-credentials', '-w'],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode != 0:
            return None
        creds = json.loads(result.stdout.strip())
        return creds.get('claudeAiOauth', {}).get('accessToken')
    except Exception:
        return None


def fetch_usage():
    """Fetch usage data from the Claude Code API. Returns (dict, retry_after) or (None, retry_after).

    retry_after is seconds to wait before retrying (from Retry-After header), or None.
    """
    token = get_oauth_token()
    if not token:
        return None, None
    try:
        req = urllib.request.Request(
            'https://api.anthropic.com/api/oauth/usage',
            method='GET',
            headers={
                'Authorization': f'Bearer {token}',
                'anthropic-beta': 'oauth-2025-04-20',
                'Content-Type': 'application/json',
                'User-Agent': 'claude-code/2.1.69',
            }
        )
        with urllib.request.urlopen(req, timeout=config.HTTP_TIMEOUT) as resp:
            return json.loads(resp.read().decode()), None
    except urllib.error.HTTPError as e:
        retry = None
        try:
            retry = int(e.headers.get('Retry-After', ''))
        except (ValueError, TypeError):
            pass
        return None, retry
    except Exception:
        return None, None


def format_dollar_limit(value):
    """Format Claude Code credit units as dollars."""
    try:
        amount = float(value) / 100
    except (TypeError, ValueError):
        return ''
    if amount.is_integer():
        return f'${amount:,.0f}'
    return f'${amount:,.2f}'


def claude_extra_usage_row(usage, show_dollar_limit=False, now=None):
    """Return display row for Claude Code extra/monthly usage limits."""
    if not usage:
        return None
    extra = usage.get('extra_usage')
    if not isinstance(extra, dict) or not extra.get('is_enabled'):
        return None

    used = extra.get('used_credits')
    limit = extra.get('monthly_limit')
    pct = extra.get('utilization')
    try:
        if pct is None and limit:
            pct = (float(used or 0) / float(limit)) * 100
    except (TypeError, ValueError, ZeroDivisionError):
        pct = None
    pct = pct if pct is not None else 0

    if limit:
        label = 'CC Monthly Limit'
        details = []
        if show_dollar_limit:
            dollar_limit = format_dollar_limit(limit)
            if dollar_limit:
                details.append(f'limit {dollar_limit}')
        reset = format_reset_delta(next_month_start(now), now=now)
        if reset:
            details.append(f'resets in {reset}')
        detail = f'  {", ".join(details)}' if details else ''
    else:
        label = 'CC Extra Usage '
        detail = ''

    return {
        'label': label,
        'pct': pct,
        'detail': detail,
        'hit': bool(limit and pct >= 100),
        'projection': monthly_limit_projection(pct, bool(limit), now=now),
    }


def limits(usage, show_dollars=False, now=None):
    """Structured Limit rows for the HTTP API's UsageBlock (§4.4.1).

    `now`, when given, should be a tz-aware UTC datetime; it is converted
    to local time where the underlying math needs a wall-clock date
    (the monthly cap). Returns [] for falsy `usage`.
    """
    if not usage:
        return []
    # Naive local time: next_month_start() and project_monthly_limit()
    # build naive datetimes, and mixing aware/naive raises (swallowed as
    # an empty reset_text / missing projection).
    local_now = now.astimezone().replace(tzinfo=None) if now is not None else None
    out = []
    for key, (id_, label, window) in _LIMIT_META.items():
        bucket = usage.get(key)
        if not bucket:
            continue
        pct = bucket.get('utilization') or 0
        resets_at = bucket.get('resets_at')
        reset_epoch = None
        reset_text = ''
        if resets_at:
            reset_text = format_reset_time(resets_at, now=now)
            try:
                reset_epoch = int(parse_iso(resets_at).timestamp())
            except Exception:
                reset_epoch = None
        out.append({
            'id': id_, 'label': label, 'window': window, 'pct': pct,
            'level': usage_level(pct), 'resets_at': reset_epoch,
            'reset_text': reset_text,
            'projection': project_limit(key, bucket, now=now),
        })

    extra = usage.get('extra_usage')
    if isinstance(extra, dict) and extra.get('is_enabled'):
        used = extra.get('used_credits')
        limit = extra.get('monthly_limit')
        pct = extra.get('utilization')
        try:
            if pct is None and limit:
                pct = (float(used or 0) / float(limit)) * 100
        except (TypeError, ValueError, ZeroDivisionError):
            pct = None
        pct = pct if pct is not None else 0
        has_cap = bool(limit)
        month_start = next_month_start(local_now)
        out.append({
            'id': 'claude.monthly',
            'label': 'Monthly cap' if has_cap else 'Extra usage',
            'window': 'month', 'pct': pct, 'level': usage_level(pct),
            'resets_at': int(month_start.timestamp()),
            'reset_text': format_reset_delta(month_start, now=local_now),
            'has_cap': has_cap,
            'limit_display': (format_dollar_limit(limit)
                              if (show_dollars and has_cap) else None),
            'projection': project_monthly_limit(pct, has_cap, now=local_now),
        })
    return out
