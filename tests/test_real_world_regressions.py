"""Regressions found by the first read-only run against a real iTerm2 and
the ship-readiness bug hunt (T022). Each test names the failure it pins."""
import json
import os
import shutil
import stat
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _support import TripwireTestCase
from _engine_harness import REAL_POPEN, REPO, Harness
import fake_providers as fp

from omniwatch import persist, usagehist
from omniwatch.snapshot import AgentSnapshot, UsageSnapshot


def agents_snapshot(providers, at):
    ttys = providers.agents.scan()
    return AgentSnapshot(ttys=tuple((t, frozenset(a)) for t, a in sorted(ttys.items())),
                         tty_cwd=(), at=at)


class TestStartupClassification(TripwireTestCase):
    """Live run: the first iTerm snapshot reached the engine before the
    first `ps` scan, so every agent session was first classified as a plain
    shell ('active') and then "transitioned" to idle/busy/waiting ~5 s
    later — 18 spurious transition events per launch, including a fake
    active→waiting that the shell turns into a native notification."""

    def test_no_transitions_when_iterm_arrives_before_agents(self):
        h = Harness(self.tmp_config_dir)
        p, e = h.p, h.engine
        e.events.put(('iterm', p.iterm.snapshot(at=p.clock.time())))
        e.pump()
        # Not classified yet: we don't know which ttys run agents.
        self.assertEqual(e.state()['iterm']['status'], 'connecting')
        self.assertEqual(e.state()['sessions'], [])
        e.events.put(('agents', agents_snapshot(p, p.clock.time())))
        e.pump()
        # The held snapshot is classified as soon as the agents arrive.
        by_uid = {s['uid']: s for s in e.state()['sessions']}
        self.assertEqual(by_uid[fp.UID_WAIT]['state'], 'waiting')
        self.assertEqual(by_uid[fp.UID_BUSY]['state'], 'busy')
        self.assertEqual(by_uid[fp.UID_SHELL]['agent'], None)
        for _ in range(3):
            p.clock.advance(2)
            e.events.put(('iterm', p.iterm.snapshot(at=p.clock.time())))
            e.pump()
        self.assertEqual(h.named('transition'), [])
        waits = e.state()['stats']
        self.assertEqual(waits['waits'], 2)   # UID_WAIT + UID_CODEX, counted once

    def test_error_snapshot_is_not_held(self):
        h = Harness(self.tmp_config_dir)
        p, e = h.p, h.engine
        p.iterm.mode = 'error'
        from omniwatch.engine import poll_iterm
        e.events.put(('iterm', poll_iterm(p, p.clock.time())))
        e.pump()
        self.assertEqual(e.state()['iterm']['status'], 'error')


class TestEngineThreadSurvives(TripwireTestCase):
    """A malformed usage payload raised inside the engine thread, which
    has no exception guard: the thread died, /health kept answering 200 (so
    the shell never restarted anything), the published state froze, and
    every later command failed."""

    def setUp(self):
        super().setUp()
        self.h = Harness(self.tmp_config_dir)
        self.h.poll()
        self.addCleanup(self.h.engine.stop)

    def wait_for(self, pred, timeout=3.0):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if pred():
                return True
            time.sleep(0.02)
        return pred()

    def test_malformed_usage_payload(self):
        e = self.h.engine
        e.start()
        good = e.state()['usage']['claude']
        self.assertEqual(good['status'], 'ok')
        e.events.put(('usage_claude', UsageSnapshot(
            data={'five_hour': 'not a dict'}, ok=True, at=self.h.p.clock.time())))
        self.assertTrue(self.wait_for(
            lambda: e.state()['usage']['claude']['status'] == 'stale'))
        self.assertTrue(e.running)
        claude = e.state()['usage']['claude']
        self.assertEqual([l['id'] for l in claude['limits']],
                         [l['id'] for l in good['limits']])   # last good data kept
        uid = e.state()['sessions'][0]['uid']
        self.assertEqual(e.set_label(uid, {'label': 'still alive'})['label'], 'still alive')

    def test_exception_while_handling_an_event(self):
        e = self.h.engine
        e.start()
        e.events.put(('paths', object()))      # .paths AttributeError
        uid = e.state()['sessions'][0]['uid']
        self.assertEqual(e.set_label(uid, {'label': 'x'})['label'], 'x')
        self.assertTrue(e.running)


class TestCorruptStateJson(TripwireTestCase):
    """Hand-edited or damaged state.json values crashed StateStore/Engine
    construction, so the backend exited before its ready line and the shell
    gave up after three restarts."""

    def store(self, data):
        path = os.path.join(self.tmp_config_dir, 'state.json')
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(data, f)
        return persist.StateStore(path=path, now=2_000_000_000,
                                  ultrawatch_path=os.path.join(self.tmp_config_dir, 'none'))

    def test_muted_not_a_dict(self):
        for bad in ([], 'x', 3, None):
            s = self.store({'muted': bad})
            self.assertFalse(s.muted('u'), bad)
            s.set_muted('u', True)
            self.assertTrue(s.muted('u'))

    def test_muted_values_normalized(self):
        s = self.store({'muted': {'a': True, 'b': 1, 'c': False, 'd': 'yes'}})
        self.assertEqual(s.state['muted'], {'a': True})

    def test_label_last_seen_not_a_number(self):
        s = self.store({'labels': {'a': {'label': 'x', 'last_seen': 'soon'},
                                   'b': {'label': 'y', 'last_seen': 1_999_999_000}}})
        self.assertEqual(s.label('a'), '')
        self.assertEqual(s.label('b'), 'y')

    def test_label_not_a_string(self):
        s = self.store({'labels': {'a': {'label': 5, 'last_seen': 1_999_999_000}}})
        self.assertEqual(s.label('a'), '')

    def test_engine_starts_with_corrupt_state(self):
        with open(os.path.join(self.tmp_config_dir, 'state.json'), 'w') as f:
            json.dump({'muted': [], 'labels': {fp.UID_WAIT: {'label': 7, 'last_seen': 'x'}}}, f)
        h = Harness(self.tmp_config_dir)
        h.poll()
        s = h.session(fp.UID_WAIT)
        self.assertFalse(s['muted'])
        self.assertEqual(s['label'], '')


