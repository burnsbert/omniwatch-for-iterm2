"""Small scriptable Providers for the engine/server/CLI tests (not a test
module itself). Nothing here touches a subprocess, the network, or the
real clock.

``make_providers(scenario=, seed=, frozen_clock=)`` has the same signature
as ``omniwatch.demo.make_demo_providers`` so the CLI's hidden
``--providers-factory tests.fake_providers:make_providers`` can use it
(the headless Swift self-test can too, via OMNIWATCH_BACKEND_ARGS).
"""
import os

from omniwatch import itermcolor
from omniwatch.iterm import ItermError, ItermNotAuthorized, ItermNotRunning
from omniwatch.snapshot import ItermSnapshot, PathsSnapshot, SessionInfo

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')
SCENARIOS = ('default', 'empty', 'not-running')


def fixture(name):
    with open(os.path.join(FIXTURES, name), encoding='utf-8') as f:
        return f.read()


CLAUDE_WAITING = fixture('claude_permission_prompt.txt')
CLAUDE_BUSY = fixture('claude_busy_spinner.txt')
CLAUDE_IDLE = fixture('claude_idle.txt')
CODEX_WAITING = fixture('codex_approval.txt')
SHELL = fixture('plain_shell.txt')

UID_WAIT = 'AAAAAAAA-0001'
UID_BUSY = 'AAAAAAAA-0002'
UID_CODEX = 'AAAAAAAA-0003'
UID_SHELL = 'AAAAAAAA-0004'


def session(uid, tty, text, window=100, tab=1, index=1, processing=False,
            name='zsh'):
    return SessionInfo(window_id=window, tab_index=tab, session_index=index,
                       uid=uid, tty=tty, is_processing=processing, name=name,
                       text=text)


class FakeClock:
    def __init__(self, t=1_790_000_000.0):
        self.t = float(t)
        self.mono = 0.0

    def time(self):
        return self.t

    def monotonic(self):
        return self.mono

    def sleep(self, seconds):
        self.advance(seconds)

    def advance(self, seconds):
        self.t += seconds
        self.mono += seconds


class FakeIterm:
    def __init__(self, sessions=(), paths=None):
        self.sessions = list(sessions)
        self.path_map = dict(paths or {})
        self.mode = 'ok'           # ok | not_running | not_authorized | error
        self.calls = []
        self.fail_actions = None   # exception to raise from actions
        self.action_result = True

    def _uids(self):
        return {s.uid for s in self.sessions}

    def snapshot(self, at=0.0):
        if self.mode == 'not_running':
            raise ItermNotRunning()
        if self.mode == 'not_authorized':
            raise ItermNotAuthorized('Not authorized to send Apple events to iTerm2. (-1743)')
        if self.mode == 'error':
            raise ItermError('osascript timed out')
        return ItermSnapshot(sessions=tuple(self.sessions), at=at)

    def paths(self, at=0.0):
        if self.mode != 'ok':
            raise ItermNotRunning()
        return PathsSnapshot(paths=tuple(sorted(self.path_map.items())), at=at)

    def _act(self, name, *args):
        self.calls.append((name,) + args)
        if self.fail_actions is not None:
            raise self.fail_actions
        return self.action_result

    def goto(self, uid):
        return self._act('goto', uid) and uid in self._uids()

    def close_uid(self, uid):
        found = uid in self._uids()
        self._act('close_uid', uid)
        self.sessions = [s for s in self.sessions if s.uid != uid]
        return found

    def new_tab(self):
        self._act('new_tab')

    def reply(self, uid, text, submit=False):
        return self._act('reply', uid, text, submit) and uid in self._uids()

    def probe(self):
        return self._act('probe')

    def launch(self):
        self._act('launch')
        self.mode = 'ok'


class FakeAgents:
    def __init__(self, ttys=None, cwds=None):
        self.ttys = dict(ttys or {})
        self.cwds = dict(cwds or {})
        self.fill_requests = []

    def scan(self):
        return {t: set(a) for t, a in self.ttys.items()}

    def fill_cwds(self, ttys):
        self.fill_requests.append(frozenset(ttys))
        return {t: self.cwds[t] for t in ttys if t in self.cwds}


class FakeUsage:
    def __init__(self, data=None, credentials=True):
        self.data = data
        self.retry_after = None
        self.credentials = credentials
        self.fetches = 0

    def fetch(self):
        self.fetches += 1
        return self.data, self.retry_after

    def has_credentials(self):
        return self.credentials


class FakeColors:
    def __init__(self, colors=None):
        self.colors = dict(colors or {})
        self.unavailable = False
        self.sets = []

    def fetch(self):
        if self.unavailable:
            raise itermcolor.ColorApiUnavailable('no iterm2 package')
        return dict(self.colors)

    def set(self, uid, name):
        if self.unavailable:
            raise itermcolor.ColorApiUnavailable('no iterm2 package')
        self.sets.append((uid, name))
        if name is None:
            self.colors.pop(uid, None)
        else:
            self.colors[uid] = name
        return True


