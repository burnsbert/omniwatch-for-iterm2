"""Shared helpers for the engine/server tests (not a test module)."""
import json
import os
import subprocess

import fake_providers as fp

from omniwatch import engine as engine_mod
from omniwatch import persist, sse


# Captured at import (before any TripwireTestCase.setUp patches it) for
# the few tests that deliberately spawn our own backend/python child —
# always with fake providers and OMNIWATCH_DEMO=1, never touching iTerm2.
REAL_POPEN = subprocess.Popen
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def child_env(**extra):
    env = dict(os.environ, PYTHONPATH=REPO, OMNIWATCH_DEMO='1',
               PYTHONUNBUFFERED='1')
    env.update(extra)
    return env


def real_run(args, timeout=30, **kwargs):
    """subprocess.run for our own child processes (see REAL_POPEN)."""
    kwargs.setdefault('stdout', subprocess.PIPE)
    kwargs.setdefault('stderr', subprocess.PIPE)
    with REAL_POPEN(args, cwd=REPO, **kwargs) as proc:
        out, err = proc.communicate(timeout=timeout)
    return proc.returncode, out, err


def decode(msg):
    """bytes SSE message -> (id, event, data) (or ('ping',) for comments)."""
    text = msg.decode('utf-8')
    if text.startswith(':'):
        return ('ping',)
    fields = {}
    for line in text.strip('\n').split('\n'):
        k, _, v = line.partition(': ')
        fields[k] = v
    return int(fields['id']), fields['event'], json.loads(fields['data'])


class RecWorker:
    """Records ItermWorker.request()/kick() calls."""

    def __init__(self):
        self.requests = []
        self.kicks = 0

    def request(self, kind, *args):
        self.requests.append((kind,) + args)

    def kick(self):
        self.kicks += 1


class RecColors(RecWorker):
    def __init__(self, available=True):
        super().__init__()
        self.available = available

    def request(self, uid, name):
        self.requests.append((uid, name))


class Harness:
    """Builds an Engine over fake providers with a subscribed hub client."""

    def __init__(self, tmpdir, providers=None, sync=False, pollers=None,
                 quota=None, **kwargs):
        self.tmpdir = tmpdir
        self.p = providers if providers is not None else fp.default_world()
        self.store = persist.StateStore(
            path=os.path.join(tmpdir, 'state.json'),
            ultrawatch_path=os.path.join(tmpdir, 'no-ultrawatch.json'))
        self.hub = sse.Hub(heartbeat=kwargs.pop('heartbeat', 15.0))
        if pollers is None and not sync:
            pollers = {'iterm': RecWorker(), 'colors': RecColors(),
                       'agents': RecWorker()}
        self.pollers = pollers
        self.quota = quota if quota is not None else engine_mod.MemoryQuota()
        kwargs.setdefault('home', '/Users/me')
        kwargs.setdefault('snapshot_interval', 2)
        kwargs.setdefault('debug_state', False)
        kwargs.setdefault('fresh_seconds', 30)
        self.engine = engine_mod.Engine(
            self.p, self.store, self.hub, pollers=pollers, quota=self.quota,
            sync=sync, **kwargs)
        self.client, _ = self.hub.subscribe()

    def poll(self, times=1):
        for _ in range(times):
            self.engine.sync_poll()
        return self.engine.pump()

    def events(self):
        out = []
        while not self.client.queue.empty():
            msg = self.client.queue.get_nowait()
            if msg is not None:
                out.append(decode(msg))
        return out

    def named(self, name):
        return [e[2] for e in self.events() if e[1] == name]

    def session(self, uid):
        for s in self.engine.state()['sessions']:
            if s['uid'] == uid:
                return s
        return None

    def set_text(self, uid, text, processing=None):
        sessions = self.p.iterm.sessions
        for i, s in enumerate(sessions):
            if s.uid == uid:
                sessions[i] = fp.session(
                    s.uid, s.tty, text, window=s.window_id, tab=s.tab_index,
                    index=s.session_index,
                    processing=s.is_processing if processing is None else processing,
                    name=s.name)
                return
        raise KeyError(uid)
