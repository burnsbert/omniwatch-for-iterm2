"""Scripted demo worlds: session layout, timeline, and action mutations
(docs/DESIGN.md §4.1, §5, §7 WP3).

Everything here is a pure function of (scenario name, seed, start_epoch)
at build time, plus explicit, idempotent mutations applied later by
``World.apply_timeline()`` (scripted, time-driven) or by an action method
(``goto``/``close_uid``/``reply``/``new_tab``/``set_color`` — user- or
test-driven). Two `World`s built with the same arguments are always in
the same state after the same sequence of ``step()``/action calls, which
is what makes ``--demo-seed``/``--demo-clock`` reproducible for tests and
screenshots.
"""
import random
from dataclasses import dataclass
from typing import Optional

from omniwatch import iterm
from omniwatch.demo.screens import SCREENS
from omniwatch.demo.usage_payloads import claude_usage_payload, codex_usage_payload
from omniwatch.snapshot import ItermSnapshot, PathsSnapshot, SessionInfo

SCENARIOS = ('default', 'empty', 'not-running', 'not-authorized', 'many',
            'usage-errors')

STATUS_OK = 'ok'
STATUS_NOT_RUNNING = 'not_running'
STATUS_NOT_AUTHORIZED = 'not_authorized'


@dataclass
class FakeSession:
    uid: str
    window_id: int
    tab_index: int
    session_index: int
    tty: str
    name: str
    screen_key: str
    path: str
    agent: Optional[str] = None          # 'claude' | 'codex' | None
    is_processing: bool = False
    label: str = ''
    tab_color: Optional[str] = None
    # What a quick-reply does to this session (see World.reply()):
    # the screen it flips to, and whether it starts "processing".
    reply_screen_key: Optional[str] = None
    reply_is_processing: bool = True

    @property
    def text(self):
        return SCREENS[self.screen_key]


@dataclass
class TimelineEvent:
    key: str            # unique id, so it's only ever applied once
    offset: float        # seconds after the world's start_epoch
    uid: str
    screen_key: str
    is_processing: bool = False


