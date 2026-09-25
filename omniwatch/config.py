"""Intervals, paths, and environment overrides.

Ported from ultrawatch_lib/config.py (see docs/DESIGN.md §4.2). New for
Omniwatch: ``OMNIWATCH_CONFIG_DIR`` (overrides the whole state directory,
used by tests and demo mode), the ``OW_DEBUG_STATE``/``UW_DEBUG_STATE``
alias, ``OMNIWATCH_DEMO``, the log directory, and an optional
``config.json`` with interval/hotkey/fresh-seconds overrides (§4.6).
"""
import json
import os
import pathlib

HOME = str(pathlib.Path.home())
MY_TTY = os.ttyname(0) if os.isatty(0) else ''

# ---- state / config directory resolution -------------------------------

_XDG_CONFIG_HOME = os.environ.get('XDG_CONFIG_HOME') or os.path.join(HOME, '.config')

# ``~/.config/ultrawatch/state.json`` — read once for migration, honoring
# the same XDG rule Ultrawatch itself used. Never overridden by
# OMNIWATCH_CONFIG_DIR and never written by Omniwatch.
ULTRAWATCH_STATE_DIR = os.path.join(_XDG_CONFIG_HOME, 'ultrawatch')
ULTRAWATCH_STATE_PATH = os.path.join(ULTRAWATCH_STATE_DIR, 'state.json')

STATE_DIR = os.environ.get('OMNIWATCH_CONFIG_DIR') or os.path.join(
    _XDG_CONFIG_HOME, 'omniwatch')
STATE_PATH = os.path.join(STATE_DIR, 'state.json')
CONFIG_JSON_PATH = os.path.join(STATE_DIR, 'config.json')
RUNTIME_JSON_PATH = os.path.join(STATE_DIR, 'runtime.json')

LOG_DIR = os.environ.get('OMNIWATCH_LOG_DIR') or os.path.join(
    HOME, 'Library', 'Logs', 'Omniwatch')
BACKEND_LOG_PATH = os.path.join(LOG_DIR, 'backend.log')

DEMO = os.environ.get('OMNIWATCH_DEMO') == '1'
DEBUG_STATE = (os.environ.get('OW_DEBUG_STATE') == '1' or
               os.environ.get('UW_DEBUG_STATE') == '1')

LABEL_GC_DAYS = 14


def _load_config_json(path=None):
    """Best-effort read of the optional user config.json (§4.6). Returns
    {} on any error — a malformed override file must never crash startup."""
    try:
        with open(path or CONFIG_JSON_PATH, encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


_USER_CONFIG = _load_config_json()
_INTERVALS = _USER_CONFIG.get('intervals') if isinstance(
    _USER_CONFIG.get('intervals'), dict) else {}


def _interval(key, default):
    value = _INTERVALS.get(key)
    return value if isinstance(value, (int, float)) and value > 0 else default


# Polling cadences (seconds) — overridable via config.json's "intervals".
SNAPSHOT_INTERVAL = _interval('snapshot', 2)
PATHS_INTERVAL = _interval('paths', 10)
AGENTS_INTERVAL = _interval('agents', 5)
USAGE_REFRESH_INTERVAL = _interval('usage', 300)
CODEX_USAGE_REFRESH_INTERVAL = _interval('usage', 300)
COLOR_INTERVAL = _interval('colors', 5)

# Subprocess timeouts (seconds)
OSASCRIPT_TIMEOUT = 10
PS_TIMEOUT = 3
HTTP_TIMEOUT = 5

# GUI timing
TOAST_SECONDS = 5
FLASH_SECONDS = 1.5
FRESH_SECONDS = _USER_CONFIG.get('fresh_seconds', 30)
if not isinstance(FRESH_SECONDS, (int, float)) or FRESH_SECONDS < 0:
    FRESH_SECONDS = 30

HOTKEYS = _USER_CONFIG.get('hotkeys') if isinstance(
    _USER_CONFIG.get('hotkeys'), dict) else {}

PYTHON_OVERRIDE = _USER_CONFIG.get('python') if isinstance(
    _USER_CONFIG.get('python'), str) else None
