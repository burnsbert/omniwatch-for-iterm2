"""Background pollers: all subprocess and network work happens here.

Ported (near-verbatim) from ultrawatch_lib/pollers.py per docs/DESIGN.md
§4.2/§5: every poller now takes a `providers` object (RealProviders in
production; a fake in tests/demo) instead of importing iterm/agents/
itermcolor/usage_* directly, and `ItermWorker` gains the `reply`,
`close_uid`, and `probe` actions. Pollers build immutable snapshot
objects and post ('kind', snapshot) tuples onto a single queue.Queue
consumed by the engine thread. The lone exception to queue-only flow is
LatestBox, a one-slot store the usage pollers read to gate on agent
presence.

`ColorsPoller` and `UsagePoller` keep their original `fetch=`/`set_color=`
override kwargs (defaulting from `providers` when given) so the ported
Ultrawatch tests, which construct them with bare fake callables, keep
passing unchanged.

All osascript work — polls and actions — serializes on the single
ItermWorker so iTerm2 never receives concurrent Apple Events.

Logging (T028): every failed poll/action and every slow (>2 s) poll is
logged to the backend log (see logs.py) so a user-reported "iTerm2 query
failed" has something in backend.log to point at — previously nothing
was logged anywhere. `_should_log_failure()` rate-limits: the first few
consecutive failures always log, then only every 10th, so a long outage
(or a permanently-denied Automation prompt, which fails every single
poll forever) doesn't flood the log.
"""
import logging
import queue
import threading
import time

from omniwatch import config, itermcolor
from omniwatch.iterm import ItermNotAuthorized, ItermNotRunning
from omniwatch.snapshot import AgentSnapshot, ColorsSnapshot, ItermSnapshot, UsageSnapshot

log = logging.getLogger('omniwatch.pollers')


def _should_log_failure(consecutive_failures):
    """True for each of the first 3 consecutive failures, then only every
    10th (so a stuck/denied poller logs roughly once per ~20 s at the
    default 2 s snapshot interval, not on every single poll)."""
    return consecutive_failures <= 3 or consecutive_failures % 10 == 0


class LatestBox:
    """One-slot thread-safe holder for the latest value."""

    def __init__(self):
        self._value = None
        self._lock = threading.Lock()

    def set(self, value):
        with self._lock:
            self._value = value

    def get(self):
        with self._lock:
            return self._value


