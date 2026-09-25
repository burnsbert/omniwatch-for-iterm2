"""Optional iTerm2 Python API integration: reads per-session tab colors.

Ported verbatim from ultrawatch_lib/itermcolor.py (see docs/DESIGN.md
§4.2).

iTerm2's classic AppleScript dictionary (used everywhere else in this
project, see iterm.py) has no "tab color" property — confirmed against the
actual .sdef. The colored-tabs feature (right-click a tab -> Tab Color) is
only readable via iTerm2's separate Python API, which requires the user to
enable Preferences -> General -> Magic -> "Enable Python API" and to have
the optional `iterm2` pip package installed.

This module is imported unconditionally by pollers.py, but never imports
`iterm2` itself at module load time, so Omniwatch runs identically for
everyone who hasn't opted into this feature.

Preset RGB values below are iTerm2's actual defaults, taken from
sources/Infrastructure/Views/ColorsMenuItemView.m and
iTermAdvancedSettingsModel.m (tabColorMenuOptions) in the iTerm2 source. A
user who has customized that advanced setting will get an approximate
(nearest-match) label instead of an exact one.
"""
import contextlib
import os

PRESETS = (
    ('red', (251, 107, 98)),
    ('orange', (246, 172, 71)),
    ('yellow', (240, 220, 79)),
    ('green', (181, 215, 73)),
    ('blue', (95, 163, 248)),
    ('purple', (193, 142, 217)),
    ('gray', (120, 120, 120)),
)
NAME_TO_RGB = dict(PRESETS)


class ColorApiUnavailable(Exception):
    """The `iterm2` package isn't installed. Treated as permanent by the
    poller: stop trying, never surface an error to the UI."""


def classify_rgb(r, g, b):
    """Nearest of iTerm2's 7 preset tab colors to an (r, g, b) triple."""
    def dist2(rgb):
        pr, pg, pb = rgb
        return (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2
    return min(PRESETS, key=lambda p: dist2(p[1]))[0]


def uid_from_session_id(session_id):
    """iTerm2 Python API session ids are 'w0t2p0:GUID'; the GUID is what
    Omniwatch elsewhere calls a session's uid (AppleScript 'unique id')."""
    return session_id.rsplit(':', 1)[-1]


async def _async_fetch(connection):
    import iterm2
    app = await iterm2.async_get_app(connection)
    colors = {}
    for window in app.windows:
        for tab in window.tabs:
            for session in tab.sessions:
                profile = await session.async_get_profile()
                if not profile:
                    continue
                if not profile.use_tab_color:
                    continue
                color = profile.tab_color
                if not color:
                    continue
                uid = uid_from_session_id(session.session_id)
                colors[uid] = classify_rgb(color.red, color.green,
                                           color.blue)
    return colors


def _run_connected(main):
    """Runs `main(connection)` to completion over a fresh iTerm2 API
    connection, then explicitly closes the asyncio event loop.

    Deliberately builds and drives the Connection directly rather than
    the module-level iterm2.run_until_complete()/run_forever() wrappers:
    those call sys.exit(1) on a failed connection, which raises
    SystemExit — not caught by the poller's `except Exception` — and
    would kill this background thread outright, a near-guaranteed
    outcome the very first time this runs against an iTerm2 with the
    Python API disabled.

    Also explicitly closes the loop Connection.run() creates: it only
    closes a *previous* loop when the same Connection is reused, which
    we never do here (a fresh connection per poll keeps this consistent
    with every other poller in the file and avoids holding a persistent
    background connection open). Left alone, each abandoned loop is
    only closed whenever the garbage collector gets to it — at which
    point its __del__ finalizer intermittently fails tearing down an
    already-torn-down socket, printing an ignored-exception traceback
    straight to the terminal that shares stdio with the rest of the
    process.
    """
    import iterm2
    connection = iterm2.Connection()
    try:
        # A refused connection also prints a multi-paragraph
        # troubleshooting notice to stderr.
        with open(os.devnull, 'w') as devnull, \
                contextlib.redirect_stderr(devnull):
            connection.run_until_complete(main, retry=False)
    finally:
        if connection.loop is not None:
            connection.loop.close()


def fetch_colors():
    """Sync entry point for ColorsPoller. Raises ColorApiUnavailable if the
    `iterm2` package isn't installed; any other failure (API not enabled,
    iTerm2 not running) raises a normal exception the poller retries."""
    try:
        import iterm2  # noqa: F401 — import error is the availability check
    except ImportError as e:
        raise ColorApiUnavailable(str(e)) from e

    result = {}

    async def main(connection):
        result.update(await _async_fetch(connection))

    _run_connected(main)
    return result


def _tab_color_escape_bytes(r, g, b):
    """iTerm2's proprietary OSC 6 tab-color sequence, one control string per
    channel (see https://iterm2.com/documentation-escape-codes.html)."""
    parts = (f'\x1b]6;1;bg;{name};brightness;{value}\x07'
             for name, value in (('red', r), ('green', g), ('blue', b)))
    return ''.join(parts).encode()


TAB_COLOR_RESET_BYTES = b'\x1b]6;1;bg;*;default\x07'


async def _async_set_color(connection, uid, color_name):
    import iterm2
    app = await iterm2.async_get_app(connection)
    for window in app.windows:
        for tab in window.tabs:
            for session in tab.sessions:
                if uid_from_session_id(session.session_id) != uid:
                    continue
                # Written as an injected escape sequence — "as though it
                # were program output" — rather than a profile RPC write.
                # Both land in the same profile keys (traced in iTerm2's
                # source: PTYSession's UI-menu and escape-sequence tab
                # color setters both call setSessionSpecificProfileValues:
                # with KEY_TAB_COLOR/KEY_USE_TAB_COLOR), so reads are
                # unaffected either way. But only the escape-sequence path
                # explicitly forces a tab-bar repaint afterward
                # (screenSetCurrentTabColor: calls updateTabColors); the
                # profile-RPC path doesn't reliably repaint a tab that
                # already had a color showing — verified: that write does
                # land (read-back confirms the new value) yet the visible
                # tab bar can stay on the old color.
                if color_name is None:
                    data = TAB_COLOR_RESET_BYTES
                else:
                    data = _tab_color_escape_bytes(*NAME_TO_RGB[color_name])
                await session.async_inject(data)
                return True
    return False


def set_session_color(uid, color_name):
    """Sync entry point for ColorsPoller. `color_name` is one of
    PRESETS' names to set the tab color, or None to clear it (iTerm2's
    "Tab Color > None"). Same availability/failure semantics as
    fetch_colors() above."""
    try:
        import iterm2  # noqa: F401 — import error is the availability check
    except ImportError as e:
        raise ColorApiUnavailable(str(e)) from e

    result = {}

    async def main(connection):
        result['ok'] = await _async_set_color(connection, uid, color_name)

    _run_connected(main)
    return result.get('ok', False)
