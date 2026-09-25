"""T028: pins omniwatch/itermcolor.py's persistent-connection design
against the *actually installed* `iterm2` package's real signatures/
source via `inspect.signature`/`inspect.getsource` — mirrors
tests/test_plugin_iterm2_api_parity.py's approach and rationale.

`iterm2` is an optional dependency that isn't installed under every
Python this project targets (e.g. /usr/bin/python3 3.9.6 has no
site-packages for it). When it isn't importable, these tests skip
cleanly; when it *is* importable, they run for real and must pass.

No test here ever creates a real `iterm2.Connection` or does any I/O —
`inspect.signature(...).bind(...)` and source-text checks only.
"""
import inspect
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _support import TripwireTestCase

from omniwatch import itermcolor

try:
    import iterm2 as real_iterm2
    _IMPORT_ERROR = None
except ImportError as e:  # pragma: no cover - depends on the environment
    real_iterm2 = None
    _IMPORT_ERROR = e


def _skip_reason():
    return ('the real iterm2 package is not importable under %s: %s — '
           'these parity checks only run where it is (see docs/DESIGN.md '
           '§4.7 PythonLocator; e.g. not under /usr/bin/python3)'
           % (sys.executable, _IMPORT_ERROR))


@unittest.skipIf(real_iterm2 is None, _skip_reason())
class TestPersistentConnectionApiParity(TripwireTestCase):
    # ---- Connection.run(forever, coro, retry, debug=False) -------------

    def test_connection_run_accepts_our_call_shape(self):
        # _PersistentSession._connect_and_run calls
        # connection.run(True, self._on_connect, retry=False).
        sig = inspect.signature(real_iterm2.Connection.run)
        sig.bind(object(), True, object(), retry=False)

    def test_connection_run_source_matches_our_call(self):
        source = inspect.getsource(itermcolor._PersistentSession._connect_and_run)
        self.assertIn('connection.run(True, self._on_connect, retry=False)', source)

    def test_connection_has_no_run_until_complete_dependency_left(self):
        # The old (pre-T028) design used run_until_complete(); make sure
        # nothing in the new module still calls it (that method still
        # exists on the real Connection for backward compat, so this
        # would silently "work" against the old per-poll semantics
        # instead of the new persistent one if it crept back in).
        source = inspect.getsource(itermcolor)
        self.assertNotIn('run_until_complete', source)

    # ---- the sys.exit(1)-on-disconnect hazard our SystemExit catch relies on

    def test_async_connect_still_calls_sys_exit_on_a_forever_disconnect(self):
        # This is *why* _PersistentSession._run_forever catches
        # SystemExit, not just Exception, around _connect_and_run(): a
        # live disconnect while running forever propagates out of
        # async_connect's `except Exception: sys.exit(1)`. If a future
        # iterm2 version changes this, our reconnect-on-SystemExit logic
        # would need to change too — better to fail this test loudly
        # than silently stop reconnecting after a real iTerm2 restart.
        source = inspect.getsource(real_iterm2.connection.Connection.async_connect)
        self.assertIn('sys.exit(1)', source)

    # ---- iterm2.async_get_app(connection, create_if_needed=True) -------

    def test_async_get_app_accepts_our_call_shape(self):
        sig = inspect.signature(real_iterm2.async_get_app)
        sig.bind(object())

    def test_on_connect_source_matches_our_call(self):
        source = inspect.getsource(itermcolor._PersistentSession._on_connect)
        self.assertIn('await iterm2.async_get_app(connection)', source)

    # ---- App.windows / Window.tabs / Tab.sessions (walked by _async_fetch) --

    def test_app_has_windows_property(self):
        self.assertTrue(hasattr(real_iterm2.App, 'windows'))

    def test_window_has_tabs_property(self):
        self.assertTrue(hasattr(real_iterm2.Window, 'tabs'))

    def test_tab_has_sessions_property(self):
        self.assertTrue(hasattr(real_iterm2.Tab, 'sessions'))

    # ---- Session.async_get_profile() / async_inject(data) --------------

    def test_async_get_profile_takes_no_extra_args(self):
        sig = inspect.signature(real_iterm2.Session.async_get_profile)
        sig.bind(object())

    def test_async_inject_accepts_our_call_shape(self):
        sig = inspect.signature(real_iterm2.Session.async_inject)
        sig.bind(object(), b'data')

    # ---- Profile.use_tab_color / tab_color, Color.red/green/blue -------

    def test_profile_has_tab_color_fields(self):
        self.assertTrue(hasattr(real_iterm2.LocalWriteOnlyProfile, 'tab_color')
                        or hasattr(real_iterm2.Profile, 'tab_color'))


if __name__ == '__main__':
    unittest.main()
