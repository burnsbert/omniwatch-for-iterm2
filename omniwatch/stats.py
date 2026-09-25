""""Blocked on you" stats (DESIGN.md §3 P1, promoted to v1).

For the current local calendar day: total seconds agent sessions spent
waiting for the user, the longest single (finished) wait, how many waits
started, and how many were answered (the session left WAITING while still
open). Waits in progress are listed with their start time so a client can
add the live portion itself; the published object only changes on a
transition or at midnight.

The day's totals are persisted to ``<config dir>/stats.json`` (atomic write)
so a restart doesn't zero them; a file from another day is ignored.
"""
import json
import os
import tempfile
import time


def day_of(at):
    return time.strftime('%Y-%m-%d', time.localtime(at))


def day_start(at):
    t = time.localtime(at)
    return time.mktime((t.tm_year, t.tm_mon, t.tm_mday, 0, 0, 0, 0, 0, -1))


class BlockedStats:
    def __init__(self, path=None):
        self.path = path
        self.day = None
        self.waiting_seconds = 0.0
        self.longest_wait_s = 0.0
        self.answered = 0
        self.waits = 0
        self.active = {}          # uid -> wait start (clipped to today)
        self.dirty = False

    # ---- persistence -------------------------------------------------------

    def load(self, now):
        self.roll(now)
        if not self.path:
            return
        try:
            with open(self.path, encoding='utf-8') as f:
                data = json.load(f)
        except (OSError, ValueError):
            return
        if not isinstance(data, dict) or data.get('day') != self.day:
            return
        try:
            self.waiting_seconds = float(data.get('waiting_seconds', 0))
            self.longest_wait_s = float(data.get('longest_wait_s', 0))
            self.answered = int(data.get('answered', 0))
            self.waits = int(data.get('waits', 0))
        except (TypeError, ValueError):
            self.waiting_seconds = self.longest_wait_s = 0.0
            self.answered = self.waits = 0

    def save(self):
        if not self.path or not self.dirty:
            return
        try:
            directory = os.path.dirname(self.path) or '.'
            os.makedirs(directory, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=directory, prefix='.stats-')
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                json.dump({'day': self.day, 'waiting_seconds': self.waiting_seconds,
                           'longest_wait_s': self.longest_wait_s,
                           'answered': self.answered, 'waits': self.waits}, f)
            os.replace(tmp, self.path)
            self.dirty = False
        except OSError:
            pass   # best-effort, like state.json

    # ---- accounting (engine thread) ---------------------------------------

    def roll(self, now):
        """Start a new day at local midnight. Returns True if it rolled."""
        today = day_of(now)
        if today == self.day:
            return False
        self.day = today
        self.waiting_seconds = self.longest_wait_s = 0.0
        self.answered = self.waits = 0
        midnight = day_start(now)
        self.active = {uid: max(since, midnight) for uid, since in self.active.items()}
        self.dirty = True
        return True

    def start(self, uid, at):
        self.roll(at)
        if uid in self.active:
            return False
        self.active[uid] = max(at, day_start(at))
        self.waits += 1
        self.dirty = True
        return True

    def end(self, uid, at, answered=True):
        self.roll(at)
        since = self.active.pop(uid, None)
        if since is None:
            return False
        self._add(max(0.0, at - max(since, day_start(at))), answered)
        return True

    def end_all(self, at, answered=False):
        for uid in list(self.active):
            self.end(uid, at, answered)

    def _add(self, duration, answered):
        self.waiting_seconds += duration
        self.longest_wait_s = max(self.longest_wait_s, duration)
        if answered:
            self.answered += 1
        self.dirty = True

    def seed(self, completed, active, now):
        """Demo/history seed: `completed` [(start, end)] finished waits,
        `active` {uid: since} waits still in progress (replacing a later
        start recorded at first observation)."""
        self.roll(now)
        midnight = day_start(now)
        for start, end in completed:
            if end <= midnight or end > now:
                continue
            self.waits += 1
            self._add(end - max(start, midnight), True)
        for uid, since in active.items():
            since = max(since, midnight)
            if uid not in self.active:
                self.waits += 1
                self.active[uid] = since
            else:
                self.active[uid] = min(self.active[uid], since)
        self.dirty = True

    def view(self):
        return {'day': self.day,
                'waiting_seconds': int(round(self.waiting_seconds)),
                'longest_wait_s': int(round(self.longest_wait_s)),
                'answered': self.answered, 'waits': self.waits,
                'active': [{'uid': uid, 'since': since}
                           for uid, since in sorted(self.active.items(),
                                                    key=lambda kv: (kv[1], kv[0]))]}