class ItermWorker(threading.Thread):
    """Owns every osascript call. Polls snapshots/paths on a cadence and
    drains an action queue between polls; actions trigger an immediate
    re-poll so the engine confirms results fast."""

    def __init__(self, events, stop, providers,
                 snapshot_interval=config.SNAPSHOT_INTERVAL,
                 paths_interval=config.PATHS_INTERVAL):
        super().__init__(name='iterm', daemon=True)
        self.events = events
        self.stop_evt = stop
        self.providers = providers
        self.snapshot_interval = snapshot_interval
        self.paths_interval = paths_interval
        self.actions = queue.Queue()
        self._snapshot_fail_count = 0
        self._paths_fail_count = 0

    def request(self, kind, *args):
        self.actions.put((kind, args))

    def kick(self):
        self.actions.put(('poll', ()))

    def run(self):
        last_paths = 0.0
        while not self.stop_evt.is_set():
            t0 = time.monotonic()
            self._poll_snapshot()
            if time.monotonic() - last_paths >= self.paths_interval:
                self._poll_paths()
                last_paths = time.monotonic()
            elapsed = time.monotonic() - t0
            # adaptive: a slow Mac or 50-session setup degrades cadence
            # instead of saturating the worker
            deadline = time.monotonic() + max(self.snapshot_interval,
                                              2 * elapsed)
            while not self.stop_evt.is_set():
                timeout = deadline - time.monotonic()
                if timeout <= 0:
                    break
                try:
                    kind, args = self.actions.get(timeout=timeout)
                except queue.Empty:
                    break
                if kind == 'poll':
                    break
                self._do_action(kind, args)
                break  # re-poll immediately after any action

    def _poll_snapshot(self):
        now = time.time()
        t0 = time.monotonic()
        try:
            snap = self.providers.iterm.snapshot(at=now)
        except ItermNotRunning:
            # Expected/steady state (iTerm2 just isn't open) — not a
            # failure worth logging.
            self._snapshot_fail_count = 0
            snap = ItermSnapshot(not_running=True, at=now)
        except ItermNotAuthorized as e:
            # ItermSnapshot has no dedicated field for this (verbatim
            # dataclass, §4.2) — the engine (WP2) maps this prefix to
            # iterm.status == 'not_authorized' (§2.9).
            self._snapshot_fail_count += 1
            if _should_log_failure(self._snapshot_fail_count):
                log.warning('iTerm2 snapshot poll not authorized (attempt %d, %.2fs): %s',
                           self._snapshot_fail_count, time.monotonic() - t0, e)
            snap = ItermSnapshot(
                error='not_authorized: ' + (str(e) or 'Not authorized'),
                at=now)
        except Exception as e:
            self._snapshot_fail_count += 1
            if _should_log_failure(self._snapshot_fail_count):
                log.warning('iTerm2 snapshot poll failed (attempt %d, %.2fs): %s',
                           self._snapshot_fail_count, time.monotonic() - t0, e)
            snap = ItermSnapshot(error=str(e) or type(e).__name__, at=now)
        else:
            dur = time.monotonic() - t0
            if self._snapshot_fail_count:
                log.info('iTerm2 snapshot poll recovered after %d failed attempt(s)',
                        self._snapshot_fail_count)
            self._snapshot_fail_count = 0
            if dur > config.SLOW_POLL_SECONDS:
                log.info('slow iTerm2 snapshot poll: %.2fs for %d session(s)',
                        dur, len(snap.sessions))
        self.events.put(('iterm', snap))

    def _poll_paths(self):
        t0 = time.monotonic()
        try:
            paths_snap = self.providers.iterm.paths(at=time.time())
        except Exception as e:
            self._paths_fail_count += 1
            if _should_log_failure(self._paths_fail_count):
                log.warning('iTerm2 paths poll failed (attempt %d, %.2fs): %s',
                           self._paths_fail_count, time.monotonic() - t0, e)
            return  # engine keeps the last paths snapshot
        dur = time.monotonic() - t0
        if self._paths_fail_count:
            log.info('iTerm2 paths poll recovered after %d failed attempt(s)',
                    self._paths_fail_count)
        self._paths_fail_count = 0
        if dur > config.SLOW_POLL_SECONDS:
            log.info('slow iTerm2 paths poll: %.2fs for %d path(s)',
                    dur, len(paths_snap.paths))
        self.events.put(('paths', paths_snap))

    def _do_action(self, kind, args):
        ok, detail = True, ''
        t0 = time.monotonic()
        try:
            if kind == 'goto':
                ok = self.providers.iterm.goto(args[0])
                if not ok:
                    detail = 'session not found'
            elif kind == 'close_uid':
                ok = self.providers.iterm.close_uid(args[0])
                if not ok:
                    detail = 'session not found'
            elif kind == 'new':
                self.providers.iterm.new_tab()
            elif kind == 'reply':
                uid, text, submit = args
                ok = self.providers.iterm.reply(uid, text, submit=submit)
                if not ok:
                    detail = 'session not found'
            elif kind == 'probe':
                self.providers.iterm.probe()
        except Exception as e:
            ok, detail = False, str(e) or type(e).__name__
        if not ok:
            # Actions are rare/user-triggered (not a continuous poll), so
            # every failure is logged — no rate limiting needed.
            log.warning('iTerm2 action %r failed (%.2fs): %s',
                       kind, time.monotonic() - t0, detail)
        self.events.put(('action', (kind, ok, detail)))