class TestCorruptUsageHistory(TripwireTestCase):
    """A usage-history.jsonl with invalid UTF-8 raised UnicodeDecodeError
    out of Engine construction; a line with the right top-level shape but
    a non-list value crashed burn() on the engine thread."""

    def test_invalid_utf8_line_is_skipped(self):
        path = os.path.join(self.tmp_config_dir, 'u.jsonl')
        good = {'t': 100.0, 'p': 'claude', 'l': {'claude.five_hour': [10, None]}}
        with open(path, 'wb') as f:
            f.write(json.dumps(good).encode() + b'\n\xff\xfe\x00garbage\n')
        h = usagehist.UsageHistory(path)
        h.load(200.0)
        self.assertEqual(h.series('claude.five_hour'), [(100.0, 10, None)])

    def test_malformed_limit_values_are_skipped(self):
        path = os.path.join(self.tmp_config_dir, 'u.jsonl')
        lines = [
            {'t': 100.0, 'p': 'claude', 'l': {'claude.five_hour': 5}},
            {'t': 101.0, 'p': 'claude', 'l': {'claude.five_hour': []}},
            {'t': 102.0, 'p': 'claude', 'l': {'claude.five_hour': ['x', None]}},
            {'t': 103.0, 'p': 'claude', 'l': {'claude.five_hour': [True, None]}},
            {'t': 104.0, 'p': 'claude', 'l': {'claude.five_hour': [20, 'x']}},
            {'t': 900.0, 'p': 'claude', 'l': {'claude.five_hour': [30, None]}},
            {'t': 1800.0, 'p': 'claude', 'l': {'claude.five_hour': [40, None]}},
        ]
        with open(path, 'w', encoding='utf-8') as f:
            for line in lines:
                f.write(json.dumps(line) + '\n')
        h = usagehist.UsageHistory(path)
        h.load(2000.0)
        self.assertEqual([t for t, _, _ in h.series('claude.five_hour')], [900.0, 1800.0])
        self.assertIsNotNone(h.burn('claude.five_hour', 2000.0))
        h.view(2000.0)


def _write_exe(path, body):
    with open(path, 'w') as f:
        f.write('#!/bin/sh\n' + body + '\n')
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


class TestInstallWithoutDeveloperTools(TripwireTestCase):
    """On macOS `/usr/bin/swiftc`, `/usr/bin/make` and `/usr/bin/python3`
    always exist: they are Command Line Tools shims that pop the "install
    developer tools" dialog and fail when the tools aren't installed. So
    `command -v swiftc` never triggered the --no-app fallback, and the
    zipapp build went through `make`, which fails without the tools."""

    def test_install_succeeds_browser_only(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        fakebin = os.path.join(tmp, 'fakebin')
        os.makedirs(fakebin)
        marker = os.path.join(tmp, 'shim-called')
        # Simulate the CLT-less Mac: xcode-select finds nothing; the shims
        # record that they were run and fail.
        _write_exe(os.path.join(fakebin, 'xcode-select'),
                   'echo "xcode-select: error: unable to get active developer directory" >&2; exit 2')
        for shim in ('make', 'swiftc', 'xcrun'):
            _write_exe(os.path.join(fakebin, shim),
                       'echo "%s $*" >> "%s"; echo "xcode-select: note: No developer tools were found" >&2; exit 1'
                       % (shim, marker))
        prefix = os.path.join(tmp, 'prefix')
        # install.sh builds into <its repo>/dist: run a copy so the real
        # checkout's dist/ is never touched.
        repo = os.path.join(tmp, 'repo')
        shutil.copytree(os.path.join(REPO, 'omniwatch'), os.path.join(repo, 'omniwatch'),
                        ignore=shutil.ignore_patterns('__pycache__'))
        shutil.copy2(os.path.join(REPO, 'install.sh'), repo)
        env = dict(os.environ, PATH=fakebin + os.pathsep + os.environ.get('PATH', ''),
                   OMNIWATCH_PYTHON=sys.executable)
        with REAL_POPEN(['/bin/bash', os.path.join(repo, 'install.sh'), '--prefix', prefix,
                         '--no-open'], cwd=tmp, env=env,
                        stdout=-1, stderr=-2) as proc:
            out, _ = proc.communicate(timeout=120)
        out = out.decode('utf-8', 'replace')
        self.assertEqual(proc.returncode, 0, out)
        self.assertFalse(os.path.exists(marker),
                         'a developer-tools shim was run: %s' % (open(marker).read()
                                                                 if os.path.exists(marker) else ''))
        shim = os.path.join(prefix, '.local', 'bin', 'omniwatch')
        self.assertTrue(os.access(shim, os.X_OK), out)
        self.assertFalse(os.path.exists(os.path.join(prefix, 'Applications', 'Omniwatch.app')))
        self.assertIn('developer tools', out.lower())
        with REAL_POPEN([shim, '--version'], stdout=-1, stderr=-2, env=env) as proc:
            vout, _ = proc.communicate(timeout=30)
        self.assertEqual(proc.returncode, 0, vout)
        self.assertTrue(vout.decode().startswith('omniwatch '), vout)


if __name__ == '__main__':
    unittest.main()
