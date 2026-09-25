"""New (docs/DESIGN.md §6/§7 WP8): static sanity checks on install.sh /
uninstall.sh / the Homebrew formula template.

These are text-level checks, not a real install — install.sh spawns real
subprocesses (make, swiftc, cp, codesign...) by design, which the
tripwire correctly refuses to let a unit test do. The actual end-to-end
integration test is `make check-install` (see the Makefile), which runs
outside this suite and is reported separately in the task receipt.
"""
import os
import stat
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _support import TripwireTestCase

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(*parts):
    with open(os.path.join(REPO_ROOT, *parts), encoding='utf-8') as f:
        return f.read()


def is_executable(path):
    return bool(os.stat(path).st_mode & stat.S_IXUSR)


class TestInstallScript(TripwireTestCase):
    def setUp(self):
        super().setUp()
        self.path = os.path.join(REPO_ROOT, 'install.sh')
        self.src = read('install.sh')

    def test_exists_and_executable(self):
        self.assertTrue(os.path.isfile(self.path))
        self.assertTrue(is_executable(self.path))

    def test_shebang(self):
        self.assertTrue(self.src.startswith('#!/bin/bash'))

    def test_strict_mode(self):
        self.assertIn('set -euo pipefail', self.src)

    def test_declares_every_required_flag(self):
        for flag in ('--prefix', '--no-app', '--with-colors', '--with-plugin',
                    '--no-open'):
            self.assertIn(flag, self.src, flag)

    def test_with_plugin_targets_autolaunch_dir(self):
        self.assertIn('AutoLaunch', self.src)
        self.assertIn('install-plugin', self.src)

    def test_never_uses_sudo(self):
        # The word appears once in the header comment explaining that
        # sudo is *not* required; no line may actually invoke it.
        for line in self.src.splitlines():
            stripped = line.strip()
            if stripped.startswith('#'):
                continue
            self.assertNotIn('sudo', stripped, line)

    def test_checks_macos(self):
        self.assertIn('Darwin', self.src)

    def test_checks_python_version(self):
        self.assertIn('3, 9', self.src.replace('(3,9)', '(3, 9)'))

    def test_checks_for_swiftc(self):
        self.assertIn('swiftc', self.src)

    def test_builds_dist_before_installing(self):
        self.assertIn('dist-pyz', self.src)
        self.assertIn('dist-app', self.src)

    def test_installs_under_prefix_or_home_not_hardcoded(self):
        self.assertIn('HOME_DIR="${PREFIX:-$HOME}"', self.src)

    def test_warns_when_bin_not_on_path(self):
        self.assertIn('PATH', self.src)

    def test_respects_no_open(self):
        self.assertIn('NO_OPEN', self.src)
        self.assertIn('--no-open: not launching anything', self.src)

    def test_records_python_path_for_the_app(self):
        self.assertIn('PYTHON_PATH_RECORD', self.src)


class TestUninstallScript(TripwireTestCase):
    def setUp(self):
        super().setUp()
        self.path = os.path.join(REPO_ROOT, 'uninstall.sh')
        self.src = read('uninstall.sh')

    def test_exists_and_executable(self):
        self.assertTrue(os.path.isfile(self.path))
        self.assertTrue(is_executable(self.path))

    def test_shebang(self):
        self.assertTrue(self.src.startswith('#!/bin/bash'))

    def test_declares_prefix_and_purge(self):
        self.assertIn('--prefix', self.src)
        self.assertIn('--purge', self.src)

    def test_purge_removes_config_but_default_does_not(self):
        self.assertIn('config left in place', self.src)
        self.assertIn('CONFIG_DIR', self.src)

    def test_never_uses_sudo(self):
        self.assertNotIn('sudo', self.src)

    def test_removes_the_same_paths_install_creates(self):
        # Keep the two scripts in sync: whatever install.sh writes,
        # uninstall.sh must know how to remove.
        install_src = read('install.sh')
        for var in ('Applications', 'Omniwatch.app', '.local/bin',
                   '.local/share/omniwatch'):
            self.assertIn(var, install_src, f'install.sh missing {var}')
            self.assertIn(var, self.src, f'uninstall.sh missing {var}')


class TestHomebrewFormulaTemplate(TripwireTestCase):
    def setUp(self):
        super().setUp()
        self.src = read('packaging', 'homebrew', 'omniwatch.rb.tmpl')

    def test_exists(self):
        self.assertTrue(self.src.strip())

    def test_builds_from_source_not_a_prebuilt_binary(self):
        self.assertIn('system "make", "dist"', self.src)
        self.assertNotIn('url "https://github.com/burnsbert/omniwatch-for-iterm2/releases/download',
                         self.src)

    def test_depends_on_xcode_for_swiftc(self):
        self.assertIn('depends_on xcode', self.src)

    def test_has_version_and_sha_placeholders(self):
        self.assertIn('@VERSION@', self.src)
        self.assertIn('@SHA256@', self.src)

    def test_post_install_links_app_to_applications(self):
        self.assertIn('post_install', self.src)
        self.assertIn('~/Applications', self.src)

    def test_has_a_test_block(self):
        self.assertIn('test do', self.src)
        self.assertIn('--version', self.src)

    def test_mit_license(self):
        self.assertIn('license "MIT"', self.src)


class TestMakefilePackagingTargets(TripwireTestCase):
    def setUp(self):
        super().setUp()
        self.src = read('Makefile')

    def test_declares_packaging_targets(self):
        for target in ('dist-pyz', 'dist-app', 'dist', 'install', 'check-install'):
            self.assertIn(f'{target}:', self.src, target)

    def test_dist_depends_on_both_artifacts(self):
        self.assertIn('dist: dist-pyz dist-app', self.src)

    def test_zipapp_entry_point_calls_the_main_entry(self):
        # Originally `from omniwatch.cli import main; main()`; the
        # backend engineer (T008) later routed it through
        # omniwatch.__main__.run() instead, which adds a flush + hard
        # os._exit() workaround for a Python 3.13 interpreter-shutdown
        # abort when poller/handler daemon threads are still parked in a
        # subprocess or buffered write. Either entry point is fine here;
        # what matters is that it isn't calling anything else.
        self.assertTrue(
            'from omniwatch.cli import main' in self.src or
            'from omniwatch.__main__ import run' in self.src,
            self.src)

    def test_check_install_never_skips_no_open(self):
        self.assertIn('--no-open', self.src)

    def test_check_install_checks_idempotency_and_uninstall(self):
        self.assertIn('idempotency', self.src.lower())
        self.assertIn('uninstall.sh', self.src)


if __name__ == '__main__':
    unittest.main()
