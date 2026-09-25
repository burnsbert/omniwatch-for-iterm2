"""Persistent user state: labels, prefs, and projects in state.json.

Adapted from ultrawatch_lib/persist.py per docs/DESIGN.md §4.2/§4.6: new
Prefs keys (grid_all, usage_strip, theme, font_scale, notifications,
quick_reply, keep_on_top, close_window_on_q, hint_bar, debug_rule,
onboarding_done), a `muted` map, `version: 2`, a one-time read-only
migration from an Ultrawatch state.json (`bell` -> `sound`), and a
PREF_KEYS whitelist for `PATCH /api/v1/prefs` validation (WP2).

Writes are atomic (tempfile + os.replace) and debounced so rapid changes
(typing a label) don't hammer the disk.
"""
import copy
import json
import os
import tempfile
import time

from omniwatch import config

DEFAULTS = {
    'version': 2,
    'labels': {},          # uid -> {'label': str, 'last_seen': epoch}
    'muted': {},           # uid -> True (muted sessions; see §3 mute)
    'view': 'split',       # split | list | grid
    'sort': 'natural',     # natural | attention | agents | activity | path
    'show_dollars': False,
    'sound': False,        # renamed from Ultrawatch's 'bell'
    'split_ratio': 0.42,   # left pane share of the split view
    'projects': ['', '', '', '', ''],  # 5 fixed numbered slots
    'projects_open': False,
    'grid_all': False,
    'usage_strip': 'expanded',
    'theme': 'system',
    'font_scale': 1.0,
    'notifications': {'enabled': True, 'click': 'goto', 'stall': True},
    'quick_reply': True,
    'keep_on_top': False,
    'close_window_on_q': True,
    'hint_bar': True,
    'debug_rule': False,
    'onboarding_done': False,
    'stall_minutes': 10,   # busy + unchanged screen this long = stalled; 0 = off
    'editor': '',          # "Open in editor" command; '' = $VISUAL/$EDITOR/code
    'migrated_from_ultrawatch': None,  # epoch, or None if never migrated
}

# Keys stored in state.json that are *not* part of the client-facing Prefs
# object (§4.4.1) — they have their own endpoints/mechanics.
NON_PREF_KEYS = frozenset({
    'version', 'labels', 'muted', 'projects', 'migrated_from_ultrawatch',
})
PREF_KEYS = frozenset(DEFAULTS) - NON_PREF_KEYS
PREF_TYPES = {k: type(v) for k, v in DEFAULTS.items() if k in PREF_KEYS}

PROJECT_SLOTS = 5

SAVE_DEBOUNCE = 2.0

# touch_labels() persists a live session's last_seen at most this often,
# so a label stays fresh on disk without rewriting state.json every poll.
LABEL_TOUCH_SECONDS = 3600

# Fields imported once from a pre-existing Ultrawatch state.json (P-75).
_MIGRATE_KEYS = ('labels', 'projects', 'projects_open', 'view', 'sort',
                 'show_dollars', 'split_ratio')


def migrate_from_ultrawatch(path):
    """Read an Ultrawatch state.json (read-only; never written) and return
    a dict of fields to seed a fresh Omniwatch StateStore, or None if the
    file is missing/unreadable. Ultrawatch's 'bell' becomes 'sound'."""
    try:
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    out = {}
    for key in _MIGRATE_KEYS:
        if key in data:
            out[key] = data[key]
    if 'bell' in data:
        out['sound'] = bool(data['bell'])
    return out


