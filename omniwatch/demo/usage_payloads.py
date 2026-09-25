"""API-shaped fake usage payloads (docs/DESIGN.md §4.1, §5).

These are shaped exactly like the real ``usage_claude.fetch_usage()`` /
``usage_codex.fetch_codex_usage()`` return payloads, so they flow through
the *real* ``omniwatch.usage_claude``/``usage_codex``/``projection``
functions unchanged — demo mode never reimplements that math.

Numbers match docs/DESIGN.md §5's demo data description: Claude Session
62% / Weekly 31% / Sonnet 12% / Monthly 91% (capped, so the quota-email
prompt threshold of 90% is crossed), Codex 5h 40% / 7d 84%. Reset times
are anchored to a fixed `start_epoch` (not "now") so they count down
correctly as the demo clock advances via ``step()``, instead of always
reporting the same "N hours from now".
"""
from datetime import datetime, timedelta, timezone

FIVE_HOURS = 5 * 3600
SEVEN_DAYS = 7 * 24 * 3600


def _iso(epoch):
    return datetime.fromtimestamp(epoch, tz=timezone.utc).isoformat()


def claude_usage_payload(start_epoch, jitter=0):
    """Realistic Claude Code usage payload anchored to `start_epoch`.
    `jitter` (seconds, deterministic per demo seed) nudges reset times
    for visual variety across scenario runs without changing the
    reported percentages."""
    five_hour_reset = start_epoch + timedelta(hours=2, minutes=15).total_seconds() + jitter
    weekly_reset = start_epoch + timedelta(days=5, hours=3).total_seconds() + jitter
    return {
        'five_hour': {'utilization': 62.0, 'resets_at': _iso(five_hour_reset)},
        'seven_day': {'utilization': 31.0, 'resets_at': _iso(weekly_reset)},
        'seven_day_sonnet': {'utilization': 12.0, 'resets_at': _iso(weekly_reset)},
        'extra_usage': {
            'is_enabled': True,
            'used_credits': 27300,
            'monthly_limit': 30000,
            'utilization': 91.0,
        },
    }


def codex_usage_payload(start_epoch, jitter=0):
    """Realistic Codex usage payload anchored to `start_epoch`."""
    return {'rate_limit': {
        'primary_window': {
            'used_percent': 40.0,
            'reset_at': start_epoch + timedelta(hours=1, minutes=4).total_seconds() + jitter,
            'limit_window_seconds': FIVE_HOURS,
        },
        'secondary_window': {
            'used_percent': 84.0,
            'reset_at': start_epoch + timedelta(days=1, hours=4).total_seconds() + jitter,
            'limit_window_seconds': SEVEN_DAYS,
        },
    }}