class AgentsPoller(threading.Thread):
    """ps scan for agent ttys + lsof cwd fill for ttys the engine flagged
    as missing a working directory."""

    def __init__(self, events, stop, needs_cwd_box, agents_box,
                 providers=None, interval=config.AGENTS_INTERVAL,
                 scan=None, fill=None):
        super().__init__(name='agents', daemon=True)
        self.events = events
        self.stop_evt = stop
        self.needs_cwd_box = needs_cwd_box
        self.agents_box = agents_box
        self.interval = interval
        if scan is None:
            scan = providers.agents.scan if providers else _default_agents_scan()
        if fill is None:
            fill = providers.agents.fill_cwds if providers else _default_agents_fill()
        self.scan = scan
        self.fill = fill
        self.kick_evt = threading.Event()

    def kick(self):
        self.kick_evt.set()

    def run(self):
        while not self.stop_evt.is_set():
            self.poll()
            self.kick_evt.wait(self.interval)
            self.kick_evt.clear()

    def poll(self):
        try:
            ttys = self.scan()
        except Exception:
            ttys = {}
        needs = self.needs_cwd_box.get() or ()
        cwds = {}
        if needs:
            try:
                cwds = self.fill(needs)
            except Exception:
                cwds = {}
        snap = AgentSnapshot(
            ttys=tuple((t, frozenset(a)) for t, a in sorted(ttys.items())),
            tty_cwd=tuple(sorted(cwds.items())),
            at=time.time())
        self.agents_box.set(snap)
        self.events.put(('agents', snap))


def _default_agents_scan():
    from omniwatch import agents as agents_mod
    return agents_mod.get_agent_ttys


def _default_agents_fill():
    from omniwatch import agents as agents_mod
    return agents_mod.fill_missing_tty_cwds


class ColorsPoller(threading.Thread):
    """Optional iTerm2 Python API poll for per-session tab colors. Every
    poll reconnects (see itermcolor.fetch_colors) rather than holding a
    persistent connection open, which keeps this consistent with every
    other poller in the file and is cheap enough locally.

    If the `iterm2` package isn't installed, this is expected and
    permanent: stop polling for the life of the process and never emit an
    event, so the engine never shows an error for the common case of a
    user who hasn't opted into the feature. Any other failure (API not
    enabled yet, iTerm2 not running, a stale connection) is treated as
    transient and retried on the next interval."""

    def __init__(self, events, stop, interval=config.COLOR_INTERVAL,
                 providers=None, fetch=None, set_color=None):
        super().__init__(name='colors', daemon=True)
        self.events = events
        self.stop_evt = stop
        self.interval = interval
        self.fetch = fetch or (providers.colors.fetch if providers
                                else itermcolor.fetch_colors)
        self.set_color = set_color or (providers.colors.set if providers
                                       else itermcolor.set_session_color)
        self.available = True
        self.actions = queue.Queue()

    def request(self, uid, color_name):
        """Set (color_name is a preset name) or clear (None) uid's tab
        color. Best-effort: silently does nothing once `available` is
        False (see class docstring)."""
        self.actions.put(('set_color', (uid, color_name)))

    def kick(self):
        self.actions.put(('poll', ()))

    def run(self):
        while not self.stop_evt.is_set() and self.available:
            self.poll()
            deadline = time.monotonic() + self.interval
            while not self.stop_evt.is_set():
                timeout = deadline - time.monotonic()
                if timeout <= 0:
                    break
                try:
                    kind, args = self.actions.get(timeout=timeout)
                except queue.Empty:
                    break
                if kind == 'poll':
                    break
                self._do_action(kind, args)
                break  # re-poll immediately after any action

    def poll(self, now=None):
        if not self.available:
            return
        now = now if now is not None else time.time()
        try:
            colors = self.fetch()
        except itermcolor.ColorApiUnavailable:
            self.available = False
            return
        except Exception:
            return  # transient — keep last-known colors, retry next tick
        self.events.put(('colors', ColorsSnapshot(
            colors=tuple(sorted(colors.items())), at=now)))

    def _do_action(self, kind, args):
        if kind != 'set_color':
            return
        uid, color_name = args
        try:
            self.set_color(uid, color_name)
        except itermcolor.ColorApiUnavailable:
            self.available = False
        except Exception:
            pass  # best-effort; the next poll shows whatever actually took


