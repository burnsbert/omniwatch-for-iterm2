"""New (docs/DESIGN.md §4.8, §7 WP10): the AutoLaunch script's wiring to
the `iterm2` package, exercised against a fake `iterm2` module (the
tripwire — and plain good sense — forbid a real one). This does not
prove the real iTerm2 Python API matches this shape; see the caveat in
omniwatch_status.py's module docstring and this task's receipt.
"""
import asyncio
import importlib
import os
import sys
import types
import unittest
import unittest.mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
PLUGIN_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    'plugin', 'iterm2')
sys.path.insert(0, PLUGIN_DIR)

from _support import TripwireTestCase


class _StopTest(Exception):
    """Raised by the fake FocusMonitor once its queued updates run out,
    so tests can end main()'s otherwise-infinite `while True` loop."""


class _FakeSessionChanged:
    def __init__(self, session_id):
        self.session_id = session_id


class _FakeFocusUpdate:
    def __init__(self, session_id=None):
        self.active_session_changed = (
            _FakeSessionChanged(session_id) if session_id else None)


class _FakeFocusMonitor:
    queued_updates = []  # class-level, set per-test before calling main()

    def __init__(self, connection):
        self.connection = connection

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def async_get_next_update(self):
        if not self.queued_updates:
            raise _StopTest()
        return self.queued_updates.pop(0)


class _FakeStatusBarComponent:
    instances = []  # for assertions

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.registered = None
        _FakeStatusBarComponent.instances.append(self)

    async def async_register(self, connection, coro, click_handler=None):
        self.registered = (connection, coro, click_handler)


def make_fake_iterm2():
    mod = types.ModuleType('iterm2')
    mod.StatusBarComponent = _FakeStatusBarComponent
    mod.StatusBarRPC = lambda fn: fn  # no-op decorator
    mod.FocusMonitor = _FakeFocusMonitor
    mod.run_forever = lambda main: None  # never called directly in tests
    return mod


class TestOmniwatchStatusWiring(TripwireTestCase):
    def setUp(self):
        super().setUp()
        _FakeStatusBarComponent.instances = []
        _FakeFocusMonitor.queued_updates = []
        self._iterm2_patch = unittest.mock.patch.dict(
            sys.modules, {'iterm2': make_fake_iterm2()})
        self._iterm2_patch.start()
        self.addCleanup(self._iterm2_patch.stop)
        sys.modules.pop('omniwatch_status', None)
        self.addCleanup(sys.modules.pop, 'omniwatch_status', None)
        self.script = importlib.import_module('omniwatch_status')

    def run_main_until_stop(self):
        with self.assertRaises(_StopTest):
            asyncio.run(self.script.main(connection=object()))

    def test_registers_one_status_bar_component_with_expected_metadata(self):
        self.run_main_until_stop()
        self.assertEqual(len(_FakeStatusBarComponent.instances), 1)
        kwargs = _FakeStatusBarComponent.instances[0].kwargs
        self.assertEqual(kwargs['identifier'], 'com.burnsbert.omniwatch.statusbar')
        self.assertEqual(kwargs['update_cadence'], self.script.lib.UPDATE_CADENCE_SECONDS)
        self.assertIn('Omniwatch', kwargs['short_description'])

    def test_registers_a_click_handler(self):
        self.run_main_until_stop()
        _connection, _coro, click_handler = \
            _FakeStatusBarComponent.instances[0].registered
        self.assertIsNotNone(click_handler)

    def test_status_coroutine_calls_poll_once(self):
        calls = []
        self.script.lib.poll_once = lambda **kw: (calls.append(1), ('◉ 1 waiting', {}))[1]
        self.run_main_until_stop()
        _connection, coro, _click = _FakeStatusBarComponent.instances[0].registered
        text = asyncio.run(coro(knobs={}))
        self.assertEqual(text, '◉ 1 waiting')
        self.assertEqual(calls, [1])

    def test_click_handler_calls_handle_click(self):
        calls = []
        self.script.lib.handle_click = lambda **kw: calls.append(kw) or 'goto UID-1'
        self.run_main_until_stop()
        _connection, _coro, click_handler = \
            _FakeStatusBarComponent.instances[0].registered
        asyncio.run(click_handler(knobs={}))
        self.assertEqual(len(calls), 1)
        self.assertIn('open_app', calls[0])

    def test_focus_change_calls_handle_focus_changed_with_session_id(self):
        _FakeFocusMonitor.queued_updates = [
            _FakeFocusUpdate(session_id=None),  # no active_session_changed: ignored
            _FakeFocusUpdate(session_id='w0t0p0:UID-42'),
        ]
        seen = []
        self.script.lib.handle_focus_changed = \
            lambda session_id, **kw: seen.append(session_id)
        self.run_main_until_stop()
        self.assertEqual(seen, ['w0t0p0:UID-42'])

    def test_open_app_wrapper_is_tripwired(self):
        # _open_app() shells out to `open -a <name>` for real. It's only
        # ever invoked through handle_click's injectable `open_app` hook
        # in production; calling it directly here proves the tripwire
        # would catch it if that ever changed, without actually opening
        # anything on this machine.
        from _support import TripwireError
        with self.assertRaises(TripwireError):
            self.script._open_app('Omniwatch')


if __name__ == '__main__':
    unittest.main()
