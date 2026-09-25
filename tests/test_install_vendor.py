"""T027: install.sh's default (opt-out) install of the `iterm2` package
into Omniwatch's own vendor dir (never the system/Homebrew Python).

Unlike test_install_script.py's text-level checks, these tests really
execute install.sh (`--no-app` to skip the slow Swift build) — that's
the only way to prove the vendor dir actually gets populated and that
omniwatch/vendor.py's sys.path wiring actually finds a package placed
there. To do that safely under TripwireTestCase (which patches
subprocess.run/Popen so tests can't shell out or hit the network by
accident), each test calls the *real* subprocess.run — captured in
_real_run() below, before any test's setUp patches subprocess —
directly, and hands install.sh a fake `pip` (via PYTHONPATH, so `python3
-m pip install ...` finds our fake `pip` package ahead of the real one)
that never touches the network. No real pip, no real network, ever.
"""
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _support import TripwireTestCase

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INSTALL_SH = os.path.join(REPO_ROOT, 'install.sh')

# Captured before TripwireTestCase.setUp() ever runs (module import happens
# once, at collection time) — direct references to the real objects,
# unaffected by the per-test patch.object(subprocess, 'run'/'Popen', ...)
# the tripwire installs. subprocess.run() itself looks up `Popen` as a
# module global at call time, so merely capturing `subprocess.run` isn't
# enough — it would still hit the patched (raising) Popen. Hence our own
# tiny _real_run() built directly on the captured real Popen.
_REAL_POPEN = subprocess.Popen


def _real_run(args, cwd=None, env=None, timeout=None):
    proc = _REAL_POPEN(args, cwd=cwd, env=env, stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE, text=True)
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
        raise
    return subprocess.CompletedProcess(args, proc.returncode, out, err)

FAKE_PIP_MAIN = textwrap.dedent("""\
    import os
    import sys

    log = os.environ.get('FAKE_PIP_CALL_LOG')
    if log:
        with open(log, 'a', encoding='utf-8') as f:
            f.write(repr(sys.argv[1:]) + '\\n')

    if os.environ.get('FAKE_PIP_FAIL'):
        sys.stderr.write('fake pip: simulated network/pip failure\\n')
        sys.exit(1)

    args = sys.argv[1:]
    if '--target' in args:
        target = args[args.index('--target') + 1]
        pkg = os.path.join(target, 'iterm2')
        os.makedirs(pkg, exist_ok=True)
        with open(os.path.join(pkg, '__init__.py'), 'w', encoding='utf-8') as f:
            f.write('FAKE_ITERM2 = True\\n')
    sys.exit(0)
    """)


def make_fake_pip_dir(root):
    """A directory with a `pip` package that shadows the real `pip` when
    prepended to PYTHONPATH (verified: PYTHONPATH entries precede
    site-packages in sys.path for `python3 -m pip`)."""
    pip_dir = os.path.join(root, 'fakepip')
    pkg_dir = os.path.join(pip_dir, 'pip')
    os.makedirs(pkg_dir)
    with open(os.path.join(pkg_dir, '__init__.py'), 'w', encoding='utf-8'):
        pass
    with open(os.path.join(pkg_dir, '__main__.py'), 'w', encoding='utf-8') as f:
        f.write(FAKE_PIP_MAIN)
    return pip_dir


class InstallVendorTestCase(TripwireTestCase):
    """Runs install.sh for real, with a fake pip, into a throwaway prefix."""

    def setUp(self):
        super().setUp()
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        self.prefix = os.path.join(self.work.name, 'prefix')
        self.fake_pip_dir = make_fake_pip_dir(self.work.name)
        self.call_log = os.path.join(self.work.name, 'pip-calls.log')

    def run_install(self, *args, fail_pip=False, env_extra=None):
        env = dict(os.environ)
        env['PYTHONPATH'] = self.fake_pip_dir + os.pathsep + env.get('PYTHONPATH', '')
        env['FAKE_PIP_CALL_LOG'] = self.call_log
        if fail_pip:
            env['FAKE_PIP_FAIL'] = '1'
        else:
            env.pop('FAKE_PIP_FAIL', None)
        if env_extra:
            env.update(env_extra)
        return _real_run(
            [INSTALL_SH, '--prefix', self.prefix, '--no-open', '--no-app'] + list(args),
            cwd=REPO_ROOT, env=env, timeout=180)

    def doctor_report(self):
        """Runs the installed shim's `doctor --demo --json` (real subprocess,
        no network/AppleScript — --demo uses in-memory fake providers)."""
        shim = os.path.join(self.prefix, '.local', 'bin', 'omniwatch')
        env = dict(os.environ)
        env.pop('PYTHONPATH', None)  # the shim shouldn't need our fake pip
        proc = _real_run([shim, 'doctor', '--demo', '--json'],
                          cwd=REPO_ROOT, env=env, timeout=30)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return json.loads(proc.stdout)

    @property
    def vendor_dir(self):
        return os.path.join(self.prefix, '.local', 'share', 'omniwatch', 'vendor')