class UsagePoller(threading.Thread):
    """Usage API poller, gated on agent presence. Checks the gate every
    few seconds but only hits the API on its base interval (stretched by
    Retry-After). Keeps last-good data across transient failures."""

    GATE_INTERVAL = 5
    KICK_MIN_AGE = 10  # manual refresh only refetches if data this old

    def __init__(self, name, events, stop, agents_box, agent, fetch,
                 base_interval):
        super().__init__(name=name, daemon=True)
        self.event_name = name
        self.events = events
        self.stop_evt = stop
        self.agents_box = agents_box
        self.agent = agent
        self.fetch = fetch
        self.base_interval = base_interval
        self.interval = base_interval
        self.data = None
        self.last_fetch = 0.0
        self.kick_evt = threading.Event()
        self._published_inactive = False

    def kick(self):
        self.kick_evt.set()

    def run(self):
        while not self.stop_evt.is_set():
            forced = self.kick_evt.is_set()
            self.kick_evt.clear()
            self.poll(forced=forced)
            self.kick_evt.wait(self.GATE_INTERVAL)

    def poll(self, now=None, forced=False):
        now = now if now is not None else time.time()
        snap = self.agents_box.get()
        active = bool(snap) and any(self.agent in agents
                                    for _, agents in snap.ttys)
        if not active:
            if not self._published_inactive:
                self.data = None
                self.last_fetch = 0.0
                self.interval = self.base_interval
                self.events.put((self.event_name,
                                 UsageSnapshot(inactive=True, at=now)))
                self._published_inactive = True
            return
        self._published_inactive = False
        if forced and now - self.last_fetch >= self.KICK_MIN_AGE:
            self.last_fetch = 0.0
        if self.last_fetch and now - self.last_fetch < self.interval:
            return
        fresh, retry_after = self.fetch()
        ok = fresh is not None
        if ok:
            self.data = fresh
            self.interval = self.base_interval
        else:
            # respect Retry-After, never below the normal interval
            self.interval = max(self.base_interval, retry_after or 0)
        self.last_fetch = now
        self.events.put((self.event_name,
                         UsageSnapshot(data=self.data, ok=ok, at=now)))


def start_pollers(events, stop, providers):
    """Create and start all pollers against `providers`. Returns them
    keyed by name, plus the needs_cwd_box the engine writes to."""
    needs_cwd_box = LatestBox()
    agents_box = LatestBox()
    pollers = {
        'iterm': ItermWorker(events, stop, providers),
        'agents': AgentsPoller(events, stop, needs_cwd_box, agents_box,
                               providers),
        'colors': ColorsPoller(events, stop, providers=providers),
        'usage_claude': UsagePoller(
            'usage_claude', events, stop, agents_box, 'claude',
            providers.usage_claude.fetch, config.USAGE_REFRESH_INTERVAL),
        'usage_codex': UsagePoller(
            'usage_codex', events, stop, agents_box, 'codex',
            providers.usage_codex.fetch, config.CODEX_USAGE_REFRESH_INTERVAL),
    }
    pollers['agents'].start()
    pollers['iterm'].start()
    pollers['colors'].start()
    pollers['usage_claude'].start()
    pollers['usage_codex'].start()
    return pollers, needs_cwd_box


def kick_all(pollers):
    for p in pollers.values():
        p.kick()
