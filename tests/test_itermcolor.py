import os
import sys
import types
import unittest
import unittest.mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _support import TripwireTestCase

from omniwatch import itermcolor


# ---------------------------------------------------------------------
# A fake `iterm2` package (async API) so fetch_colors()/set_session_color()
# can be exercised end-to-end without the optional real package, a real
# iTerm2, or any subprocess/network call.
# ---------------------------------------------------------------------

class _FakeColor:
    def __init__(self, r, g, b):
        self.red, self.green, self.blue = r, g, b


class _FakeProfile:
    def __init__(self, use_tab_color=False, tab_color=None):
        self.use_tab_color = use_tab_color
        self.tab_color = tab_color


class _FakeSession:
    def __init__(self, session_id, profile=None):
        self.session_id = session_id
        self._profile = profile
        self.injected = []

    async def async_get_profile(self):
        return self._profile

    async def async_inject(self, data):
        self.injected.append(data)


class _FakeTab:
    def __init__(self, sessions):
        self.sessions = sessions


class _FakeWindow:
    def __init__(self, tabs):
        self.tabs = tabs


class _FakeApp:
    def __init__(self, windows):
        self.windows = windows


def make_fake_iterm2_module(app, connect_error=None):
    """A minimal fake of the `iterm2` package's async surface."""
    mod = types.ModuleType('iterm2')

    class Connection:
        def __init__(self):
            self.loop = None

        def run_until_complete(self, main, retry=False):
            import asyncio
            if connect_error is not None:
                raise connect_error
            self.loop = asyncio.new_event_loop()
            try:
                self.loop.run_until_complete(main(self))
            finally:
                pass  # itermcolor._run_connected() closes it

    async def async_get_app(connection):
        return app

    mod.Connection = Connection
    mod.async_get_app = async_get_app
    return mod


class TestClassifyRgb(TripwireTestCase):
    def test_exact_presets(self):
        self.assertEqual(itermcolor.classify_rgb(251, 107, 98), 'red')
        self.assertEqual(itermcolor.classify_rgb(246, 172, 71), 'orange')
        self.assertEqual(itermcolor.classify_rgb(240, 220, 79), 'yellow')
        self.assertEqual(itermcolor.classify_rgb(181, 215, 73), 'green')
        self.assertEqual(itermcolor.classify_rgb(95, 163, 248), 'blue')
        self.assertEqual(itermcolor.classify_rgb(193, 142, 217), 'purple')
        self.assertEqual(itermcolor.classify_rgb(120, 120, 120), 'gray')

    def test_near_miss_snaps_to_nearest(self):
        # a couple of counts off pure red still reads as red
        self.assertEqual(itermcolor.classify_rgb(248, 110, 100), 'red')

    def test_pure_black_is_nearest_to_gray(self):
        self.assertEqual(itermcolor.classify_rgb(0, 0, 0), 'gray')


class TestUidFromSessionId(TripwireTestCase):
    def test_strips_window_tab_pane_prefix(self):
        sid = 'w0t2p0:2EAAC309-9A33-4F6B-A579-E813C968DCF2'
        self.assertEqual(itermcolor.uid_from_session_id(sid),
                         '2EAAC309-9A33-4F6B-A579-E813C968DCF2')

    def test_bare_guid_passthrough(self):
        sid = '2EAAC309-9A33-4F6B-A579-E813C968DCF2'
        self.assertEqual(itermcolor.uid_from_session_id(sid), sid)


class TestFetchColorsUnavailable(TripwireTestCase):
    def test_missing_package_raises_color_api_unavailable(self):
        # `iterm2` is an optional dependency this project never requires;
        # force the ImportError path regardless of whether it happens to
        # be installed in whatever environment runs this test.
        with unittest.mock.patch.dict(sys.modules, {'iterm2': None}):
            with self.assertRaises(itermcolor.ColorApiUnavailable):
                itermcolor.fetch_colors()


