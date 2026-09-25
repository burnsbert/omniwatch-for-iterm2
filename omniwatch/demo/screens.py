"""Realistic Claude Code / Codex / shell screen text for demo mode
(docs/DESIGN.md §4.1, §5). Loaded once at import time via
``pkgutil.get_data`` (not plain ``open()``) so these ship correctly
inside the zipapp build (§6), the same way ``server.py`` serves
``web/``.

Every screen here classifies correctly under the *real*
``omniwatch.heuristics`` rules — that's asserted by
``tests/test_demo_screens.py`` — so demo mode exercises exactly the same
classifier the real backend uses, never a shortcut.
"""
import pkgutil

_NAMES = (
    'claude_waiting_bash',
    'claude_waiting_billing',
    'claude_busy_spinner',
    'claude_busy_build',
    'claude_idle',
    'codex_approval',
    'codex_working',
    'tail_log',
    'quiet_shell',
    'plain_idle',
    'vite_dev_server',
)


def _load(name):
    data = pkgutil.get_data(__name__, f'screens/{name}.txt')
    if data is None:
        raise FileNotFoundError(f'demo screen not found: {name}')
    # Screens are authored with a trailing newline for readability; the
    # real snapshot script never returns one (AppleScript `text` doesn't
    # add one either), so strip it for parity with real screen text.
    return data.decode('utf-8').rstrip('\n')


SCREENS = {name: _load(name) for name in _NAMES}