class StateStore:
    def __init__(self, path=None, now=None, ultrawatch_path=None):
        self.path = path or config.STATE_PATH
        self._dirty_at = None
        now = now if now is not None else time.time()
        self.state = copy.deepcopy(DEFAULTS)
        loaded = self._load()
        if loaded:
            for key in DEFAULTS:
                if key in loaded:
                    self.state[key] = loaded[key]
        elif not self.state.get('migrated_from_ultrawatch'):
            migrated = migrate_from_ultrawatch(
                ultrawatch_path or config.ULTRAWATCH_STATE_PATH)
            if migrated:
                for key, value in migrated.items():
                    self.state[key] = value
                self.state['migrated_from_ultrawatch'] = int(now)
                self._dirty_at = now
        self._clean_labels()
        self._normalize_muted()
        self._normalize_projects()

    def _load(self):
        try:
            with open(self.path, encoding='utf-8') as f:
                data = json.load(f)
            return data if isinstance(data, dict) else None
        except Exception:
            return None

    def _clean_labels(self):
        """Drop malformed label entries. Age-based collection waits for
        gc_labels(), once the live sessions are known: at load time a label
        can look old only because Omniwatch wasn't running."""
        labels = self.state.get('labels')
        if not isinstance(labels, dict):
            self.state['labels'] = {}
            return
        for uid in list(labels):
            entry = labels[uid]
            # A hand-edited/damaged entry (non-string label, non-numeric
            # last_seen) is dropped rather than crashing startup.
            last_seen = entry.get('last_seen', 0) if isinstance(entry, dict) else None
            if (not isinstance(entry, dict) or not entry.get('label') or
                    not isinstance(entry['label'], str) or
                    not isinstance(last_seen, (int, float)) or
                    isinstance(last_seen, bool)):
                del labels[uid]

    def gc_labels(self, live_uids, now=None):
        """Forget labels of sessions that are gone and haven't been seen
        for LABEL_GC_DAYS. Labels of live sessions are never collected.
        Returns how many were removed."""
        now = now if now is not None else time.time()
        cutoff = now - config.LABEL_GC_DAYS * 86400
        live = set(live_uids)
        labels = self.state['labels']
        stale = [uid for uid, entry in labels.items()
                 if uid not in live and entry['last_seen'] < cutoff]
        for uid in stale:
            del labels[uid]
        if stale:
            self._dirty_at = now
        return len(stale)

    def _normalize_muted(self):
        muted = self.state.get('muted')
        if not isinstance(muted, dict):
            muted = {}
        self.state['muted'] = {uid: True for uid, v in muted.items()
                               if isinstance(uid, str) and v is True}

    def _normalize_projects(self):
        projects = self.state.get('projects')
        if not isinstance(projects, list):
            self.state['projects'] = list(DEFAULTS['projects'])
            return
        projects = [p if isinstance(p, str) else '' for p in projects]
        projects = projects[:PROJECT_SLOTS]
        projects += [''] * (PROJECT_SLOTS - len(projects))
        self.state['projects'] = projects

    # ---- accessors ----

    def get(self, key):
        return self.state.get(key, DEFAULTS.get(key))

    def set(self, key, value, now=None):
        if self.state.get(key) == value:
            return
        self.state[key] = value
        self._dirty_at = now if now is not None else time.time()

    def label(self, uid):
        entry = self.state['labels'].get(uid)
        return entry.get('label', '') if isinstance(entry, dict) else ''

    def set_label(self, uid, label, now=None):
        now = now if now is not None else time.time()
        if label:
            self.state['labels'][uid] = {'label': label,
                                         'last_seen': int(now)}
        else:
            self.state['labels'].pop(uid, None)
        self._dirty_at = now

    def muted(self, uid):
        return bool(self.state.get('muted', {}).get(uid))

    def set_muted(self, uid, value, now=None):
        muted = self.state.setdefault('muted', {})
        if bool(value) == bool(muted.get(uid)):
            return
        if value:
            muted[uid] = True
        else:
            muted.pop(uid, None)
        self._dirty_at = now if now is not None else time.time()

    def project(self, index):
        """1-based slot text (1-5), '' if empty or out of range."""
        projects = self.state.get('projects') or []
        if 1 <= index <= len(projects):
            return projects[index - 1]
        return ''

    def set_project(self, index, text, now=None):
        if not 1 <= index <= PROJECT_SLOTS:
            return
        if self.state['projects'][index - 1] == text:
            return
        self.state['projects'][index - 1] = text
        self._dirty_at = now if now is not None else time.time()

    def clear_projects(self, now=None):
        self.state['projects'] = [''] * PROJECT_SLOTS
        self._dirty_at = now if now is not None else time.time()

    def touch_labels(self, uids, now=None):
        """Refresh last_seen for labeled sessions that are still alive,
        and persist it (at most every LABEL_TOUCH_SECONDS per label)."""
        now = now if now is not None else time.time()
        for uid in uids:
            entry = self.state['labels'].get(uid)
            if isinstance(entry, dict) and now - entry['last_seen'] >= LABEL_TOUCH_SECONDS:
                entry['last_seen'] = int(now)
                self._dirty_at = now

    # ---- saving ----

    def maybe_save(self, now=None):
        """Save if dirty and the debounce window has passed."""
        now = now if now is not None else time.time()
        if self._dirty_at is not None and now - self._dirty_at >= SAVE_DEBOUNCE:
            self.save()

    def save(self):
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            fd, tmp = tempfile.mkstemp(
                dir=os.path.dirname(self.path), prefix='.state-')
            try:
                with os.fdopen(fd, 'w', encoding='utf-8') as f:
                    json.dump(self.state, f, indent=2)
                os.replace(tmp, self.path)
            except Exception:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
            self._dirty_at = None
        except Exception:
            pass  # persistence is best-effort; never crash the engine