class TestNameToRgb(TripwireTestCase):
    def test_has_all_seven_presets(self):
        self.assertEqual(set(itermcolor.NAME_TO_RGB),
                         {'red', 'orange', 'yellow', 'green', 'blue',
                          'purple', 'gray'})
        self.assertEqual(itermcolor.NAME_TO_RGB['red'], (251, 107, 98))


class TestSetSessionColorUnavailable(TripwireTestCase):
    def test_missing_package_raises_color_api_unavailable(self):
        with unittest.mock.patch.dict(sys.modules, {'iterm2': None}):
            with self.assertRaises(itermcolor.ColorApiUnavailable):
                itermcolor.set_session_color('UID-1', 'red')


class TestFetchColorsWithFakeApi(TripwireTestCase):
    """New: exercises the async fetch path end-to-end with a fake
    `iterm2` module — no real iTerm2, no subprocess, no network."""

    def test_collects_colors_from_sessions_with_a_tab_color(self):
        colored = _FakeSession('w0t0p0:UID-1',
                               _FakeProfile(True, _FakeColor(251, 107, 98)))
        no_color_flag = _FakeSession('w0t0p1:UID-2',
                                     _FakeProfile(False, _FakeColor(1, 2, 3)))
        no_color_value = _FakeSession('w0t0p2:UID-3', _FakeProfile(True, None))
        no_profile = _FakeSession('w0t0p3:UID-4', None)
        app = _FakeApp([_FakeWindow([_FakeTab(
            [colored, no_color_flag, no_color_value, no_profile])])])
        fake_mod = make_fake_iterm2_module(app)
        with unittest.mock.patch.dict(sys.modules, {'iterm2': fake_mod}):
            colors = itermcolor.fetch_colors()
        self.assertEqual(colors, {'UID-1': 'red'})

    def test_empty_app_returns_empty_dict(self):
        fake_mod = make_fake_iterm2_module(_FakeApp([]))
        with unittest.mock.patch.dict(sys.modules, {'iterm2': fake_mod}):
            self.assertEqual(itermcolor.fetch_colors(), {})

    def test_connection_failure_propagates_as_normal_exception(self):
        fake_mod = make_fake_iterm2_module(
            _FakeApp([]), connect_error=ConnectionRefusedError('no api'))
        with unittest.mock.patch.dict(sys.modules, {'iterm2': fake_mod}):
            with self.assertRaises(ConnectionRefusedError):
                itermcolor.fetch_colors()


class TestSetSessionColorWithFakeApi(TripwireTestCase):
    def test_sets_color_on_matching_session(self):
        session = _FakeSession('w0t0p0:UID-1', None)
        app = _FakeApp([_FakeWindow([_FakeTab([session])])])
        fake_mod = make_fake_iterm2_module(app)
        with unittest.mock.patch.dict(sys.modules, {'iterm2': fake_mod}):
            ok = itermcolor.set_session_color('UID-1', 'blue')
        self.assertTrue(ok)
        self.assertEqual(session.injected,
                         [itermcolor._tab_color_escape_bytes(95, 163, 248)])

    def test_clearing_color_sends_reset_bytes(self):
        session = _FakeSession('w0t0p0:UID-1', None)
        app = _FakeApp([_FakeWindow([_FakeTab([session])])])
        fake_mod = make_fake_iterm2_module(app)
        with unittest.mock.patch.dict(sys.modules, {'iterm2': fake_mod}):
            ok = itermcolor.set_session_color('UID-1', None)
        self.assertTrue(ok)
        self.assertEqual(session.injected, [itermcolor.TAB_COLOR_RESET_BYTES])

    def test_no_matching_session_returns_false(self):
        app = _FakeApp([_FakeWindow([_FakeTab([])])])
        fake_mod = make_fake_iterm2_module(app)
        with unittest.mock.patch.dict(sys.modules, {'iterm2': fake_mod}):
            self.assertFalse(itermcolor.set_session_color('UID-nope', 'red'))


if __name__ == '__main__':
    unittest.main()
