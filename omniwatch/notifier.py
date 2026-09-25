"""Quota-email eligibility: at most once per calendar month when monthly
Claude Code usage crosses the configured threshold.

Adapted from ultrawatch_lib/notifier.py per docs/DESIGN.md §4.2. Ultrawatch
popped a modal `osascript display dialog` and opened Gmail itself on a
background thread; Omniwatch has no dialog at all — the engine calls
`check(pct)`, emits a `quota` SSE event so the web UI can show an in-app
banner + native notification with **Draft email** / **Skip this month**,
and only `POST /api/v1/quota-email/draft` (a WP2 server route, using the
Opener provider so it's a no-op in demo/tests) actually calls `open` on
the Gmail compose URL returned by `draft_url()`. This module performs no
subprocess or network calls at all — only reads/writes the same
`~/.claude/quota-email/` files Ultrawatch used, so both projects share one
opt-in and one "already sent this month" flag.
"""
import json
import os
import time
import urllib.parse

CONFIG_PATH = os.path.expanduser('~/.claude/quota-email/config.json')
FLAG_PATH = os.path.expanduser('~/.claude/quota-email/.last-email-sent')


def _current_month():
    return time.strftime('%Y-%m')


def _already_notified():
    try:
        with open(FLAG_PATH) as f:
            return f.read().strip() == _current_month()
    except OSError:
        return False


def mark_notified():
    """Record that the quota prompt was shown this month, so it won't be
    shown again until next month regardless of the user's choice."""
    os.makedirs(os.path.dirname(FLAG_PATH), exist_ok=True)
    with open(FLAG_PATH, 'w') as f:
        f.write(_current_month())


def _load_config():
    try:
        with open(CONFIG_PATH) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def _is_enabled(cfg):
    """Email notifications are opt-in, including for legacy configs."""
    return isinstance(cfg, dict) and cfg.get('enabled') is True


def check(pct):
    """Call with the current Claude Code monthly extra_usage utilization
    percentage (0-100). Returns a QuotaPrompt dict `{"pct": pct, "to":
    email}` when the user is opted in, `pct` is at or above their
    configured threshold (default 90), and no prompt has been shown yet
    this calendar month; else None.

    Does not itself mark the month as notified — the caller (the engine)
    does that via mark_notified() once the prompt has actually been
    surfaced to the user, preserving the at-most-once-per-month rule."""
    cfg = _load_config()
    if not _is_enabled(cfg):
        return None
    threshold = cfg.get('threshold_percent', 90)
    if pct < threshold:
        return None
    if _already_notified():
        return None
    email = cfg.get('email') or {}
    return {'pct': pct, 'to': email.get('to', '')}


def draft_url(cfg=None):
    """Return the Gmail compose URL for the configured draft, or None if
    there's no usable config. Never opens anything itself — see the
    module docstring."""
    cfg = cfg if cfg is not None else _load_config()
    if not isinstance(cfg, dict):
        return None
    email = cfg.get('email')
    if not isinstance(email, dict) or not email.get('to'):
        return None
    params = urllib.parse.urlencode(
        {
            'view': 'cm',
            'to': email['to'],
            'su': email.get('subject', ''),
            'body': email.get('body', ''),
        },
        quote_via=urllib.parse.quote,
    )
    return f'https://mail.google.com/mail/?{params}'