class World:
    """Mutable fake-iTerm2 state backing one demo scenario instance."""

    def __init__(self, name, sessions, timeline=(), status=STATUS_OK,
                usage_errors=False, seed=0, start_epoch=0.0):
        self.name = name
        self.status = status
        self.usage_errors = usage_errors
        self.seed = seed
        self.start_epoch = start_epoch
        self.now_epoch = start_epoch
        self._rng = random.Random(seed)
        self.usage_jitter = self._rng.uniform(-45, 45)
        self.sessions = {s.uid: s for s in sessions}
        self.order = [s.uid for s in sessions]
        self.timeline = sorted(timeline, key=lambda e: e.offset)
        self._applied = set()
        self._next_seq = 9000
        self.focused_uid = None
        self.opened = []          # (kind, arg) from Opener, for assertions

    # ---- time / timeline -------------------------------------------------

    def apply_timeline(self, now_epoch):
        self.now_epoch = now_epoch
        elapsed = now_epoch - self.start_epoch
        for ev in self.timeline:
            if ev.key in self._applied:
                continue
            if ev.offset > elapsed:
                continue
            session = self.sessions.get(ev.uid)
            if session is not None:
                session.screen_key = ev.screen_key
                session.is_processing = ev.is_processing
            self._applied.add(ev.key)

    # ---- iTerm-shaped reads -----------------------------------------------

    def _check_running(self):
        if self.status == STATUS_NOT_RUNNING:
            raise iterm.ItermNotRunning()
        if self.status == STATUS_NOT_AUTHORIZED:
            raise iterm.ItermNotAuthorized(
                'demo: Not authorized to send Apple events to iTerm2. (-1743)')

    def snapshot(self, at=0.0):
        self._check_running()
        sessions = tuple(
            SessionInfo(window_id=s.window_id, tab_index=s.tab_index,
                       session_index=s.session_index, uid=s.uid, tty=s.tty,
                       is_processing=s.is_processing, name=s.name, text=s.text)
            for s in (self.sessions[uid] for uid in self.order
                     if uid in self.sessions))
        return ItermSnapshot(sessions=sessions, at=at)

    def paths(self, at=0.0):
        self._check_running()
        pairs = tuple((uid, self.sessions[uid].path) for uid in self.order
                     if uid in self.sessions)
        return PathsSnapshot(paths=pairs, at=at)

    def probe(self):
        self._check_running()
        return True

    def launch(self):
        return None

    # ---- agents / colors / usage -----------------------------------------

    def agent_ttys(self):
        out = {}
        for uid in self.order:
            s = self.sessions.get(uid)
            if s is not None and s.agent:
                out.setdefault(s.tty, set()).add(s.agent)
        return out

    def colors(self):
        return {uid: s.tab_color for uid, s in self.sessions.items()
               if s.tab_color}

    def set_color(self, uid, name):
        s = self.sessions.get(uid)
        if s is None:
            return False
        s.tab_color = name
        return True

    def usage_fetch(self, kind):
        if self.usage_errors:
            return None, None
        if kind == 'claude':
            return claude_usage_payload(self.start_epoch, self.usage_jitter), None
        return codex_usage_payload(self.start_epoch, self.usage_jitter), None

    # ---- actions -----------------------------------------------------------

    def goto(self, uid):
        if uid not in self.sessions:
            return False
        self.focused_uid = uid
        return True

    def close_uid(self, uid):
        if uid not in self.sessions:
            return False
        del self.sessions[uid]
        self.order.remove(uid)
        return True

    def new_tab(self):
        self._next_seq += 1
        window_id = self.sessions[self.order[0]].window_id if self.order else 100
        tab_index = 1 + sum(1 for uid in self.order
                            if self.sessions[uid].window_id == window_id)
        uid = f'DEMO-NEW-{self._next_seq}'
        tty = f'/dev/ttys{self._next_seq}'
        self.sessions[uid] = FakeSession(
            uid=uid, window_id=window_id, tab_index=tab_index, session_index=1,
            tty=tty, name='zsh', screen_key='plain_idle', path='~')
        self.order.append(uid)
        return uid

    def reply(self, uid, text, submit=False):
        s = self.sessions.get(uid)
        if s is None:
            return False
        if s.reply_screen_key:
            s.screen_key = s.reply_screen_key
            s.is_processing = s.reply_is_processing
            s.reply_screen_key = None
        return True


# ---------------------------------------------------------------------
# Scenario builders
# ---------------------------------------------------------------------

def _default_sessions():
    return [
        FakeSession(uid='DEMO-0001', window_id=101, tab_index=1, session_index=1,
                   tty='/dev/ttys001', name='node', agent='claude',
                   screen_key='claude_waiting_bash', path='~/src/api-gateway',
                   label='deploy-fix', tab_color='blue',
                   reply_screen_key='claude_busy_build', reply_is_processing=True),
        FakeSession(uid='DEMO-0002', window_id=101, tab_index=2, session_index=1,
                   tty='/dev/ttys002', name='node', agent='claude',
                   screen_key='claude_busy_spinner', path='~/src/billing',
                   is_processing=True, tab_color='purple',
                   reply_screen_key='claude_waiting_billing',
                   reply_is_processing=False),
        FakeSession(uid='DEMO-0003', window_id=101, tab_index=3, session_index=1,
                   tty='/dev/ttys003', name='node', agent='codex',
                   screen_key='codex_working', path='~/src/web-app',
                   is_processing=True),
        FakeSession(uid='DEMO-0004', window_id=101, tab_index=4, session_index=1,
                   tty='/dev/ttys004', name='zsh',
                   screen_key='quiet_shell', path='~/src/infra'),
        FakeSession(uid='DEMO-0005', window_id=101, tab_index=5, session_index=1,
                   tty='/dev/ttys005', name='zsh',
                   screen_key='tail_log', path='~/src/api-gateway',
                   is_processing=True, label='nightly-log'),
        FakeSession(uid='DEMO-0006', window_id=205, tab_index=1, session_index=1,
                   tty='/dev/ttys006', name='node', agent='claude',
                   screen_key='claude_idle', path='~/src/data-pipeline'),
        FakeSession(uid='DEMO-0007', window_id=205, tab_index=2, session_index=1,
                   tty='/dev/ttys007', name='node', agent='codex',
                   screen_key='codex_approval', path='~/src/mobile-app',
                   reply_screen_key='codex_working', reply_is_processing=True),
        FakeSession(uid='DEMO-0008', window_id=205, tab_index=3, session_index=1,
                   tty='/dev/ttys008', name='node',
                   screen_key='vite_dev_server', path='~/src/tools',
                   tab_color='green'),
        FakeSession(uid='DEMO-0009', window_id=205, tab_index=4, session_index=1,
                   tty='/dev/ttys009', name='zsh',
                   screen_key='quiet_shell', path='~/src/docs-site'),
        FakeSession(uid='DEMO-0010', window_id=205, tab_index=5, session_index=1,
                   tty='/dev/ttys010', name='zsh',
                   screen_key='plain_idle', path='~'),
        FakeSession(uid='DEMO-0011', window_id=205, tab_index=6, session_index=1,
                   tty='/dev/ttys011', name='zsh',
                   screen_key='plain_idle', path='~'),
    ]