class FakeOpener:
    def __init__(self):
        self.calls = []

    def open_url(self, url):
        self.calls.append(('open_url', url))

    def open_app(self, name):
        self.calls.append(('open_app', name))


class FakeDemo:
    """The `.demo` extension: step() advances the clock and runs any
    scheduled callbacks that came due."""

    def __init__(self, providers, scenario):
        self.providers = providers
        self.scenario = scenario
        self.timeline = []          # [(at_offset, fn)]
        self.elapsed = 0.0
        self.steps = []
        self.initial_state = None

    def step(self, seconds=0.0):
        self.steps.append(seconds)
        self.providers.clock.advance(seconds)
        self.elapsed += seconds
        due = [(t, fn) for t, fn in self.timeline if t <= self.elapsed]
        self.timeline = [(t, fn) for t, fn in self.timeline if t > self.elapsed]
        for _, fn in due:
            fn(self.providers)
        return self.providers.clock.time()


class FakeProviders:
    def __init__(self, sessions=(), paths=None, ttys=None, cwds=None,
                 colors=None, claude=None, codex=None, clock=None):
        self.clock = clock or FakeClock()
        self.iterm = FakeIterm(sessions, paths)
        self.agents = FakeAgents(ttys, cwds)
        self.usage_claude = FakeUsage(claude)
        self.usage_codex = FakeUsage(codex)
        self.colors = FakeColors(colors)
        self.opener = FakeOpener()


CLAUDE_USAGE = {
    'five_hour': {'utilization': 62.0, 'resets_at': '2026-09-21T20:00:00+00:00'},
    'seven_day': {'utilization': 31.0, 'resets_at': '2026-09-25T20:00:00+00:00'},
    'extra_usage': {'is_enabled': True, 'monthly_limit': 20000,
                    'used_credits': 18200, 'utilization': 91.0},
}
CODEX_USAGE = {'rate_limit': {
    'primary_window': {'used_percent': 40, 'limit_window_seconds': 18000,
                       'reset_at': 1_790_010_000},
    'secondary_window': {'used_percent': 84, 'limit_window_seconds': 604800,
                         'reset_at': 1_790_300_000}}}


def default_world(clock=None):
    """Two windows: a waiting Claude, a busy Claude, a waiting Codex, and a
    plain shell. Tab colors: the waiting Claude is blue (project 1)."""
    return FakeProviders(
        sessions=[
            session(UID_WAIT, '/dev/ttys001', CLAUDE_WAITING, window=100, tab=1,
                    name='✳ Refactor parser'),
            session(UID_BUSY, '/dev/ttys002', CLAUDE_BUSY, window=100, tab=2,
                    processing=True, name='⠹ Writing tests'),
            session(UID_CODEX, '/dev/ttys003', CODEX_WAITING, window=200, tab=1,
                    name='codex'),
            session(UID_SHELL, '/dev/ttys004', SHELL, window=200, tab=2),
        ],
        paths={UID_WAIT: '/Users/me/src/api', UID_BUSY: '/Users/me/src/billing',
               UID_CODEX: '/Users/me/src/site'},
        ttys={'/dev/ttys001': {'claude'}, '/dev/ttys002': {'claude'},
              '/dev/ttys003': {'codex'}},
        cwds={'/dev/ttys004': '/Users/me/src/infra'},
        colors={UID_WAIT: 'blue'},
        claude=CLAUDE_USAGE, codex=CODEX_USAGE, clock=clock)


def make_providers(scenario='default', seed=0, frozen_clock=None):
    """Factory with make_demo_providers' signature (see module docstring)."""
    if scenario not in SCENARIOS:
        raise ValueError('unknown scenario %r' % scenario)
    clock = FakeClock(frozen_clock if frozen_clock is not None else 1_790_000_000.0 + seed)
    if scenario == 'empty':
        p = FakeProviders(clock=clock)
    else:
        p = default_world(clock)
        if scenario == 'not-running':
            p.iterm.mode = 'not_running'
    p.demo = FakeDemo(p, scenario)
    if scenario == 'default':
        p.demo.initial_state = {'labels': {UID_WAIT: 'refactor'},
                                'projects': ['api', '', '', '', ''],
                                'muted': [UID_CODEX], 'prefs': {'sound': True}}

        def busy_to_waiting(prov):
            prov.iterm.sessions[1] = session(
                UID_BUSY, '/dev/ttys002', CLAUDE_WAITING, window=100, tab=2,
                name='⠹ Writing tests')
        p.demo.timeline.append((6.0, busy_to_waiting))
    return p
