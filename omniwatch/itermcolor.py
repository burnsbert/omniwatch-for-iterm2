"""Optional iTerm2 Python API integration: reads per-session tab colors.

Ported (then re-architected — see "Persistent connection" below) from
ultrawatch_lib/itermcolor.py (see docs/DESIGN.md §4.2).

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

Persistent connection (T028): earlier versions of this module opened a
brand-new `iterm2.Connection` and called `iterm2.async_get_app()` on
*every* poll (every 5 s) — each call makes iTerm2 rebuild its entire
window/tab/session tree (`async_list_sessions`) on iTerm2's own main
thread. `_PersistentSession` below instead holds ONE long-lived
connection in a background thread; iTerm2 keeps that connection's `App`
object's window/tab/session tree current via its own push notifications
(new/terminate session, layout change — verified against the installed
package's `iterm2.app.App._async_listen`, pinned by
tests/test_itermcolor_persistent_api_parity.py), so a poll only walks the
already-current in-memory tree and fetches each session's profile (the
one RPC that has no cheaper notification-driven equivalent — tab-color
changes aren't pushed).
"""
import asyncio
import contextlib
import os
import threading
import time

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


class ColorsApiNotConnected(Exception):
    """Transient: the persistent connection isn't up (yet, or anymore).
    A plain Exception subclass — the poller's existing `except Exception:
    return` (retry next tick) already covers this like any other
    transient failure; it never needs special-casing."""


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


# ---------------------------------------------------------------------
# Persistent connection
# ---------------------------------------------------------------------

RECONNECT_BACKOFF_SECONDS = 5
READY_WAIT_SECONDS = 2          # how long a caller waits for a connection
CALL_TIMEOUT_SECONDS = 10       # how long a caller waits for one RPC round trip


class _PersistentSession:
    """Owns a single background daemon thread that holds ONE long-lived
    iTerm2 API connection, reconnecting with backoff whenever it drops.

    iTerm2's own `Connection.run(forever=True, ...)` calls `sys.exit(1)`
    from *inside* its event loop the moment the connection drops while
    running forever — verified against the installed package's
    `Connection.async_connect` source: an exception from the
    dispatch-forever read loop (`websocket.recv()` failing) is caught by
    a bare `except Exception: traceback.print_exc(); sys.exit(1)`. So the
    retry loop below explicitly catches `SystemExit`, not just
    `Exception` — otherwise a single iTerm2 restart/sleep would silently
    and permanently kill this thread, disabling tab colors until the
    whole Omniwatch backend restarts (this is exactly the hazard the
    *previous*, one-connection-per-poll design's docstring already
    called out; it applies even more here since the exposure window is
    now the whole process lifetime instead of one brief poll).
    """

    def __init__(self, backoff=RECONNECT_BACKOFF_SECONDS,
                ready_timeout=READY_WAIT_SECONDS,
                call_timeout=CALL_TIMEOUT_SECONDS):
        self.backoff = backoff
        self.ready_timeout = ready_timeout
        self.call_timeout = call_timeout
        self._lock = threading.Lock()
        self._thread = None
        self._loop = None    # the *current* connection's running loop
        self._app = None     # the *current* connection's App
        self._ready = threading.Event()
        self._stop = False

    def _ensure_started(self):
        with self._lock:
            if self._thread is None:
                self._thread = threading.Thread(
                    target=self._run_forever, name='iterm2-colors-api',
                    daemon=True)
                self._thread.start()

    def _run_forever(self):
        while not self._stop:
            self._ready.clear()
            with self._lock:
                self._loop, self._app = None, None
            try:
                self._connect_and_run()
            except SystemExit:
                pass          # disconnected while running forever — reconnect
            except Exception:
                pass          # not running / API disabled / refused — reconnect
            if self._stop:
                return
            time.sleep(self.backoff)

    def _connect_and_run(self):
        import iterm2
        connection = iterm2.Connection()
        try:
            # A refused connection prints a multi-paragraph troubleshooting
            # notice to stderr (see the module docstring for the original
            # per-poll version of this comment).
            with open(os.devnull, 'w') as devnull, \
                    contextlib.redirect_stderr(devnull):
                connection.run(True, self._on_connect, retry=False)
        finally:
            if connection.loop is not None:
                connection.loop.close()

    async def _on_connect(self, connection):
        import iterm2
        app = await iterm2.async_get_app(connection)
        with self._lock:
            self._loop = asyncio.get_running_loop()
            self._app = app
        self._ready.set()
        # Return immediately: `Connection.run`'s own `forever=True` logic
        # then awaits its dispatch-forever read loop, which is the thing
        # that actually notices a disconnect (see class docstring). If we
        # blocked here instead, a disconnect on the (separate) read-loop
        # task would just be an unretrieved task exception forever.

    def _snapshot(self):
        self._ensure_started()
        if not self._ready.wait(timeout=self.ready_timeout):
            raise ColorsApiNotConnected('not connected to iTerm2 yet')
        with self._lock:
            return self._loop, self._app

    def run_coro(self, factory):
        """`factory(app)` returns a coroutine; runs it on the persistent
        connection's loop and blocks for the result. Raises
        ColorsApiNotConnected if there's no live connection within
        `ready_timeout`; otherwise whatever `factory`'s coroutine raises,
        or its result."""
        loop, app = self._snapshot()
        fut = asyncio.run_coroutine_threadsafe(factory(app), loop)
        return fut.result(timeout=self.call_timeout)


# Module-level singleton — one persistent connection for the whole
# process, shared by fetch_colors()/set_session_color() below. Tests
# construct their own _PersistentSession() instead of using this, so
# they never share state with each other or start a real background
# connection.
_session = _PersistentSession()


async def _async_fetch(app):
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


def fetch_colors():
    """Sync entry point for ColorsPoller. Raises ColorApiUnavailable if the
    `iterm2` package isn't installed; any other failure (not connected yet,
    API not enabled, iTerm2 not running) raises a normal exception the
    poller retries."""
    try:
        import iterm2  # noqa: F401 — import error is the availability check
    except ImportError as e:
        raise ColorApiUnavailable(str(e)) from e
    return _session.run_coro(_async_fetch)


def _tab_color_escape_bytes(r, g, b):
    """iTerm2's proprietary OSC 6 tab-color sequence, one control string per
    channel (see https://iterm2.com/documentation-escape-codes.html)."""
    parts = (f'\x1b]6;1;bg;{name};brightness;{value}\x07'
             for name, value in (('red', r), ('green', g), ('blue', b)))
    return ''.join(parts).encode()


TAB_COLOR_RESET_BYTES = b'\x1b]6;1;bg;*;default\x07'


async def _async_set_color(app, uid, color_name):
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
    return _session.run_coro(lambda app: _async_set_color(app, uid, color_name))
