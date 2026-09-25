"""Demo Providers bundle (docs/DESIGN.md §4.1, §5, §7 WP3).

``make_demo_providers()`` returns an object shaped exactly like
``omniwatch.providers.RealProviders`` (same attribute names, same method
signatures) so ``pollers.start_pollers()`` and everything upstream of it
can't tell the difference — plus a `.demo` extension
(`scenario`, `step(seconds)`) the server uses to drive deterministic
timelines for tests and screenshots.

Nothing here ever touches a real subprocess, the filesystem outside this
package's own bundled screen text, or the network; the tripwire (see
tests/_support.py) proves it.
"""
import time as _time

from omniwatch.demo import history as _history
from omniwatch.demo.scenario import SCENARIOS, build_world

__all__ = ['SCENARIOS', 'make_demo_providers']


class FakeClock:
    """Deterministic Clock: starts at `epoch` (or a real timestamp if
    None) and only moves when `advance()`/`step()` is called — it never
    sleeps for real, so nothing in a test or a screenshot run blocks on
    wall-clock time."""

    def __init__(self, epoch=None):
        self._time = epoch if epoch is not None else _time.time()
        self._monotonic = 0.0

    def time(self):
        return self._time

    def monotonic(self):
        return self._monotonic

    def sleep(self, seconds):
        pass  # instantaneous — demo mode is driven by step(), not sleep

    def advance(self, seconds):
        self._time += seconds
        self._monotonic += seconds


class _DemoControl:
    """The `.demo` extension: scripted-timeline control."""

    def __init__(self, world, clock):
        self._world = world
        self._clock = clock

    @property
    def scenario(self):
        return self._world.name

    def step(self, seconds=0.0):
        """Advance the fake clock by `seconds` and apply any scripted
        timeline events that have now come due. Deterministic and
        idempotent — calling it twice with the same total elapsed time
        (from the same starting state) always ends in the same state."""
        self._clock.advance(seconds)
        self._world.apply_timeline(self._clock.time())
        return self._clock.time()

    # ---- seed data for the engine (Engine.apply_demo_seed / apply_seed_state)

    @property
    def initial_state(self):
        """Labels and project names the StateStore starts with."""
        return _history.initial_state(self._world)

    def seed_history(self):
        """{uid: [(at, state)]} over the last 8 h (activity timeline +
        blocked-on-you stats)."""
        return _history.seed_history(self._world, self._clock.time())

    def seed_last_change(self):
        """{uid: epoch} screen-unchanged-since times (stalled sessions)."""
        return _history.seed_last_change(self._world, self._clock.time())

    def seed_usage_history(self):
        """usage-history.jsonl entries (sparklines + burn rate)."""
        return _history.seed_usage_history(self._world, self._clock.time())


class _FakeItermProvider:
    def __init__(self, world):
        self._world = world

    def snapshot(self, at=0.0):
        return self._world.snapshot(at=at)

    def paths(self, at=0.0):
        return self._world.paths(at=at)

    def goto(self, uid):
        return self._world.goto(uid)

    def close_uid(self, uid):
        return self._world.close_uid(uid)

    def new_tab(self):
        self._world.new_tab()

    def reply(self, uid, text, submit=False):
        return self._world.reply(uid, text, submit=submit)

    def probe(self):
        return self._world.probe()

    def launch(self):
        return self._world.launch()


class _FakeAgentsProvider:
    def __init__(self, world):
        self._world = world

    def scan(self):
        return self._world.agent_ttys()

    def fill_cwds(self, ttys):
        return {}  # demo sessions always carry a shell-integration path


class _FakeUsageProvider:
    def __init__(self, world, kind):
        self._world = world
        self._kind = kind

    def fetch(self):
        return self._world.usage_fetch(self._kind)


class _FakeColorsProvider:
    def __init__(self, world):
        self._world = world

    def fetch(self):
        return self._world.colors()

    def set(self, uid, name):
        return self._world.set_color(uid, name)


class _FakeOpener:
    """Records every call for assertions; never runs anything for real."""

    def __init__(self, world):
        self._world = world

    def open_url(self, url):
        self._world.opened.append(('open_url', url))

    def open_app(self, name):
        self._world.opened.append(('open_app', name))

    def reveal(self, path):
        self._world.opened.append(('reveal', path))

    def open_editor(self, argv, path):
        self._world.opened.append(('open_editor', list(argv) + [path]))

    def copy_text(self, text):
        self._world.opened.append(('copy_text', text))


class DemoProviders:
    """Same shape as omniwatch.providers.RealProviders, plus `.demo`."""

    def __init__(self, world, clock):
        self.iterm = _FakeItermProvider(world)
        self.agents = _FakeAgentsProvider(world)
        self.usage_claude = _FakeUsageProvider(world, 'claude')
        self.usage_codex = _FakeUsageProvider(world, 'codex')
        self.colors = _FakeColorsProvider(world)
        self.opener = _FakeOpener(world)
        self.clock = clock
        self.demo = _DemoControl(world, clock)


def make_demo_providers(scenario='default', seed=0, frozen_clock=None):
    """Build a fresh, deterministic DemoProviders for `scenario`.

    `seed` deterministically jitters cosmetic details (currently: usage
    reset-time offsets). `frozen_clock`, if given, is the epoch the demo
    clock starts at (`--demo-clock`); otherwise it starts at the real
    current time but still only moves via `.demo.step()`.
    """
    clock = FakeClock(frozen_clock)
    world = build_world(scenario, seed=seed, start_epoch=clock.time())
    return DemoProviders(world, clock)
