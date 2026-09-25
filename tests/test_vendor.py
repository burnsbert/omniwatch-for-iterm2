"""T027: omniwatch/vendor.py — resolving and installing the optional
vendor dir (the `iterm2` package for tab colors), and reporting whether
`iterm2` was found there or in real site-packages."""
import os
import sys
import tempfile
import unittest
import unittest.mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _support import TripwireTestCase

from omniwatch import vendor


def make_pkg(root, name='iterm2'):
    pkg = os.path.join(root, name)
    os.makedirs(pkg, exist_ok=True)
    with open(os.path.join(pkg, '__init__.py'), 'w', encoding='utf-8') as f:
        f.write('MARKER = True\n')
    return pkg


class VendorTestCase(TripwireTestCase):
    """`importlib.util.find_spec('iterm2')` returns the *cached*
    `sys.modules['iterm2'].__spec__` if 'iterm2' is already imported —
    ignoring any sys.path changes made since. Whether that's already true
    depends on test run order/whether this machine's real Python already
    has `iterm2` in site-packages and some earlier test happened to
    import it for real. So every test here pops any cached `iterm2*`
    modules first, to get a deterministic, order-independent result, and
    restores whatever was cached afterward."""

    def setUp(self):
        super().setUp()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self._orig_sys_path = list(sys.path)
        self._orig_argv0 = sys.argv[0]
        self._saved_iterm2_modules = {}
        for name in list(sys.modules):
            if name == 'iterm2' or name.startswith('iterm2.'):
                self._saved_iterm2_modules[name] = sys.modules.pop(name)

        def restore():
            sys.path[:] = self._orig_sys_path
            sys.argv[0] = self._orig_argv0
            for name in list(sys.modules):
                if name == 'iterm2' or name.startswith('iterm2.'):
                    del sys.modules[name]
            sys.modules.update(self._saved_iterm2_modules)
            sys.path_importer_cache.clear()
        self.addCleanup(restore)


class TestResolve(VendorTestCase):
    def test_env_override_wins_even_if_missing(self):
        missing = os.path.join(self.tmp.name, 'does-not-exist')
        with unittest.mock.patch.dict(os.environ, {'OMNIWATCH_VENDOR_DIR': missing}):
            path, source = vendor.resolve()
        self.assertEqual(path, missing)
        self.assertEqual(source, 'env')

    def test_zipapp_sibling_wins_when_present(self):
        os.environ.pop('OMNIWATCH_VENDOR_DIR', None)
        zipapp_dir = os.path.join(self.tmp.name, 'share')
        os.makedirs(zipapp_dir)
        os.makedirs(os.path.join(zipapp_dir, 'vendor'))
        sys.argv[0] = os.path.join(zipapp_dir, 'omniwatch.pyz')
        with unittest.mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop('OMNIWATCH_VENDOR_DIR', None)
            path, source = vendor.resolve()
        self.assertEqual(path, os.path.join(zipapp_dir, 'vendor'))
        self.assertEqual(source, 'zipapp-sibling')

    def test_falls_back_to_default_when_nothing_else_matches(self):
        os.environ.pop('OMNIWATCH_VENDOR_DIR', None)
        sys.argv[0] = os.path.join(self.tmp.name, 'nonexistent-dir', 'omniwatch.pyz')
        path, source = vendor.resolve()
        self.assertEqual(path, vendor.DEFAULT_VENDOR_DIR)
        self.assertEqual(source, 'default')

    def test_resolve_never_raises_on_a_weird_argv0(self):
        os.environ.pop('OMNIWATCH_VENDOR_DIR', None)
        sys.argv[0] = ''
        path, source = vendor.resolve()  # must not raise
        self.assertIsNotNone(path)


class TestInstall(VendorTestCase):
    def test_adds_existing_vendor_dir_to_sys_path(self):
        vd = os.path.join(self.tmp.name, 'vendor')
        os.makedirs(vd)
        with unittest.mock.patch.dict(os.environ, {'OMNIWATCH_VENDOR_DIR': vd}):
            vendor.install()
        self.assertIn(vd, sys.path)

    def test_does_not_duplicate_on_repeat_calls(self):
        vd = os.path.join(self.tmp.name, 'vendor')
        os.makedirs(vd)
        with unittest.mock.patch.dict(os.environ, {'OMNIWATCH_VENDOR_DIR': vd}):
            vendor.install()
            vendor.install()
        self.assertEqual(sys.path.count(vd), 1)

    def test_missing_vendor_dir_is_a_silent_no_op(self):
        missing = os.path.join(self.tmp.name, 'does-not-exist')
        with unittest.mock.patch.dict(os.environ, {'OMNIWATCH_VENDOR_DIR': missing}):
            vendor.install()  # must not raise
        self.assertNotIn(missing, sys.path)


class TestPackageSource(VendorTestCase):
    def test_none_when_not_importable(self):
        # This machine's real Python may (or may not) already have
        # `iterm2` in site-packages — that's an environment detail
        # outside this test's control, so stub find_spec directly rather
        # than relying on ambient absence.
        with unittest.mock.patch('importlib.util.find_spec', return_value=None):
            self.assertIsNone(vendor.package_source())

    def test_vendor_when_found_in_the_resolved_vendor_dir(self):
        vd = os.path.join(self.tmp.name, 'vendor')
        os.makedirs(vd)
        make_pkg(vd)
        sys.path.insert(0, vd)
        with unittest.mock.patch.dict(os.environ, {'OMNIWATCH_VENDOR_DIR': vd}):
            self.assertEqual(vendor.package_source(), 'vendor')

    def test_site_packages_when_found_elsewhere(self):
        elsewhere = os.path.join(self.tmp.name, 'elsewhere')
        os.makedirs(elsewhere)
        make_pkg(elsewhere)
        sys.path.insert(0, elsewhere)
        vd = os.path.join(self.tmp.name, 'vendor')  # doesn't exist, and unused
        with unittest.mock.patch.dict(os.environ, {'OMNIWATCH_VENDOR_DIR': vd}):
            self.assertEqual(vendor.package_source(), 'site-packages')


if __name__ == '__main__':
    unittest.main()
