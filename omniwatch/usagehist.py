"""Usage history & burn rate (DESIGN.md §3 P1, promoted to v1).

Every successful usage snapshot appends one JSON line per provider to
``<config dir>/usage-history.jsonl``:

    {"t": 1790000000.0, "p": "claude", "l": {"claude.five_hour": [62.0, 1790008140], …}}

(``l`` maps limit id → ``[pct, resets_at]``). The file is append-only while
running, bounded to 7 days / 10 000 lines, and pruned (atomic rewrite) on
load and when it grows past the bound. Malformed lines are skipped.

``burn(limit_id, now)`` fits a least-squares line through the current reset
cycle's recent points (last 2 h) and projects when the limit reaches 100 %:
"at this rate: 100% Today at 3:40pm", or "~78% at reset" when the window
resets first.
"""
import json
import os
import tempfile
import threading
from datetime import datetime

from omniwatch.timefmt import format_abs_time

MAX_AGE = 7 * 86400
MAX_ENTRIES = 10000
BURN_LOOKBACK = 2 * 3600
BURN_MIN_SPAN = 600
MAX_HOURS = 168


def _number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _valid(entry):
    if not (isinstance(entry, dict) and _number(entry.get('t'))
            and isinstance(entry.get('p'), str) and isinstance(entry.get('l'), dict)):
        return False
    # every value is [pct] or [pct, resets_at|null] (series()/burn() index into it)
    return all(isinstance(v, list) and len(v) in (1, 2) and _number(v[0]) and
               (len(v) == 1 or v[1] is None or _number(v[1]))
               for v in entry['l'].values())


class UsageHistory:
    def __init__(self, path=None, max_age=MAX_AGE, max_entries=MAX_ENTRIES):
        self.path = path
        self.max_age = max_age
        self.max_entries = max_entries
        self.lock = threading.Lock()
        self._entries = []
        self.rev = 0

    # ---- file ----------------------------------------------------------------

    def load(self, now):
        entries, dirty = [], False
        if self.path:
            try:
                # errors='replace': a damaged byte spoils one line (skipped
                # below as invalid JSON), not the whole engine startup.
                with open(self.path, encoding='utf-8', errors='replace') as f:
                    for line in f:
                        try:
                            entry = json.loads(line)
                        except ValueError:
                            dirty = True
                            continue
                        if _valid(entry):
                            entries.append(entry)
                        else:
                            dirty = True
            except OSError:
                pass
        with self.lock:
            self._entries = sorted(entries, key=lambda e: e['t'])
            dirty = self._prune(now) or dirty
            self.rev += 1
        if dirty:
            self._rewrite()

    def _prune(self, now):
        before = len(self._entries)
        cutoff = now - self.max_age
        self._entries = [e for e in self._entries if e['t'] >= cutoff]
        if len(self._entries) > self.max_entries:
            self._entries = self._entries[-self.max_entries:]
        return len(self._entries) != before

    def _rewrite(self):
        if not self.path:
            return
        with self.lock:
            lines = [json.dumps(e, separators=(',', ':')) + '\n' for e in self._entries]
        try:
            directory = os.path.dirname(self.path) or '.'
            os.makedirs(directory, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=directory, prefix='.usage-history-')
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                f.writelines(lines)
            os.replace(tmp, self.path)
        except OSError:
            pass

    def _append(self, entry):
        if not self.path:
            return
        try:
            os.makedirs(os.path.dirname(self.path) or '.', exist_ok=True)
            with open(self.path, 'a', encoding='utf-8') as f:
                f.write(json.dumps(entry, separators=(',', ':')) + '\n')
        except OSError:
            pass

    # ---- writes (engine thread) ----------------------------------------------

    def record(self, provider, limits, at):
        """Append one snapshot's limits ([{id, pct, resets_at}, …])."""
        values = {l['id']: [l['pct'], l.get('resets_at')] for l in limits
                  if isinstance(l.get('pct'), (int, float))}
        if not values:
            return False
        entry = {'t': at, 'p': provider, 'l': values}
        with self.lock:
            self._entries.append(entry)
            self.rev += 1
            overflow = len(self._entries) > self.max_entries * 1.2
            if overflow:
                self._prune(at)
        if overflow:
            self._rewrite()
        else:
            self._append(entry)
        return True

    def seed(self, entries, now):
        """Merge historical entries (demo data) and rewrite the file."""
        with self.lock:
            self._entries = sorted(self._entries + [e for e in entries if _valid(e)],
                                   key=lambda e: e['t'])
            self._prune(now)
            self.rev += 1
        self._rewrite()

    # ---- reads (any thread) ----------------------------------------------------

    def series(self, limit_id, since=None):
        """[(t, pct, resets_at)] for one limit, oldest first."""
        with self.lock:
            entries = list(self._entries)
        out = []
        for e in entries:
            v = e['l'].get(limit_id)
            if v is None or (since is not None and e['t'] < since):
                continue
            out.append((e['t'], v[0], v[1] if len(v) > 1 else None))
        return out

    def limit_ids(self):
        with self.lock:
            entries = list(self._entries)
        ids = {}
        for e in entries:
            for lid in e['l']:
                ids.setdefault(lid, e['p'])
        return ids

    def burn(self, limit_id, now):
        """Burn-rate projection for the current reset cycle, or None."""
        series = self.series(limit_id)
        if not series:
            return None
        last_t, pct, resets = series[-1]
        cycle = [p for p in series if p[2] == resets]
        recent = [p for p in cycle if p[0] >= last_t - BURN_LOOKBACK]
        if len(recent) < 2 or recent[-1][0] - recent[0][0] < BURN_MIN_SPAN:
            return None
        n = len(recent)
        mt = sum(p[0] for p in recent) / n
        mp = sum(p[1] for p in recent) / n
        den = sum((p[0] - mt) ** 2 for p in recent)
        slope = sum((p[0] - mt) * (p[1] - mp) for p in recent) / den   # pct / s
        out = {'rate_per_hour': round(slope * 3600, 2), 'eta': None,
               'before_reset': False, 'at_reset_pct': None, 'text': ''}
        if pct >= 100:
            out.update(before_reset=True, text='limit hit')
            return out
        if slope <= 0:
            out['text'] = 'not rising'
            return out
        eta = last_t + (100 - pct) / slope
        if resets and eta >= resets:
            at_reset = min(100.0, pct + slope * (resets - last_t))
            out.update(at_reset_pct=round(at_reset, 1),
                       text='at this rate: ~%d%% at reset' % round(at_reset))
            return out
        now_local = datetime.fromtimestamp(now)
        out.update(eta=int(eta), before_reset=True,
                   text='at this rate: 100%% %s' % format_abs_time(
                       datetime.fromtimestamp(eta), now=now_local))
        return out

    def view(self, now, hours=24):
        """Sparkline-ready points + burn per limit for the last `hours`."""
        since = now - hours * 3600
        limits = {}
        for lid, provider in sorted(self.limit_ids().items()):
            series = self.series(lid, since)
            if not series:
                continue
            limits[lid] = {'provider': provider,
                           'points': [[t, pct] for t, pct, _ in series],
                           'latest': {'t': series[-1][0], 'pct': series[-1][1],
                                      'resets_at': series[-1][2]},
                           'burn': self.burn(lid, now)}
        return {'from': since, 'to': now, 'hours': hours, 'limits': limits}
