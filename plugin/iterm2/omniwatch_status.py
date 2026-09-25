#!/usr/bin/env python3
"""Omniwatch status-bar component for iTerm2 (docs/DESIGN.md §4.8, §7 WP10).

Install with `make install-plugin` (copies this file and
omniwatch_plugin_lib.py into
`~/Library/Application Support/iTerm2/Scripts/AutoLaunch/`), then enable
iTerm2 › Settings › General › Magic › "Enable Python API", and add the
"Omniwatch" component to a status bar (right-click the status bar ›
Configure Status Bar).

Shows `◉ N waiting` (hidden when N is 0), or "Omniwatch off" when there's
no live backend. Clicking it goes to the longest-waiting session, or
launches Omniwatch if it isn't running. It also pushes iTerm2 focus
changes to the backend (`POST /api/v1/plugin/focus`) so switching to a
waiting session in iTerm2 itself clears its attention immediately,
instead of waiting for the backend's own next poll.

All the actual logic lives in omniwatch_plugin_lib.py (stdlib-only, no
`iterm2` import) so it can be unit-tested without a real iTerm2; this
file is just the thin async wiring to the real `iterm2` package.

Every `iterm2` call below was verified against the *installed* package's
source via `inspect.signature`/`inspect.getsource` (not just the docs —
`tests/test_plugin_iterm2_api_parity.py` pins this down and fails loudly
if a future iterm2 version changes any of these shapes), specifically:

- `StatusBarComponent.async_register(connection, coro, timeout=None,
  onclick=None)` — the click callback kwarg is `onclick`, not
  `click_handler`, and it's a plain coroutine decorated with
  `@iterm2.RPC` (not `@iterm2.StatusBarRPC`) taking exactly one
  positional argument, `session_id` — see `RPC`'s and
  `StatusBarComponent.async_register`'s own source for exactly how it's
  invoked (`await onclick(session_id)`).
- `StatusBarRPC`-decorated coroutines take a `knobs` argument (a dict);
  that's the main status-text coroutine here.
- `FocusMonitor(connection)` / `await monitor.async_get_next_update()` ->
  `FocusUpdate`, whose `.active_session_changed` is `None` or a
  `FocusUpdateActiveSessionChanged` with a `.session_id` property.
- `iterm2.run_forever(coro)`.

I have *not* run this against a live iTerm2 (no real Connection is ever
created in tests, by design) — only every individual `iterm2` call shape
is pinned against the real package. See this task's receipt for the
manual verification the user should do once.
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import omniwatch_plugin_lib as lib  # noqa: E402

import iterm2  # noqa: E402


async def _in_thread(fn, *args, **kwargs):
    """Run a blocking (synchronous, loopback-only HTTP) call off the
    event loop so a slow/hung backend can't stall iTerm2's script host."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: fn(*args, **kwargs))


def _open_app(name):
    import subprocess
    subprocess.run(['open', '-a', name], timeout=10)


# ---- plain, undecorated coroutines (module level so they're directly
# unit-testable — see tests/test_plugin_status_script.py) --------------

async def _status_text(knobs):
    """The StatusBarRPC coroutine: iTerm2 calls this on its own
    `update_cadence` timer (docs/DESIGN.md §4.8: every 2 s)."""
    text, _summary = await _in_thread(lib.poll_once)
    return text


async def _on_click(session_id):
    """The RPC click callback iTerm2 invokes with the session_id of the
    session whose status bar was clicked (see async_register's source).
    Omniwatch's click target is always "the longest-waiting session"
    (docs/DESIGN.md §4.8), not necessarily the clicked one, so
    `session_id` isn't used to pick a target — it's accepted (as the
    real API requires) and forwarded for any future logging use."""
    await _in_thread(lib.handle_click, open_app=_open_app,
                     clicked_session_id=session_id)


async def main(connection):
    component = iterm2.StatusBarComponent(
        short_description='Omniwatch',
        detailed_description=(
            'Shows how many sessions Omniwatch thinks are waiting for '
            'you, and jumps to the next one on click.'),
        knobs=[],
        exemplar='◉ 2 waiting',
        update_cadence=lib.UPDATE_CADENCE_SECONDS,
        identifier='com.burnsbert.omniwatch.statusbar')

    status_coro = iterm2.StatusBarRPC(_status_text)
    click_coro = iterm2.RPC(_on_click)
    await component.async_register(connection, status_coro, onclick=click_coro)

    async with iterm2.FocusMonitor(connection) as monitor:
        while True:
            update = await monitor.async_get_next_update()
            changed = update.active_session_changed
            if changed is not None:
                await _in_thread(lib.handle_focus_changed, changed.session_id)


if __name__ == '__main__':
    iterm2.run_forever(main)