def _default_timeline():
    # "t+6s the busy Claude flips to waiting" (docs/DESIGN.md §5).
    return [
        TimelineEvent(key='billing-flips-to-waiting', offset=6.0,
                     uid='DEMO-0002', screen_key='claude_waiting_billing',
                     is_processing=False),
    ]


def _many_sessions(count=60):
    cycle = [
        ('claude', 'claude_waiting_bash', False),
        ('claude', 'claude_busy_spinner', True),
        ('claude', 'claude_idle', False),
        ('codex', 'codex_approval', False),
        ('codex', 'codex_working', True),
        (None, 'quiet_shell', False),
        (None, 'tail_log', True),
        (None, 'plain_idle', False),
    ]
    sessions = []
    per_window = 12
    for i in range(count):
        agent, screen_key, processing = cycle[i % len(cycle)]
        window_id = 300 + (i // per_window)
        tab_index = 1 + (i % per_window)
        sessions.append(FakeSession(
            uid=f'DEMO-MANY-{i:03d}', window_id=window_id, tab_index=tab_index,
            session_index=1, tty=f'/dev/ttys{200 + i}', name='node' if agent else 'zsh',
            agent=agent, screen_key=screen_key, path=f'~/src/project-{i % 7}',
            is_processing=processing))
    return sessions


def build_world(scenario, seed=0, start_epoch=0.0):
    """Build a fresh, deterministic World for `scenario`."""
    if scenario not in SCENARIOS:
        raise ValueError(f'unknown demo scenario: {scenario!r}')

    if scenario == 'default':
        return World('default', _default_sessions(), _default_timeline(),
                    seed=seed, start_epoch=start_epoch)
    if scenario == 'empty':
        return World('empty', [], seed=seed, start_epoch=start_epoch)
    if scenario == 'not-running':
        return World('not-running', [], status=STATUS_NOT_RUNNING,
                    seed=seed, start_epoch=start_epoch)
    if scenario == 'not-authorized':
        return World('not-authorized', [], status=STATUS_NOT_AUTHORIZED,
                    seed=seed, start_epoch=start_epoch)
    if scenario == 'many':
        return World('many', _many_sessions(), seed=seed, start_epoch=start_epoch)
    if scenario == 'usage-errors':
        # Keep at least one Claude and one Codex agent running so the
        # real UsagePoller gate is "active" and actually calls fetch()
        # (which fails), rather than gating to "inactive" for lack of
        # any matching agent.
        sessions = [
            FakeSession(uid='DEMO-ERR-1', window_id=401, tab_index=1,
                       session_index=1, tty='/dev/ttys301', name='node',
                       agent='claude', screen_key='claude_idle',
                       path='~/src/api-gateway'),
            FakeSession(uid='DEMO-ERR-2', window_id=401, tab_index=2,
                       session_index=1, tty='/dev/ttys302', name='node',
                       agent='codex', screen_key='codex_working',
                       path='~/src/web-app', is_processing=True),
        ]
        return World('usage-errors', sessions, usage_errors=True,
                    seed=seed, start_epoch=start_epoch)
    raise AssertionError('unreachable')  # SCENARIOS check above covers this
