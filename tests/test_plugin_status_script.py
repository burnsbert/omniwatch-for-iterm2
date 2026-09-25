"""New (docs/DESIGN.md §4.8, §7 WP10): the AutoLaunch script's wiring to
the `iterm2` package, exercised against a fake `iterm2` module shaped to
match the *real* package's signatures (see
tests/test_plugin_iterm2_api_parity.py, which pins those signatures down
against the actually-installed package and would have caught T011's
`click_handler=` vs `onclick=` bug). The tripwire — and plain good sense
— forbid ever creating a real iTerm2 Connection here.
"""
import asyncio
import importlib
import inspect
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

    # Matches the real iterm2.StatusBarComponent.async_register's actual
    # signature: (self, connection, coro, timeout=None, onclick=None) —
    # see tests/test_plugin_iterm2_api_parity.py. Using `click_handler=`
    # here (T011's bug) would have made this fake accept a call shape the
    # real iTerm2 rejects, silently hiding the bug from every test in
    # this file.
    async def async_register(self, connection, coro, timeout=None, onclick=None):
        self.registered = (connection, coro, onclick)


def make_fake_iterm2():
    mod = types.ModuleType('iterm2')
    mod.StatusBarComponent = _FakeStatusBarComponent
    mod.StatusBarRPC = lambda fn: fn  # no-op decorators: identity is enough
    mod.RPC = lambda fn: fn           # to test the wiring, not iTerm2 itself
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

    def test_registers_an_onclick_handler(self):
        self.run_main_until_stop()
        _connection, _coro, onclick = _FakeStatusBarComponent.instances[0].registered
        self.assertIsNotNone(onclick)

    def test_status_coroutine_is_the_module_level_status_text_function(self):
        self.run_main_until_stop()
        _connection, coro, _onclick = _FakeStatusBarComponent.instances[0].registered
        self.assertIs(coro, self.script._status_text)

    def test_onclick_is_the_module_level_on_click_function(self):
        self.run_main_until_stop()
        _connection, _coro, onclick = _FakeStatusBarComponent.instances[0].registered
        self.assertIs(onclick, self.script._on_click)

    def test_status_coroutine_calls_poll_once(self):
        calls = []
        fake = lambda **kw: (calls.append(1), ('◉ 1 waiting', {}))[1]
        with unittest.mock.patch.object(self.script.lib, 'poll_once', fake):
            text = asyncio.run(self.script._status_text(knobs={}))
        self.assertEqual(text, '◉ 1 waiting')
        self.assertEqual(calls, [1])

    def test_on_click_takes_exactly_one_argument_session_id(self):
        # Real iTerm2 calls `await onclick(session_id)` — exactly one
        # positional argument (see async_register's source, quoted in
        # omniwatch_status.py's module docstring).
        sig = inspect.signature(self.script._on_click)
        self.assertEqual(list(sig.parameters), ['session_id'])

    def test_on_click_calls_handle_click_with_the_session_id(self):
        calls = []
        fake = lambda **kw: calls.append(kw) or 'goto UID-1'
        with unittest.mock.patch.object(self.script.lib, 'handle_click', fake):
            asyncio.run(self.script._on_click('w0t0p0:UID-1'))
        self.assertEqual(len(calls), 1)
        self.assertIn('open_app', calls[0])
        self.assertEqual(calls[0]['clicked_session_id'], 'w0t0p0:UID-1')

    def test_focus_change_calls_handle_focus_changed_with_session_id(self):
        _FakeFocusMonitor.queued_updates = [
            _FakeFocusUpdate(session_id=None),  # no active_session_changed: ignored
            _FakeFocusUpdate(session_id='w0t0p0:UID-42'),
        ]
        seen = []
        fake = lambda session_id, **kw: seen.append(session_id)
        with unittest.mock.patch.object(self.script.lib, 'handle_focus_changed', fake):
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