class TestVendorInstallSuccess(InstallVendorTestCase):
    def test_vendor_dir_populated_and_found(self):
        proc = self.run_install()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue(os.path.isfile(os.path.join(self.vendor_dir, 'iterm2', '__init__.py')))
        with open(self.call_log, encoding='utf-8') as f:
            self.assertIn('--target', f.read())
        report = self.doctor_report()
        self.assertTrue(report['iterm2_package'])
        self.assertEqual(report['iterm2_package_source'], 'vendor')

    def test_with_colors_alias_is_a_no_op_and_still_installs(self):
        proc = self.run_install('--with-colors')
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn('deprecated', (proc.stdout + proc.stderr).lower())
        self.assertTrue(os.path.isfile(os.path.join(self.vendor_dir, 'iterm2', '__init__.py')))

    def test_idempotent_vendor_dir_replaced_cleanly(self):
        proc = self.run_install()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        stray = os.path.join(self.vendor_dir, 'stale_leftover.txt')
        with open(stray, 'w', encoding='utf-8'):
            pass
        self.assertTrue(os.path.exists(stray))
        proc = self.run_install()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertFalse(os.path.exists(stray), 'second run must replace the vendor dir cleanly')
        self.assertTrue(os.path.isfile(os.path.join(self.vendor_dir, 'iterm2', '__init__.py')))

    def test_uninstall_removes_the_vendor_dir(self):
        proc = self.run_install()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue(os.path.isdir(self.vendor_dir))
        uninstall_sh = os.path.join(REPO_ROOT, 'uninstall.sh')
        proc = _real_run([uninstall_sh, '--prefix', self.prefix, '--purge'],
                          cwd=REPO_ROOT, env=dict(os.environ), timeout=30)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertFalse(os.path.exists(self.vendor_dir))


class TestVendorInstallFailure(InstallVendorTestCase):
    def test_pip_failure_warns_and_still_exits_0(self):
        proc = self.run_install(fail_pip=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn('warning', (proc.stdout + proc.stderr).lower())
        self.assertFalse(os.path.exists(self.vendor_dir))
        # Whether `iterm2` happens to already be importable from this
        # machine's real site-packages is an environment detail outside
        # this test's control; what matters is that our vendor dir was
        # never created/used.
        report = self.doctor_report()
        self.assertNotEqual(report['iterm2_package_source'], 'vendor')


class TestNoColors(InstallVendorTestCase):
    def test_no_colors_skips_vendor_install(self):
        proc = self.run_install('--no-colors')
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertFalse(os.path.exists(self.vendor_dir))
        self.assertFalse(os.path.exists(self.call_log), 'pip must never be invoked with --no-colors')
        report = self.doctor_report()
        self.assertNotEqual(report['iterm2_package_source'], 'vendor')


class TestNoBreakSystemPackagesAnywhere(TripwireTestCase):
    """Acceptance check: the literal string must not appear anywhere in the
    repo (excluding .git, node_modules, .rightsize-goal)."""

    def test_grep_is_empty(self):
        # Built at runtime (never a contiguous literal in this source file
        # or its compiled bytecode) so this test doesn't flag itself.
        needle = '-'.join(['break', 'system', 'packages'])
        offenders = []
        for root, dirs, files in os.walk(REPO_ROOT):
            dirs[:] = [d for d in dirs if d not in ('.git', 'node_modules', '.rightsize-goal')]
            for name in files:
                path = os.path.join(root, name)
                try:
                    with open(path, encoding='utf-8', errors='ignore') as f:
                        if needle in f.read():
                            offenders.append(os.path.relpath(path, REPO_ROOT))
                except (IsADirectoryError, PermissionError):
                    continue
        self.assertEqual(offenders, [])


if __name__ == '__main__':
    unittest.main()
