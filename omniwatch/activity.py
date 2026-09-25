"""Per-session activity timeline (DESIGN.md §3 P1 "Activity timeline",
promoted to v1).

``ActivityLog`` keeps, per session uid, the published state changes
``(at, state)`` over a rolling window (8 h), plus the last entry before the
window so the state at the window's start is known. The engine thread is the
only writer; reads go through the engine too.

Two views:
- ``history(uid, now, hours)`` → segments ``[{state, start, end}]`` + totals,
  for ``GET /api/v1/sessions/{uid}/history``.
- ``ribbon(uid, now)`` → a compact fixed-resolution string (48 × 10 min
  buckets, one letter per bucket: the state that held longest in it) for the
  session JSON. Buckets are aligned to wall-clock 10-minute boundaries, so a
  ribbon only changes when the session changes state or a bucket rolls over
  — never every tick.
"""
WINDOW_SECONDS = 8 * 3600
MAX_ENTRIES = 512
RIBBON_BUCKETS = 48
RIBBON_BUCKET_SECONDS = 600

CODES = {'busy': 'b', 'waiting': 'w', 'idle': 'i', 'active': 'a',
         'quiet': 'q', None: '-'}
# Tie-break for a bucket's dominant state (most attention-worthy first).
PRIORITY = ('waiting', 'busy', 'idle', 'active', 'quiet', None)


def _entries_clean(entries):
    """Sort and collapse consecutive duplicate states."""
    out = []
    for at, state in sorted(entries, key=lambda e: e[0]):
        if out and out[-1][1] == state:
            continue
        out.append((float(at), state))
    return out


class ActivityLog:
    def __init__(self, window=WINDOW_SECONDS, max_entries=MAX_ENTRIES):
        self.window = window
        self.max_entries = max_entries
        self._log = {}            # uid -> [(at, state)]
        self._rev = {}            # uid -> int, bumped on every change
        self._ribbons = {}        # uid -> ((end, rev), ribbon dict)

    # ---- writes (engine thread) -----------------------------------------

    def record(self, uid, at, state):
        """Append a state change. Returns True if it was recorded."""
        entries = self._log.setdefault(uid, [])
        if entries and entries[-1][1] == state:
            return False
        if entries and at < entries[-1][0]:
            at = entries[-1][0]
        entries.append((float(at), state))
        self._changed(uid, at)
        return True

    def seed(self, uid, entries):
        """Prepend historical entries (e.g. demo data) that are older than
        anything already recorded for `uid`."""
        existing = self._log.get(uid, [])
        first = existing[0][0] if existing else None
        older = [e for e in entries if first is None or e[0] < first]
        merged = _entries_clean(older + existing)
        if not merged:
            return
        self._log[uid] = merged
        self._changed(uid, merged[-1][0])

    def forget(self, uid):
        self._log.pop(uid, None)
        self._rev.pop(uid, None)
        self._ribbons.pop(uid, None)

    def uids(self):
        return list(self._log)

    def has(self, uid):
        return bool(self._log.get(uid))

    def _changed(self, uid, now):
        self._prune(uid, now)
        self._rev[uid] = self._rev.get(uid, 0) + 1

    def _prune(self, uid, now):
        entries = self._log[uid]
        cutoff = now - self.window
        # keep the last entry at/before the cutoff: it gives the state at
        # the window's start
        i = 0
        while i + 1 < len(entries) and entries[i + 1][0] <= cutoff:
            i += 1
        if i:
            del entries[:i]
        if len(entries) > self.max_entries:
            del entries[:len(entries) - self.max_entries]

    # ---- reads ------------------------------------------------------------

    def entries(self, uid):
        return list(self._log.get(uid, ()))

    def segments(self, uid, now, since):
        """[{state, start, end}] clipped to [since, now]; the ongoing
        segment has ``end: None``."""
        entries = self._log.get(uid, ())
        out = []
        for i, (at, state) in enumerate(entries):
            end = entries[i + 1][0] if i + 1 < len(entries) else None
            if end is not None and end <= since:
                continue
            start = max(at, since)
            if start > now:
                break
            out.append({'state': state, 'start': start,
                        'end': None if end is None else min(end, now)})
        return out

    @staticmethod
    def totals(segments, now):
        out = {}
        for seg in segments:
            end = now if seg['end'] is None else seg['end']
            key = seg['state'] or 'unknown'
            out[key] = out.get(key, 0.0) + max(0.0, end - seg['start'])
        return {k: round(v, 1) for k, v in sorted(out.items())}

    def history(self, uid, now, hours=WINDOW_SECONDS / 3600):
        since = now - hours * 3600
        segments = self.segments(uid, now, since)
        return {'uid': uid, 'from': since, 'to': now, 'hours': hours,
                'segments': segments, 'totals': self.totals(segments, now),
                'transitions': max(0, sum(1 for at, _ in self._log.get(uid, ())
                                          if since < at <= now))}

    def ribbon(self, uid, now, buckets=RIBBON_BUCKETS,
               bucket_seconds=RIBBON_BUCKET_SECONDS):
        """{"end": epoch, "bucket_s": 600, "codes": "<48 letters>"} or None
        when nothing is known about `uid`. Oldest bucket first; the last
        bucket contains `now`."""
        if not self._log.get(uid):
            return None
        end = (int(now // bucket_seconds) + 1) * bucket_seconds
        key = (end, self._rev.get(uid, 0), buckets, bucket_seconds)
        cached = self._ribbons.get(uid)
        if cached and cached[0] == key:
            return cached[1]
        start = end - buckets * bucket_seconds
        entries = self._log[uid]
        spans = [(at, entries[i + 1][0] if i + 1 < len(entries) else now, state)
                 for i, (at, state) in enumerate(entries)]
        codes = []
        for b in range(buckets):
            bs = start + b * bucket_seconds
            be = min(bs + bucket_seconds, now)
            durations = {}
            for s0, s1, state in spans:
                overlap = min(s1, be) - max(s0, bs)
                if overlap > 0:
                    durations[state] = durations.get(state, 0.0) + overlap
            if not durations:
                codes.append('-')
                continue
            best = max(durations.items(),
                       key=lambda kv: (kv[1], -PRIORITY.index(kv[0])
                                       if kv[0] in PRIORITY else -99))
            codes.append(CODES.get(best[0], '-'))
        ribbon = {'end': end, 'bucket_s': bucket_seconds, 'codes': ''.join(codes)}
        self._ribbons[uid] = (key, ribbon)
        return ribbon
