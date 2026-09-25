"""Shared test scaffolding (docs/DESIGN.md §5).

Rule: no test may open a window, activate an app, send Apple Events,
touch the real Keychain/network, or write outside a temp dir. This module
enforces it rather than assuming it:

- `TripwireTestCase` patches `subprocess.run`/`Popen`, `os.system`,
  `urllib.request.urlopen`, and `webbrowser.open` to raise
  `TripwireError` for the duration of each test, unless the test
  explicitly installs a fake (every ported function takes a `run=`/
  `fetch=`/`set_color=` override for exactly this reason). It also points
  `OMNIWATCH_CONFIG_DIR` at a fresh `tempfile.TemporaryDirectory` so no
  test can read or write the real `~/.config/omniwatch`.
- Every test class in this package derives from it; `test_meta_tripwire.py`
  fails the suite if one doesn't.
"""
import os
import subprocess
import tempfile
import unittest
import unittest.mock
import urllib.request
import webbrowser


class TripwireError(RuntimeError):
    """Raised when test code (or code under test) tries to shell out, hit
    the network, or open a browser/URL without an explicit fake."""


def _tripwire(name):
    def _raise(*args, **kwargs):
        raise TripwireError(
            f'{name}() called during a test without an explicit fake — '
            'see tests/_support.py')
    return _raise


class TripwireTestCase(unittest.TestCase):
    """Base class for every Omniwatch test."""

    def setUp(self):
        super().setUp()
        self._tw_tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tw_tmp.cleanup)
        env_patch = unittest.mock.patch.dict(
            os.environ, {'OMNIWATCH_CONFIG_DIR': self._tw_tmp.name})
        env_patch.start()
        self.addCleanup(env_patch.stop)

        for target, name in (
            (subprocess, 'run'),
            (subprocess, 'Popen'),
            (os, 'system'),
            (urllib.request, 'urlopen'),
            (webbrowser, 'open'),
        ):
            patcher = unittest.mock.patch.object(
                target, name, _tripwire(f'{target.__name__}.{name}'))
            patcher.start()
            self.addCleanup(patcher.stop)

    @property
    def tmp_config_dir(self):
        """The temp dir OMNIWATCH_CONFIG_DIR points at for this test."""
        return self._tw_tmp.name
