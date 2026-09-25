"""The engine thread: replaces Ultrawatch's curses UI thread (``ui/app.py``
model + dispatch; docs/DESIGN.md §4.2 "Engine threading").

One thread owns the ``SessionTracker`` and the ``StateStore`` (both stay
single-threaded). It drains poller events and commands from one queue,
applies them, then rebuilds the published State document (views.py) and
diffs it against the previous one to emit SSE events through the hub.

HTTP handler threads never touch the tracker or store. They read the
published (immutable, replaced-not-mutated) document, or run a command on
the engine thread via ``call()`` and wait on a Future for up to 2 s.
Validation lives in the command functions, which raise ``ApiError``; the
server maps that to the §4.4 error shape.

When no engine thread is running (tests), ``call()`` and ``pump()`` run
inline in the caller's thread, so the whole model is testable without
threads or sleeps.
"""
import collections
import concurrent.futures
import copy
import itertools
import os
import platform
import queue
import shlex
import sys
import threading
import time
import unicodedata
from datetime import datetime, timezone

from omniwatch import __version__, config, itermcolor
from omniwatch import activity as activity_mod
from omniwatch import heuristics as H
from omniwatch import persist
from omniwatch import stats as stats_mod
from omniwatch import usagehist, views
from omniwatch.iterm import ItermNotAuthorized, ItermNotRunning
from omniwatch.snapshot import (AgentSnapshot, ColorsSnapshot, ItermSnapshot,
                                UsageSnapshot)

CALL_TIMEOUT = 2.0
REPLY_MAX_AGE = 5.0          # quick reply: reject snapshots older than this
REPLY_MAX_CHARS = 2000
LABEL_MAX_CHARS = 80
PROJECT_MAX_CHARS = 80
STALE_FACTOR = 4             # P-26: stale when the snapshot is > 4× interval old
NOT_AUTHORIZED_PREFIX = 'not_authorized: '
TICK = 1.0

USAGE_KINDS = (('claude', 'usage_claude'), ('codex', 'usage_codex'))

# Worker action kind -> API/SSE action kind.
WORKER_KINDS = {'goto': 'goto', 'close_uid': 'close', 'new': 'new_tab',
                'reply': 'reply', 'probe': 'probe', 'launch': 'launch'}


class ApiError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def _bad(message):
    return ApiError(400, 'bad_request', message)


def _invalid(message):
    return ApiError(422, 'invalid', message)


def _not_found(message='session not found'):
    return ApiError(404, 'not_found', message)


# ---------------------------------------------------------------------
# Prefs validation (PATCH /api/v1/prefs whitelist + types + ranges)
# ---------------------------------------------------------------------

def _is_bool(v):
    return isinstance(v, bool)


def _is_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _choice(*values):
    return lambda v: isinstance(v, str) and v in values


def _range(lo, hi):
    return lambda v: _is_number(v) and lo <= v <= hi


PREF_RULES = {
    'view': _choice('split', 'list', 'grid'),
    'sort': _choice('natural', 'attention', 'agents', 'activity', 'path'),
    'show_dollars': _is_bool,
    'sound': _is_bool,
    'split_ratio': _range(0.2, 0.8),
    'projects_open': _is_bool,
    'grid_all': _is_bool,
    'usage_strip': _choice('expanded', 'collapsed'),
    'theme': _choice('system', 'dark', 'light'),
    'font_scale': _range(0.5, 2.0),
    'notifications': lambda v: isinstance(v, dict),
    'quick_reply': _is_bool,
    'keep_on_top': _is_bool,
    'close_window_on_q': _is_bool,
    'hint_bar': _is_bool,
    'debug_rule': _is_bool,
    'onboarding_done': _is_bool,
    'stall_minutes': lambda v: isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 240,
    'editor': lambda v: _valid_editor(v),
}
NOTIFICATION_RULES = {'enabled': _is_bool, 'click': _choice('goto', 'show')}

assert set(PREF_RULES) == set(persist.PREF_KEYS), 'PREF_RULES out of sync'


EDITOR_MAX_CHARS = 200
# $VISUAL/$EDITOR values that need a terminal; launching them from the
# backend would hang invisibly, so they're skipped (use e.g. "code -w",
# "zed", or 'open -a "Sublime Text"').
TERMINAL_EDITORS = frozenset({'vi', 'vim', 'nvim', 'nano', 'pico', 'emacs', 'micro',
                              'hx', 'helix', 'kak', 'ne', 'joe', 'ed', 'mg', 'jed'})
REVEAL_TARGETS = ('finder', 'editor', 'copy_path')


def _valid_editor(value):
    if not isinstance(value, str) or len(value) > EDITOR_MAX_CHARS:
        return False
    if any(unicodedata.category(ch) == 'Cc' for ch in value):
        return False
    try:
        shlex.split(value)
    except ValueError:
        return False
    return True


def resolve_editor(pref, env):
    """argv for "Open in editor": the `editor` pref, else $VISUAL, else
    $EDITOR, else `code`; terminal-only editors are skipped. Never a
    shell: the command is split with shlex and run as argv."""
    for cmd in (pref, env.get('VISUAL'), env.get('EDITOR'), 'code'):
        if not cmd or not cmd.strip():
            continue
        try:
            argv = shlex.split(cmd)
        except ValueError:
            continue
        if argv and os.path.basename(argv[0]) not in TERMINAL_EDITORS:
            return argv
    return ['code']


def _valid_notifications(value, partial):
    if not isinstance(value, dict):
        return False
    if not partial and set(value) != set(NOTIFICATION_RULES):
        return False
    return all(k in NOTIFICATION_RULES and NOTIFICATION_RULES[k](v)
               for k, v in value.items())


def normalize_prefs(store):
    """Reset stored prefs that fail validation to their defaults (P-74:
    unknown or invalid values are normalized)."""
    for key, rule in PREF_RULES.items():
        value = store.get(key)
        ok = (_valid_notifications(value, partial=False)
              if key == 'notifications' else rule(value))
        if not ok:
            store.state[key] = copy.deepcopy(persist.DEFAULTS[key])


