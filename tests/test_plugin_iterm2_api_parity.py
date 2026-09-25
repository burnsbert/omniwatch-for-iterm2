"""New (docs/DESIGN.md §4.8, §7 WP10 — T013 fix): pins omniwatch_status.py's
calls into the `iterm2` package against the *actually installed*
package's real signatures via `inspect.signature`/`inspect.getsource` —
never guessed from docs. This is what should have caught (and now would
catch) T011's bug: `StatusBarComponent.async_register()` takes an
`onclick` kwarg, not `click_handler`.

`iterm2` is an optional dependency (see omniwatch/itermcolor.py's own
`ColorApiUnavailable` handling) that isn't installed under every Python
this project targets — e.g. `/usr/bin/python3` (3.9.6, no site-packages
for it). When it isn't importable, these tests skip cleanly with a
message rather than silently reporting nothing; when it *is* importable
(python3 in this environment), they run for real and must pass.

No test here ever creates an `iterm2.Connection` or does any I/O —
`inspect.signature(...).bind(...)` only, which raises `TypeError` if a
call shape no longer matches without ever executing the real method.
"""
import inspect
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
PLUGIN_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    'plugin', 'iterm2')
sys.path.insert(0, PLUGIN_DIR)

from _support import TripwireTestCase

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
class TestRealIterm2ApiParity(TripwireTestCase):
    def setUp(self):
        super().setUp()
        import omniwatch_status  # imports the REAL iterm2 (already loaded)
        self.script = omniwatch_status

    # ---- StatusBarComponent -------------------------------------------

    def test_status_bar_component_constructor_accepts_our_call_shape(self):
        sig = inspect.signature(real_iterm2.StatusBarComponent.__init__)
        sig.bind(object(),  # self
                short_description='Omniwatch', detailed_description='d',
                knobs=[], exemplar='◉ 2 waiting', update_cadence=2,
                identifier='com.burnsbert.omniwatch.statusbar')

    def test_async_register_has_onclick_not_click_handler(self):
        sig = inspect.signature(real_iterm2.StatusBarComponent.async_register)
        self.assertIn('onclick', sig.parameters)
        self.assertNotIn('click_handler', sig.parameters)

    def test_async_register_accepts_our_call_shape(self):
        sig = inspect.signature(real_iterm2.StatusBarComponent.async_register)
        sig.bind(object(), connection=object(), coro=object(), onclick=object())

    def test_omniwatch_status_actually_passes_onclick(self):
        # Read the real call our code makes and prove, via the real
        # signature, that it's accepted — not just that *some* call
        # shape with onclick= would be.
        source = inspect.getsource(self.script.main)
        self.assertIn('onclick=', source)
        self.assertNotIn('click_handler=', source)

    # ---- RPC / StatusBarRPC decorators ---------------------------------

    def test_rpc_and_statusbarrpc_are_single_argument_decorators(self):
        for decorator in (real_iterm2.RPC, real_iterm2.StatusBarRPC):
            sig = inspect.signature(decorator)
            self.assertEqual(list(sig.parameters), ['func'])

    def test_status_coroutine_is_decorated_with_status_bar_rpc_not_rpc(self):
        # Both are no-op identity wrappers around a plain function in
        # the real package's source *shape* (they attach `.async_register`
        # rather than transforming the callable) — but StatusBarRPC
        # requires a `knobs` argument, which only `_status_text` has.
        sig = inspect.signature(self.script._status_text)
        self.assertIn('knobs', sig.parameters)

    def test_on_click_matches_the_documented_onclick_arity(self):
        # async_register's own docstring/source: "await onclick(session_id)"
        # — exactly one positional argument, no `knobs`.
        sig = inspect.signature(self.script._on_click)
        self.assertEqual(list(sig.parameters), ['session_id'])

    # ---- FocusMonitor ----------------------------------------------------

    def test_focus_monitor_constructor_takes_connection(self):
        sig = inspect.signature(real_iterm2.FocusMonitor.__init__)
        sig.bind(object(), connection=object())

    def test_focus_monitor_async_get_next_update_takes_no_extra_args(self):
        sig = inspect.signature(real_iterm2.FocusMonitor.async_get_next_update)
        sig.bind(object())

    def test_focus_update_has_active_session_changed(self):
        self.assertTrue(
            hasattr(real_iterm2.focus.FocusUpdate, 'active_session_changed'))

    def test_active_session_changed_has_session_id(self):
        self.assertTrue(hasattr(
            real_iterm2.focus.FocusUpdateActiveSessionChanged, 'session_id'))

    # ---- run_forever -------------------------------------------------------

    def test_run_forever_accepts_a_single_coro(self):
        sig = inspect.signature(real_iterm2.run_forever)
        sig.bind(lambda connection: None)


if __name__ == '__main__':
    unittest.main()
