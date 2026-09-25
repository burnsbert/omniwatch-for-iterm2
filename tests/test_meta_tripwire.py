"""Meta-test: every TestCase in this package derives from
tests._support.TripwireTestCase, and the tripwire actually fires
(docs/DESIGN.md §5)."""
import glob
import importlib
import inspect
import os
import subprocess
import sys
import unittest
import urllib.request
import webbrowser

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _support import TripwireError, TripwireTestCase

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
_THIS_MODULE = os.path.splitext(os.path.basename(__file__))[0]


class TestTripwireMeta(TripwireTestCase):
    def test_every_test_case_uses_tripwire(self):
        offenders = []
        for path in sorted(glob.glob(os.path.join(TESTS_DIR, 'test_*.py'))):
            mod_name = os.path.splitext(os.path.basename(path))[0]
            if mod_name == _THIS_MODULE:
                continue
            module = importlib.import_module(mod_name)
            for attr, obj in vars(module).items():
                if (inspect.isclass(obj) and issubclass(obj, unittest.TestCase)
                        and obj.__module__ == module.__name__
                        and not issubclass(obj, TripwireTestCase)):
                    offenders.append(f'{mod_name}.{attr}')
        self.assertEqual(
            offenders, [],
            f'test classes not using TripwireTestCase: {offenders}')

    def test_tripwire_blocks_subprocess_run(self):
        with self.assertRaises(TripwireError):
            subprocess.run(['true'])

    def test_tripwire_blocks_subprocess_popen(self):
        with self.assertRaises(TripwireError):
            subprocess.Popen(['true'])

    def test_tripwire_blocks_os_system(self):
        with self.assertRaises(TripwireError):
            os.system('true')

    def test_tripwire_blocks_urlopen(self):
        with self.assertRaises(TripwireError):
            urllib.request.urlopen('http://example.invalid')

    def test_tripwire_blocks_webbrowser_open(self):
        with self.assertRaises(TripwireError):
            webbrowser.open('http://example.invalid')

    def test_config_dir_redirected_to_temp_dir(self):
        from omniwatch import config
        importlib.reload(config)
        try:
            self.assertEqual(config.STATE_DIR, self.tmp_config_dir)
        finally:
            importlib.reload(config)  # don't leak the reload into other tests


if __name__ == '__main__':
    unittest.main()