def clean_text(value, what, max_chars, allow_newline=False):
    """Validate a user string: str, ≤ max_chars, no control characters
    (except '\\n' when allowed). Returns it unchanged."""
    if not isinstance(value, str):
        raise _bad('%s must be a string' % what)
    if len(value) > max_chars:
        raise _invalid('%s is longer than %d characters' % (what, max_chars))
    for ch in value:
        if ch == '\n' and allow_newline:
            continue
        if unicodedata.category(ch) == 'Cc':
            raise _invalid('%s contains control characters' % what)
    return value


class MemoryQuota:
    """In-memory stand-in for notifier.py (demo mode and tests): same
    check/mark_notified/draft_url interface, never touches ~/.claude."""

    def __init__(self, to='you@example.com', threshold=90, enabled=True):
        self.to = to
        self.threshold = threshold
        self.enabled = enabled
        self.notified = False

    def check(self, pct):
        if not self.enabled or self.notified or pct < self.threshold:
            return None
        return {'pct': pct, 'to': self.to}

    def mark_notified(self):
        self.notified = True

    def draft_url(self):
        return 'https://mail.google.com/mail/?view=cm&to=' + self.to


def _call_quietly(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


class Engine:
    def __init__(self, providers, store, hub, *, pollers=None,
                 needs_cwd_box=None, start_pollers=True, demo=False,
                 demo_factory=None, demo_options=None, quota=None,
                 version=__version__, config_dir='', log_path='',
                 fresh_seconds=config.FRESH_SECONDS,
                 snapshot_interval=config.SNAPSHOT_INTERVAL,
                 debug_state=config.DEBUG_STATE, home=config.HOME,
                 tick=TICK, sync=False, autostep=None):
        self.providers = providers
        self.clock = providers.clock
        self.store = store
        self.hub = hub
        self.demo = demo
        self.demo_factory = demo_factory
        self.demo_options = dict(demo_options or {})
        self.version = version
        self.config_dir = config_dir
        self.log_path = log_path
        self.fresh_seconds = fresh_seconds
        self.snapshot_interval = snapshot_interval
        self.debug_state = debug_state
        self.home = home
        self.tick = tick
        # sync: drive the providers on this thread instead of starting
        # pollers (demo mode: the fake world isn't thread-safe and its
        # clock only moves via demo.step). autostep: seconds between
        # automatic demo.step() calls (None = time frozen, E2E/screenshots).
        self.sync = sync
        self.autostep = autostep
        self._last_autostep = time.monotonic()
        if quota is None:
            if demo:
                quota = MemoryQuota()
            else:
                from omniwatch import notifier
                quota = notifier
        self.quota = quota

        self.events = queue.Queue()
        self.stop_evt = threading.Event()
        self._thread = None
        if sync and pollers is None:
            pollers = {'iterm': _SyncWorker(self), 'colors': _SyncColors(self)}
        self._start_pollers = start_pollers and pollers is None
        self.pollers = pollers if pollers is not None else {}
        self.needs_cwd_box = needs_cwd_box

        self.tracker = H.SessionTracker()
        normalize_prefs(store)
        self._reset_model()
        now = self.clock.time()
        self.stats = stats_mod.BlockedStats(self._config_path('stats.json'))
        self.stats.load(now)
        self.usage_history = usagehist.UsageHistory(
            self._config_path('usage-history.jsonl'))
        self.usage_history.load(now)

        self._action_ids = itertools.count(1)
        self._pending_actions = collections.deque()   # (id, kind, uid, ok_detail)
        self._out = []                                # events to emit next publish
        self._transitions = []                        # (uid, old, new, at)
        self._seq = 0
        self._doc = None
        self._last = None
        self._creds = {}                              # kind -> bool
        self._creds_inflight = set()
        self._publish(initial=True)

    # ------------------------------------------------------------ model

    def _reset_model(self):
        self.started = self.clock.time()
        self.iterm_snap = None           # last good ItermSnapshot
        self.iterm_status = 'connecting'
        self.iterm_error = ''
        self.last_poll_at = None
        self.poll_ms = None
        self.paths = {}
        self.agents_snap = None
        self.colors = {}
        self.colors_seen = False
        self.colors_unavailable = False
        self.usage = {'claude': None, 'codex': None}
        self.usage_stale_since = {'claude': None, 'codex': None}
        self._usage_fetched = {'claude': None, 'codex': None}   # sync mode
        self._force_usage = False
        self._usage_blocks = None
        self._usage_blocks_key = None
        self.quota_prompt = None
        self.quota_surfaced = False
        self._missing_cwd = frozenset()
        self.activity = activity_mod.ActivityLog()
        self._live = set()
        self._stalled = set()

    def _config_path(self, name):
        return os.path.join(self.config_dir, name) if self.config_dir else None

    def _sessions(self):
        return self.iterm_snap.sessions if self.iterm_snap else ()

    def _session(self, uid):
        for s in self._sessions():
            if s.uid == uid:
                return s
        return None

    def _require_session(self, uid):
        s = self._session(uid)
        if s is None:
            raise _not_found()
        return s

    def _require_iterm(self):
        if self.iterm_status != 'ok':
            raise ApiError(503, 'iterm_unavailable',
                           'iTerm2 is %s' % self.iterm_status.replace('_', ' '))

    def _tab_colors_capability(self):
        colors_poller = self.pollers.get('colors')
        if self.colors_unavailable or (
                colors_poller is not None and
                getattr(colors_poller, 'available', True) is False):
            return False
        return True if self.colors_seen else None

    def _debug_rule(self):
        return bool(self.debug_state or self.store.get('debug_rule'))

    # ------------------------------------------------------------ thread

    def start(self):
        if self._start_pollers:
            from omniwatch import pollers as pollers_mod
            self.pollers, self.needs_cwd_box = pollers_mod.start_pollers(
                self.events, self.stop_evt, self.providers)
        self._thread = threading.Thread(target=self._run, name='engine',
                                        daemon=True)
        self._thread.start()

    def stop(self, timeout=1.0):
        self.stop_evt.set()
        self.events.put(('__wake__', None))
        if self._thread is not None and self._thread is not threading.current_thread():
            self._thread.join(timeout)
        self.store.save()
        self.stats.save()

    @property
    def running(self):
        return self._thread is not None and self._thread.is_alive()

    def _run(self):
        while not self.stop_evt.is_set():
            try:
                item = self.events.get(timeout=self.tick)
            except queue.Empty:
                item = None
            if item is not None:
                self._handle(item)
                self._drain(limit=200)
            self._housekeeping()
            self._publish()

    def _drain(self, limit=None):
        n = 0
        while limit is None or n < limit:
            try:
                item = self.events.get_nowait()
            except queue.Empty:
                return
            self._handle(item)
            n += 1

    def pump(self):
        """Process everything queued and publish (no-thread/test mode)."""
        self._drain()
        self._housekeeping()
        self._publish()
        return self._seq

    def _housekeeping(self):
        self.store.maybe_save()
        self.stats.roll(self.clock.time())
        self.stats.save()
        if self.autostep is not None and self.sync:
            t = time.monotonic()
            elapsed = t - self._last_autostep
            if elapsed >= self.autostep:
                self._last_autostep = t
                demo = getattr(self.providers, 'demo', None)
                if demo is not None:
                    _call_quietly(lambda: demo.step(elapsed))
                self.sync_poll()

    def call(self, fn, *args, timeout=CALL_TIMEOUT):
        """Run `fn(*args)` on the engine thread and return its result (or
        raise its ApiError). Inline when no engine thread is running."""
        if not self.running or threading.current_thread() is self._thread:
            try:
                return fn(*args)
            finally:
                self._publish()
        fut = concurrent.futures.Future()
        self.events.put(('__cmd__', (fn, args, fut)))
        try:
            return fut.result(timeout=timeout)
        except concurrent.futures.TimeoutError:
            raise ApiError(503, 'unavailable', 'engine did not respond in time')

    # ------------------------------------------------------------ events

    def _handle(self, item):
        kind, payload = item
        if kind == '__cmd__':
            fn, args, fut = payload
            if not fut.set_running_or_notify_cancel():
                return
            try:
                fut.set_result(fn(*args))
            except BaseException as e:   # delivered to the waiting caller
                fut.set_exception(e)
        elif kind == 'iterm':
            self._on_iterm(payload)
        elif kind == '__iterm_sync__':
            self._on_iterm(*payload)
        elif kind == 'paths':
            self.paths.update(dict(payload.paths))
        elif kind == 'agents':
            self.agents_snap = payload
        elif kind == 'colors':
            self.colors = dict(payload.colors)
            self.colors_seen = True
        elif kind in ('usage_claude', 'usage_codex'):
            self._on_usage(kind[len('usage_'):], payload)
        elif kind == 'action':
            self._on_worker_action(*payload)
        elif kind == '__action_done__':
            action_id, akind, uid, ok, detail = payload
            self._emit('action', {'id': action_id, 'kind': akind, 'uid': uid,
                                  'ok': ok, 'detail': detail})
        elif kind == '__sync_action__':
            self._run_sync_action(*payload)
        elif kind == '__sync_poll__':
            self.sync_poll()
        elif kind == '__creds__':
            ukind, value = payload
            self._creds_inflight.discard(ukind)
            if value is not None:
                self._creds[ukind] = value
        # '__wake__' and unknown kinds: nothing to do

    def _on_iterm(self, snap, poll_ms=None):
        now = self.clock.time()
        if snap.not_running:
            self.iterm_status, self.iterm_error = 'not_running', ''
            self.iterm_snap = ItermSnapshot(at=snap.at)
            self.tracker.update((), {}, now)   # garbage-collect every track
            self.paths = {}
            self._drop_sessions(self._live, now)
            return
        if snap.error:
            if snap.error.startswith(NOT_AUTHORIZED_PREFIX):
                self.iterm_status = 'not_authorized'
                self.iterm_error = snap.error[len(NOT_AUTHORIZED_PREFIX):]
            else:
                self.iterm_status, self.iterm_error = 'error', snap.error
            return   # keep the last good sessions visible (stale)
        self.iterm_status, self.iterm_error = 'ok', ''
        self.last_poll_at = now
        if self.demo:
            self.poll_ms = 0      # deterministic State in demo mode
        elif poll_ms is not None:
            self.poll_ms = poll_ms
        elif snap.at:             # ItermWorker stamps `at` with time.time()
            self.poll_ms = max(0, int(round((time.time() - snap.at) * 1000)))
        self.iterm_snap = snap
        kinds = views.agent_kinds(self.agents_snap)
        for uid, old, new in self.tracker.update(snap.sessions, kinds, now):
            self._transitions.append((uid, old, new, now))
            self.activity.record(uid, now, new)
            if old == H.WAITING:
                self.stats.end(uid, now, answered=True)
            if new == H.WAITING:
                self.stats.start(uid, now)
        live = {s.uid for s in snap.sessions}
        for uid in live - self._live:          # first observation
            state = self.tracker.state(uid)[0]
            self.activity.record(uid, now, state)
            if state == H.WAITING:
                self.stats.start(uid, now)
        self._drop_sessions(self._live - live, now)
        self._live = live
        self.paths = {u: p for u, p in self.paths.items() if u in live}
        self.store.touch_labels([u for u in live if self.store.label(u)])
        # TTYs with no shell-integration path (P-07). Deliberately not
        # counting the lsof fallback itself as "has a path": otherwise the
        # TTY leaves the request set once filled and its path flip-flops.
        missing = frozenset(s.tty for s in snap.sessions
                            if s.tty and not self.paths.get(s.uid))
        self._missing_cwd = missing
        if self.needs_cwd_box is not None:
            self.needs_cwd_box.set(missing)

    def _drop_sessions(self, uids, now):
        """Sessions that went away: forget their timeline; a wait still in
        progress ends unanswered."""
        for uid in list(uids):
            self.activity.forget(uid)
            self.stats.end(uid, now, answered=False)
            self._stalled.discard(uid)
        self._live = self._live - set(uids)

    def _on_usage(self, kind, snap):
        prev = self.usage[kind]
        self.usage[kind] = snap
        if snap.ok and snap.data and not snap.inactive:
            now = self.clock.time()
            limits = views.USAGE_PROVIDERS[kind](
                snap.data, show_dollars=False,
                now=datetime.fromtimestamp(now, timezone.utc))
            self.usage_history.record(kind, limits, now)
        if snap.inactive or snap.ok:
            self.usage_stale_since[kind] = None
        elif snap.data and self.usage_stale_since[kind] is None:
            self.usage_stale_since[kind] = self.clock.time()
        if not snap.ok and not snap.data and not snap.inactive:
            self._check_credentials(kind)
        elif snap.ok:
            self._creds[kind] = True
        if kind == 'claude' and snap.data and snap is not prev:
            self._check_quota(snap.data)

    def _check_credentials(self, kind):
        """Find out off-thread whether a data-less failure means "no
        credentials" (the Claude check shells out to `security`)."""
        if kind in self._creds or kind in self._creds_inflight:
            return
        provider = getattr(self.providers, 'usage_' + kind, None)
        fn = getattr(provider, 'has_credentials', None)
        if fn is None:
            return
        self._creds_inflight.add(kind)

        def work():
            value = _call_quietly(fn)
            self.events.put(('__creds__', (kind, value if isinstance(value, bool) else None)))
        threading.Thread(target=work, name='creds-' + kind, daemon=True).start()

    def _check_quota(self, data):
        if self.quota_surfaced or self.quota_prompt is not None:
            return
        extra = data.get('extra_usage')
        if not isinstance(extra, dict) or not extra.get('is_enabled'):
            return
        pct = extra.get('utilization')
        try:
            if pct is None and extra.get('monthly_limit'):
                pct = float(extra.get('used_credits') or 0) / float(extra['monthly_limit']) * 100
        except (TypeError, ValueError, ZeroDivisionError):
            pct = None
        if not _is_number(pct):
            return
        prompt = _call_quietly(lambda: self.quota.check(pct))
        if prompt:
            self.quota_prompt = dict(prompt)
            self.quota_surfaced = True
            self._emit('quota', dict(prompt))

    def _on_worker_action(self, wkind, ok, detail):
        if self._pending_actions:
            action_id, akind, uid, ok_detail = self._pending_actions.popleft()
        else:
            action_id, akind, uid, ok_detail = None, WORKER_KINDS.get(wkind, wkind), None, ''
        if ok and not detail:
            detail = ok_detail
        self._emit('action', {'id': action_id, 'kind': akind, 'uid': uid,
                              'ok': bool(ok), 'detail': detail or ''})

    def _run_sync_action(self, wkind, args):
        """ItermWorker._do_action's semantics, run on the engine thread
        (sync mode), followed by an immediate re-poll."""
        p = self.providers.iterm
        ok, detail = True, ''
        try:
            if wkind in ('goto', 'close_uid', 'reply'):
                if wkind == 'goto':
                    ok = p.goto(args[0])
                elif wkind == 'close_uid':
                    ok = p.close_uid(args[0])
                else:
                    uid, text, submit = args
                    ok = p.reply(uid, text, submit=submit)
                if not ok:
                    detail = 'session not found'
            elif wkind == 'new':
                p.new_tab()
            elif wkind == 'probe':
                p.probe()
            elif wkind == 'launch':
                p.launch()
        except Exception as e:
            ok, detail = False, str(e) or type(e).__name__
        self._on_worker_action(wkind, ok, detail)
        self.sync_poll()

    def _emit(self, event, data):
        self._out.append((event, data))

    # ------------------------------------------------------------ publish

    def _iterm_view(self, now):
        stale = self.iterm_status == 'error' and self.iterm_snap is not None
        if (self.iterm_status == 'ok' and self.last_poll_at is not None and
                now - self.last_poll_at > STALE_FACTOR * self.snapshot_interval):
            stale = True
        return views.iterm_view(self.iterm_status, self.iterm_error,
                                self.last_poll_at, self.poll_ms, stale)

    def _usage_view(self, now):
        """UsageBlocks, recomputed only when a snapshot, show_dollars, or a
        credentials answer changes — not every tick (pace projections move
        with `now`; the client ticks countdowns from resets_at itself)."""
        show = bool(self.store.get('show_dollars'))
        key = (show, self.usage_history.rev,
               tuple((id(self.usage[k]), self.usage_stale_since[k],
                      self._creds.get(k)) for k, _ in USAGE_KINDS))
        if key != self._usage_blocks_key:
            self._usage_blocks_key = key
            self._usage_blocks = {
                kind: views.usage_block(kind, self.usage[kind], show, now,
                                        self.usage_stale_since[kind],
                                        self._creds.get(kind),
                                        burn=lambda lid: self.usage_history.burn(lid, now))
                for kind, _ in USAGE_KINDS}
        return self._usage_blocks

    def _build(self, now):
        sessions = self._sessions()
        session_views = views.build_sessions(
            sessions, paths=self.paths, agents_snapshot=self.agents_snap,
            colors=self.colors, tracker=self.tracker, store=self.store,
            started=self.started, now=now, debug_rule=self._debug_rule(),
            home=self.home, fresh_seconds=self.fresh_seconds,
            activity=self.activity,
            stall_seconds=60 * (self.store.get('stall_minutes') or 0))
        return {
            'sessions': session_views,
            'summary': views.summary(session_views, self.tracker.waiting_uids()),
            'windows': views.windows(sessions),
            'iterm': self._iterm_view(now),
            'texts': {s.uid: s.text for s in sessions},
            'usage': self._usage_view(now),
            'prefs': views.prefs(self.store),
            'projects': views.projects(self.store),
            'capabilities': views.capabilities(
                self._tab_colors_capability(), self.store.get('quick_reply'),
                self._debug_rule()),
            'quota_prompt': copy.deepcopy(self.quota_prompt),
            'stats': self.stats.view(),
        }

    @staticmethod
    def _iterm_key(it):
        # last_poll_at/poll_ms move on every poll; they ride along in the
        # next sessions event but don't trigger one (``stale`` does).
        return {k: v for k, v in it.items() if k not in ('last_poll_at', 'poll_ms')}

    def _diff(self, last, cur):
        out = []
        sess_keys = ('sessions', 'summary', 'windows', 'iterm')
        if any(last[k] != cur[k] for k in sess_keys[:3]) or \
                self._iterm_key(last['iterm']) != self._iterm_key(cur['iterm']):
            out.append(('sessions', {k: cur[k] for k in sess_keys}))
        changed = {uid: {'hash': views.screen_hash(text), 'text': text}
                   for uid, text in cur['texts'].items()
                   if last['texts'].get(uid) != text}
        removed = sorted(uid for uid in last['texts'] if uid not in cur['texts'])
        if changed or removed:
            out.append(('screens', {'screens': changed, 'removed': removed}))
        if last['usage'] != cur['usage']:
            out.append(('usage', {'usage': cur['usage']}))
        if last['prefs'] != cur['prefs'] or last['projects'] != cur['projects']:
            out.append(('prefs', {'prefs': cur['prefs'], 'projects': cur['projects']}))
        if last['capabilities'] != cur['capabilities']:
            out.append(('capabilities', cur['capabilities']))
        if last['stats'] != cur['stats']:
            out.append(('stats', {'stats': cur['stats']}))
        return out

    def _stall_events(self, cur):
        """A `stall` event for each session that just became stalled."""
        stalled = {s['uid']: s for s in cur['sessions'] if s['stalled']}
        out = [('stall', {'uid': uid, 'title': s['title'], 'agent': s['agent'],
                          'since': s['stalled_since'],
                          'minutes': self.store.get('stall_minutes'),
                          'muted': s['muted']})
               for uid, s in stalled.items() if uid not in self._stalled]
        self._stalled = set(stalled)
        return out

    def _transition_events(self, cur):
        by_uid = {s['uid']: s for s in cur['sessions']}
        out = []
        for uid, old, new, at in self._transitions:
            s = by_uid.get(uid)
            if s is None:
                continue
            out.append(('transition', {
                'uid': uid, 'from': old, 'to': new, 'at': at,
                'title': s['title'], 'agent': s['agent'],
                'prompt': s['prompt'], 'muted': s['muted']}))
        self._transitions = []
        return out

    def _document(self, cur, seq, now):
        hashes = {s['uid']: s['screen_hash'] for s in cur['sessions']}
        return {
            'version': self.version, 'seq': seq, 'server_time': now,
            'demo': self.demo,
            'iterm': cur['iterm'], 'summary': cur['summary'],
            'windows': cur['windows'], 'sessions': cur['sessions'],
            'screens': {uid: {'hash': hashes[uid], 'text': t}
                        for uid, t in cur['texts'].items()},
            'usage': cur['usage'], 'prefs': cur['prefs'],
            'projects': cur['projects'], 'capabilities': cur['capabilities'],
            'quota_prompt': cur['quota_prompt'],
            'stats': cur['stats'],
        }

    def _publish(self, initial=False, full_state=False):
        now = self.clock.time()
        cur = self._build(now)
        if initial:
            events = []
        else:
            events = self._diff(self._last, cur)
            events += self._transition_events(cur)
            events += self._stall_events(cur)
            events += self._out
        self._out = []
        with self.hub.lock:
            for event, data in events:
                self._seq += 1
                if event in ('sessions', 'screens', 'usage', 'prefs', 'stats'):
                    data = dict(data, seq=self._seq)
                self.hub.broadcast(self._seq, event, data)
            if full_state:
                self._seq += 1
            self._doc = self._document(cur, self._seq, now)
            if full_state:
                self.hub.broadcast(self._seq, 'state', self._doc)
            self._last = cur
        return self._seq

    # ------------------------------------------------------------ reads

    @property
    def seq(self):
        return self._seq

    def state(self):
        """The published State document with a fresh server_time."""
        return dict(self._doc, server_time=self.clock.time())

    def sse_snapshot(self):
        """(seq, state) for a new SSE client; call under hub.lock."""
        return self._seq, self.state()

    def hello(self):
        return {'version': self.version, 'server_time': self.clock.time(),
                'demo': self.demo}

    def summary(self):
        doc = self._doc
        out = views.summary_endpoint(doc['sessions'], doc['summary'])
        out['stats'] = copy.deepcopy(doc['stats'])
        return out

    def prefs(self):
        return copy.deepcopy(self._doc['prefs'])

    def stats_view(self):
        return copy.deepcopy(self._doc['stats'])

    def history(self, uid, hours=activity_mod.WINDOW_SECONDS / 3600):
        """GET /sessions/{uid}/history (runs on the engine thread)."""
        return self.call(self._history, uid, hours)

    def _history(self, uid, hours):
        self._require_session(uid)
        return self.activity.history(uid, self.clock.time(), hours)

    def usage_history_view(self, hours=24):
        return self.usage_history.view(self.clock.time(), hours)

    def diagnostics(self):
        doc = self._doc
        status = doc['iterm']['status']
        automation = {'ok': 'ok', 'not_authorized': 'denied'}.get(status, 'unknown')
        return {
            'python': {'path': sys.executable, 'version': platform.python_version()},
            'iterm': {'status': status, 'error': doc['iterm']['error']},
            'automation': automation,
            'tab_colors': {'package': iterm2_package_available(),
                           'reachable': doc['capabilities']['tab_colors']},
            'claude_credentials': self._credentials('claude'),
            'codex_credentials': self._credentials('codex'),
            'config_dir': self.config_dir,
            'log_path': self.log_path,
            'demo': self.demo,
        }

    def _credentials(self, kind):
        provider = getattr(self.providers, 'usage_' + kind, None)
        fn = getattr(provider, 'has_credentials', None)
        value = _call_quietly(fn) if fn is not None else None
        return value if isinstance(value, bool) else None

    # ------------------------------------------------------------ commands
    # Public methods run on the engine thread via call(); the underscore
    # versions do the work and raise ApiError on bad input.

    def _new_action(self, kind, uid, ok_detail=''):
        action_id = 'a-%d' % next(self._action_ids)
        return action_id, (action_id, kind, uid, ok_detail)

    def _worker_request(self, wkind, uid, args, ok_detail=''):
        worker = self.pollers.get('iterm')
        if worker is None:
            raise ApiError(503, 'iterm_unavailable', 'iTerm worker not running')
        action_id, pending = self._new_action(WORKER_KINDS[wkind], uid, ok_detail)
        self._pending_actions.append(pending)
        worker.request(wkind, *args)
        return {'ok': True, 'action_id': action_id}

    def goto(self, uid):
        return self.call(self._goto, uid)

    def _goto(self, uid):
        s = self._require_session(uid)
        self._require_iterm()
        label = views.tab_label(s, views.window_numbers(self._sessions()))
        return self._worker_request('goto', uid, (uid,), '→ tab %s' % label)

    def visit(self, uid):
        return self.call(self._visit, uid)

    def _visit(self, uid):
        self._require_session(uid)
        self.tracker.visit(uid)
        return {'ok': True}

    def plugin_focus(self, body):
        return self.call(self._plugin_focus, body)

    def _plugin_focus(self, body):
        uid = body.get('uid')
        if not isinstance(uid, str) or not uid:
            raise _bad('uid is required')
        return self._visit(uid)

    def set_label(self, uid, body):
        return self.call(self._set_label, uid, body)

    def _set_label(self, uid, body):
        if 'label' not in body:
            raise _bad('label is required')
        label = clean_text(body['label'], 'label', LABEL_MAX_CHARS).strip()
        self._require_session(uid)
        self.store.set_label(uid, label)
        return {'ok': True, 'label': label}

    def set_color(self, uid, body):
        return self.call(self._set_color, uid, body)

    def _set_color(self, uid, body):
        if 'project' in body:
            n = body['project']
            if not isinstance(n, int) or isinstance(n, bool):
                raise _bad('project must be an integer')
            if not 1 <= n <= len(views.PROJECT_COLORS):
                raise _invalid('project must be 1-5')
            color = views.PROJECT_COLORS[n - 1]
        elif 'color' in body:
            color = body['color']
            if color is not None and not isinstance(color, str):
                raise _bad('color must be a string or null')
            if color is not None and color not in itermcolor.NAME_TO_RGB:
                raise _invalid('unknown color %r' % color)
        else:
            raise _bad('project or color is required')
        s = self._require_session(uid)
        if self._tab_colors_capability() is False:
            raise ApiError(503, 'tab_colors_unavailable',
                           'tab colors unavailable — see onboarding step 2')
        colors_poller = self.pollers.get('colors')
        if colors_poller is None:
            raise ApiError(503, 'tab_colors_unavailable', 'tab colors unavailable')
        colors_poller.request(uid, color)
        label = views.tab_label(s, views.window_numbers(self._sessions()))
        if color is None:
            detail = 'tab %s: color cleared' % label
        else:
            slot = views.project_slot(color)
            project = self.store.project(slot) if slot else ''
            detail = 'tab %s → %s%s' % (label, color,
                                        ' (%s)' % project if project else '')
        action_id, _ = self._new_action('color', uid)
        self._emit('action', {'id': action_id, 'kind': 'color', 'uid': uid,
                              'ok': True, 'detail': detail})
        return {'ok': True, 'action_id': action_id}

    def set_muted(self, uid, body):
        return self.call(self._set_muted, uid, body)

    def _set_muted(self, uid, body):
        muted = body.get('muted')
        if not isinstance(muted, bool):
            raise _bad('muted must be a boolean')
        self._require_session(uid)
        self.store.set_muted(uid, muted)
        return {'ok': True, 'muted': muted}

    def close(self, uid, body):
        return self.call(self._close, uid, body)

    def _close(self, uid, body):
        if body.get('confirm') is not True:
            raise _bad('confirm must be true')
        self._require_session(uid)
        self._require_iterm()
        return self._worker_request('close_uid', uid, (uid,))

    def reply(self, uid, body):
        return self.call(self._reply, uid, body)

    def _reply(self, uid, body):
        text = body.get('text')
        if not isinstance(text, str):
            raise _bad('text must be a string')
        submit = body.get('submit', False)
        if not isinstance(submit, bool):
            raise _bad('submit must be a boolean')
        expect = body.get('expect_hash')
        if not isinstance(expect, str) or not expect:
            raise _bad('expect_hash is required')
        if not text:
            raise _invalid('text is empty')
        clean_text(text, 'text', REPLY_MAX_CHARS, allow_newline=True)
        s = self._require_session(uid)
        if not self.store.get('quick_reply'):
            raise _invalid('quick reply is turned off in Settings')
        self._require_iterm()
        kinds = views.agent_kinds(self.agents_snap)
        state = self.tracker.state(uid)[0]
        if not kinds.get(s.tty) or state != H.WAITING:
            raise _invalid('not an agent session waiting for input')
        now = self.clock.time()
        if expect.lower() != views.screen_hash(s.text):
            raise ApiError(409, 'stale_screen', 'the screen changed')
        if self.last_poll_at is None or now - self.last_poll_at > REPLY_MAX_AGE:
            raise ApiError(409, 'stale_screen', 'the snapshot is too old')
        return self._worker_request('reply', uid, (uid, text, submit))

    def new_tab(self):
        return self.call(self._new_tab)

    def _new_tab(self):
        self._require_iterm()
        return self._worker_request('new', None, (), 'opening new tab…')

    def probe_automation(self):
        return self.call(self._probe)

    def _probe(self):
        return self._worker_request('probe', None, ())

    def launch_iterm(self):
        return self.call(self._launch)

    def _launch(self):
        if self.sync:
            return self._worker_request('launch', None, (), 'launching iTerm2…')
        action_id, _ = self._new_action('launch', None)
        launch = self.providers.iterm.launch

        def work():
            try:
                launch()
                ok, detail = True, 'launching iTerm2…'
            except Exception as e:
                ok, detail = False, str(e) or type(e).__name__
            self.events.put(('__action_done__', (action_id, 'launch', None, ok, detail)))
            worker = self.pollers.get('iterm')
            if worker is not None:
                worker.kick()
        threading.Thread(target=work, name='launch', daemon=True).start()
        return {'ok': True, 'action_id': action_id}

    def reveal(self, uid, body):
        return self.call(self._reveal, uid, body)

    def _reveal(self, uid, body):
        target = body.get('target')
        if not isinstance(target, str):
            raise _bad('target must be a string')
        if target not in REVEAL_TARGETS:
            raise _invalid('target must be one of %s' % ', '.join(REVEAL_TARGETS))
        s = self._require_session(uid)
        path = views.session_path(s, self.paths, self.agents_snap)
        if not path:
            raise _invalid('no known path for this session')
        shown = views.shorten(path, self.home)
        opener = self.providers.opener
        if target == 'finder':
            work, detail = (lambda: opener.reveal(path)), 'revealed %s in Finder' % shown
        elif target == 'editor':
            argv = resolve_editor(self.store.get('editor'), os.environ)
            work = lambda: opener.open_editor(argv, path)
            detail = 'opened %s in %s' % (shown, os.path.basename(argv[0]))
        else:
            work, detail = (lambda: opener.copy_text(path)), 'copied %s' % shown
        action_id, _ = self._new_action('reveal', uid)

        def run():
            try:
                work()
                ok, msg = True, detail
            except FileNotFoundError as e:
                ok, msg = False, 'not found: %s' % (e.filename or e)
            except Exception as e:
                ok, msg = False, str(e) or type(e).__name__
            return (action_id, 'reveal', uid, ok, msg)
        if self.sync:
            self._handle(('__action_done__', run()))
        else:
            threading.Thread(target=lambda: self.events.put(('__action_done__', run())),
                             name='reveal', daemon=True).start()
        return {'ok': True, 'action_id': action_id}

    def refresh(self):
        return self.call(self._refresh)

    def _refresh(self):
        self._force_usage = True
        for p in self.pollers.values():
            p.kick()
        self._emit('toast', {'level': 'info', 'message': 'refreshing…'})
        return {'ok': True}

    def patch_prefs(self, body):
        return self.call(self._patch_prefs, body)

    def _patch_prefs(self, body):
        updates = {}
        for key, value in body.items():
            rule = PREF_RULES.get(key)
            if rule is None:
                raise _invalid('unknown pref %r' % key)
            if key == 'notifications':
                if not _valid_notifications(value, partial=True):
                    raise _invalid('bad value for notifications')
                value = dict(self.store.get('notifications'), **value)
            elif not rule(value):
                raise _invalid('bad value for %s' % key)
            if key in ('split_ratio', 'font_scale'):
                value = round(float(value), 2)
            updates[key] = value
        for key, value in updates.items():
            self.store.set(key, value)
        return views.prefs(self.store)

    def set_project(self, slot, body):
        return self.call(self._set_project, slot, body)

    def _set_project(self, slot, body):
        if not 1 <= slot <= persist.PROJECT_SLOTS:
            raise _not_found('no such project slot')
        if 'name' not in body:
            raise _bad('name is required')
        name = clean_text(body['name'], 'name', PROJECT_MAX_CHARS).strip()
        self.store.set_project(slot, name)
        return {'ok': True, 'project': views.projects(self.store)[slot - 1]}

    def clear_projects(self, body):
        return self.call(self._clear_projects, body)

    def _clear_projects(self, body):
        if body.get('confirm') is not True:
            raise _bad('confirm must be true')
        self.store.clear_projects()
        return {'ok': True}

    def quota_draft(self):
        return self.call(self._quota_draft)

    def _quota_draft(self):
        if self.quota_prompt is None:
            raise _not_found('no quota prompt pending')
        url = _call_quietly(self.quota.draft_url)
        opened = False
        if url:
            self.providers.opener.open_url(url)
            opened = True
        self._quota_done()
        return {'ok': True, 'opened': opened}

    def quota_skip(self):
        return self.call(self._quota_skip)

    def _quota_skip(self):
        if self.quota_prompt is None:
            raise _not_found('no quota prompt pending')
        self._quota_done()
        return {'ok': True}

    def _quota_done(self):
        _call_quietly(self.quota.mark_notified)
        self.quota_prompt = None
        self._publish(full_state=True)

    # ------------------------------------------------------------ demo

    def demo_step(self, body):
        return self.call(self._demo_step, body)

    def _require_demo(self):
        demo = getattr(self.providers, 'demo', None)
        if not self.demo or demo is None:
            raise _not_found('demo mode only')
        return demo

    def _demo_step(self, body):
        demo = self._require_demo()
        seconds = body.get('seconds', 0)
        if not _is_number(seconds):
            raise _bad('seconds must be a number')
        if not 0 <= seconds <= 86400:
            raise _invalid('seconds must be between 0 and 86400')
        demo.step(float(seconds))
        # Two snapshots at the same instant, so a scripted change clears
        # the two-snapshot debounce (P-11) within this one step.
        self.sync_poll()
        self.sync_poll()
        return {'ok': True, 'seq': self._publish()}

    def demo_scenario(self, body):
        return self.call(self._demo_scenario, body)

    def _demo_scenario(self, body):
        self._require_demo()
        name = body.get('name')
        if not isinstance(name, str):
            raise _bad('name must be a string')
        scenarios = self.demo_options.get('scenarios') or ()
        if name not in scenarios or self.demo_factory is None:
            raise _invalid('unknown scenario %r' % name)
        opts = dict(self.demo_options.get('factory_kwargs') or {}, scenario=name)
        target = self.demo_factory(**opts)
        self.providers = target
        self.clock = target.clock
        self.tracker = H.SessionTracker()
        self._reset_model()
        self.stats = stats_mod.BlockedStats(self.stats.path)
        self.stats.roll(self.clock.time())
        self.usage_history = usagehist.UsageHistory(self.usage_history.path)
        self.usage_history.seed([], self.clock.time())
        apply_seed_state(self.store, getattr(target, 'demo', None))
        self.sync_poll()
        self.apply_demo_seed()
        seq = self._publish(full_state=True)
        return {'ok': True, 'seq': seq, 'scenario': name}

    def apply_demo_seed(self):
        """Seed the timeline, blocked-on-you stats, stall clock and usage
        history from the demo providers (``providers.demo.seed_history()``,
        ``.seed_last_change()``, ``.seed_usage_history()``; each optional).
        Call after the first sync_poll so the sessions are tracked."""
        demo = getattr(self.providers, 'demo', None)
        if demo is None:
            return
        now = self.clock.time()
        history = _call_quietly(getattr(demo, 'seed_history', lambda: {})) or {}
        completed, active = [], {}
        for uid, entries in history.items():
            if uid not in self._live:
                continue
            entries = [(at, st) for at, st in entries if at <= now]
            if not entries:
                continue
            self.activity.seed(uid, entries)
            merged = self.activity.entries(uid)
            current = self.tracker.state(uid)[0]
            if entries[-1][1] == current:
                self.tracker.seed(uid, state_since=entries[-1][0])
            for i, (at, st) in enumerate(merged):
                if st != H.WAITING:
                    continue
                if i + 1 < len(merged):
                    completed.append((at, merged[i + 1][0]))
                elif current == H.WAITING:
                    active[uid] = at
        self.stats.seed(completed, active, now)
        last_change = _call_quietly(getattr(demo, 'seed_last_change', lambda: {})) or {}
        for uid, at in last_change.items():
            self.tracker.seed(uid, last_change=at)
        usage = _call_quietly(getattr(demo, 'seed_usage_history', lambda: [])) or []
        if usage:
            self.usage_history.seed(usage, now)

    def sync_poll(self):
        """Poll every provider synchronously on this thread, in the order
        that classifies correctly on the first pass (agents before iTerm).
        Used in demo mode at startup and by demo/step."""
        p = self.providers
        ttys = _call_quietly(p.agents.scan, {}) or {}
        cwds = {}
        if self._missing_cwd:
            cwds = _call_quietly(lambda: p.agents.fill_cwds(self._missing_cwd), {}) or {}
        agents_snap = AgentSnapshot(
            ttys=tuple((t, frozenset(a)) for t, a in sorted(ttys.items())),
            tty_cwd=tuple(sorted(cwds.items())), at=self.clock.time())
        self._handle(('agents', agents_snap))
        paths_snap = _call_quietly(lambda: p.iterm.paths(at=self.clock.time()))
        if paths_snap is not None:
            self._handle(('paths', paths_snap))
        t0 = time.monotonic()
        snap = poll_iterm(p, self.clock.time())
        self._handle(('__iterm_sync__', (snap, int(round((time.monotonic() - t0) * 1000)))))
        if not self.colors_unavailable:
            try:
                colors = p.colors.fetch()
                self._handle(('colors', ColorsSnapshot(
                    colors=tuple(sorted(colors.items())), at=self.clock.time())))
            except itermcolor.ColorApiUnavailable:
                self.colors_unavailable = True
            except Exception:
                pass
        now = self.clock.time()
        force, self._force_usage = self._force_usage, False
        for kind, attr in USAGE_KINDS:
            prev = self.usage[kind]
            active = any(kind in a for _, a in agents_snap.ttys)
            if not active:
                self._usage_fetched[kind] = None
                if prev is None or not prev.inactive:
                    self._handle((attr, UsageSnapshot(inactive=True, at=now)))
                continue
            last = self._usage_fetched[kind]
            if not force and last is not None and \
                    now - last < config.USAGE_REFRESH_INTERVAL:
                continue
            self._usage_fetched[kind] = now
            fresh = _call_quietly(getattr(p, attr).fetch, (None, None))
            data = fresh[0] if isinstance(fresh, tuple) else None
            keep = prev.data if prev is not None else None
            self._handle((attr, UsageSnapshot(data=data if data is not None else keep,
                                              ok=data is not None,
                                              at=self.clock.time())))


class _SyncWorker:
    """Stands in for ItermWorker in sync mode: actions are queued to the
    engine thread; kick() queues a synchronous poll."""

    def __init__(self, engine):
        self.engine = engine

    def request(self, kind, *args):
        self.engine.events.put(('__sync_action__', (kind, args)))

    def kick(self):
        self.engine.events.put(('__sync_poll__', None))


class _SyncColors:
    """Stands in for ColorsPoller in sync mode."""

    def __init__(self, engine):
        self.engine = engine

    @property
    def available(self):
        return not self.engine.colors_unavailable

    def request(self, uid, color_name):
        engine = self.engine

        def apply():
            try:
                engine.providers.colors.set(uid, color_name)
            except itermcolor.ColorApiUnavailable:
                engine.colors_unavailable = True
            except Exception:
                pass
            return None
        engine.events.put(('__cmd__', (apply, (), concurrent.futures.Future())))
        self.kick()

    def kick(self):
        self.engine.events.put(('__sync_poll__', None))


def poll_iterm(providers, at):
    """One snapshot with ItermWorker._poll_snapshot's error mapping."""
    try:
        return providers.iterm.snapshot(at=at)
    except ItermNotRunning:
        return ItermSnapshot(not_running=True, at=at)
    except ItermNotAuthorized as e:
        return ItermSnapshot(error=NOT_AUTHORIZED_PREFIX + (str(e) or 'Not authorized'), at=at)
    except Exception as e:
        return ItermSnapshot(error=str(e) or type(e).__name__, at=at)


def apply_seed_state(store, demo):
    """Optional demo seed (labels/projects/muted/prefs) exposed by demo
    providers as ``providers.demo.initial_state``; ignored if absent."""
    seed = getattr(demo, 'initial_state', None) if demo is not None else None
    if callable(seed):
        seed = _call_quietly(seed)
    if not isinstance(seed, dict):
        return
    labels = seed.get('labels')
    if isinstance(labels, dict):
        for uid, label in labels.items():
            if isinstance(uid, str) and isinstance(label, str):
                store.set_label(uid, label)
    projects = seed.get('projects')
    if isinstance(projects, (list, tuple)):
        for i, name in enumerate(projects[:persist.PROJECT_SLOTS]):
            if isinstance(name, str):
                store.set_project(i + 1, name)
    muted = seed.get('muted')
    if isinstance(muted, (list, tuple)):
        for uid in muted:
            if isinstance(uid, str):
                store.set_muted(uid, True)
    prefs = seed.get('prefs')
    if isinstance(prefs, dict):
        for key, value in prefs.items():
            rule = PREF_RULES.get(key)
            if rule is not None and key != 'notifications' and rule(value):
                store.set(key, value)


def iterm2_package_available():
    import importlib.util
    try:
        return importlib.util.find_spec('iterm2') is not None
    except (ImportError, ValueError):
        return False
