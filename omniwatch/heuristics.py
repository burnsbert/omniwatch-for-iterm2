"""Screen-text change detection and agent busy/waiting classification.

Ported verbatim from ultrawatch_lib/heuristics.py, plus two additions
for Omniwatch (see docs/DESIGN.md §4.2):

- ``extract_prompt(kind, text)`` — pulls the question and selectable
  options out of an agent's current screen so the preview can offer
  quick-reply buttons (§3 "Quick reply").
- ``SessionTracker.history(uid)`` — a bounded ring buffer of
  (at, state) transitions per session, read by the P1 activity timeline.

The classifier scans the last screen lines bottom-up and the first
matching rule wins, so the most recent marker decides the state (an old
answered permission prompt higher up can't shadow an active spinner
below it, and vice versa).

These patterns track the current Claude Code / Codex CLI rendering and
will need maintenance as those UIs evolve. Run with OW_DEBUG_STATE=1 (or
UW_DEBUG_STATE=1) to see which rule matched in the preview footer.
"""
import re
import zlib
from collections import deque

# Session states
BUSY = 'busy'          # agent is generating / running
WAITING = 'waiting'    # agent needs user input — attention!
IDLE = 'idle'          # agent at rest at its input box
ACTIVE = 'active'      # non-agent producing output
QUIET = 'quiet'        # non-agent at rest

# Spinner / decoration glyphs stripped before hashing so an animated
# spinner alone doesn't count as "the screen changed".
SPINNER_CHARS = '⠁⠂⠄⠈⠐⠠⡀⢀⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✢✻✽✶✳✣∗·'
_SPINNER_RE = re.compile('[%s]' % re.escape(SPINNER_CHARS))

SCAN_LINES = 25  # how many trailing non-blank lines the classifier reads

# Ordered rule tables: scanned bottom-up, first match wins.
# (name, regex, state)
CLAUDE_RULES = (
    # Permission / question menus: "❯ 1. Yes" selected option
    ('menu-option', re.compile(r'❯ \d+\.\s'), WAITING),
    ('permission-question', re.compile(
        r'Do you want|Would you like to|tell Claude what to do differently'),
     WAITING),
    # Generating: status line while streaming / running tools
    ('esc-to-interrupt', re.compile(r'esc to interrupt', re.I), BUSY),
    # Spinner verb lines like "✢ Ruminating…" (completion lines such as
    # "✻ Worked for 11s" have no ellipsis and must not match)
    ('spinner-verb', re.compile(
        r'^\s*[✢✻✽✶✳✣∗·⠀-⣿]\s+\S.*(…|\.\.\.)'), BUSY),
)

CODEX_RULES = (
    ('approval-prompt', re.compile(
        r'Allow command\?|Would you like to|^\s*Yes \(y\)', re.M), WAITING),
    ('esc-to-interrupt', re.compile(r'esc to interrupt', re.I), BUSY),
    ('working', re.compile(r'^\s*[•✶]?\s*Working\b'), BUSY),
)

RULES_BY_AGENT = {'claude': CLAUDE_RULES, 'codex': CODEX_RULES}

DEBOUNCE_COUNT = 2  # consecutive identical classifications before publishing

HISTORY_MAXLEN = 256  # ring buffer size for SessionTracker.history() (P1)


def normalize(text):
    """Normalize screen text for change hashing."""
    lines = [_SPINNER_RE.sub('', line).rstrip() for line in text.split('\n')]
    while lines and not lines[-1]:
        lines.pop()
    return '\n'.join(lines)


def text_hash(text):
    return zlib.crc32(normalize(text).encode('utf-8', 'replace'))


def classify_agent(kind, text, is_processing):
    """Classify an agent session's screen. Returns (state, rule_name)."""
    rules = RULES_BY_AGENT.get(kind, CLAUDE_RULES)
    lines = [l for l in text.split('\n') if l.strip()][-SCAN_LINES:]
    for line in reversed(lines):
        for name, rx, state in rules:
            if rx.search(line):
                return state, name
    if is_processing:
        return BUSY, 'fallback-processing'
    return IDLE, 'fallback-idle'


# ---------------------------------------------------------------------
# Quick-reply prompt extraction (new for Omniwatch, §3 / §4.2)
# ---------------------------------------------------------------------

_CLAUDE_OPTION_RE = re.compile(r'^(❯\s*)?(\d+)\.\s*(.+?)\s*$')
_CODEX_OPTION_RE = re.compile(r'^(.+?)\s*\((\w+)\)\s*$')
_BOX_INNER_RE = re.compile(r'^\s*│(.*)│\s*$')


def _claude_box_lines(text):
    """Return the inner (border-stripped, whitespace-trimmed) lines of the
    *last* box-drawn panel in `text` (Claude renders permission/question
    prompts inside a ╭─╮/╰─╯ box). Empty if there's no box."""
    inner = []
    in_box = False
    for line in text.split('\n'):
        if '╭' in line:
            inner = []
            in_box = True
            continue
        if '╰' in line:
            in_box = False
            continue
        if in_box:
            m = _BOX_INNER_RE.match(line)
            if m:
                inner.append(m.group(1).strip())
    return inner


def _claude_prompt(text):
    lines = _claude_box_lines(text)
    options = []
    question = ''
    for line in lines:
        m = _CLAUDE_OPTION_RE.match(line)
        if m:
            marker, key, label = m.groups()
            options.append({'key': key, 'label': label,
                            'selected': bool(marker)})
        elif not question and '?' in line:
            question = line
    if not options or not question:
        return None
    return {'question': question, 'options': options, 'free_text': False}


def _codex_prompt(text):
    lines = [l.strip() for l in text.split('\n')]
    while lines and not lines[-1]:
        lines.pop()
    i = len(lines) - 1
    options = []
    while i >= 0:
        m = _CODEX_OPTION_RE.match(lines[i])
        if not m:
            break
        options.append({'key': m.group(2), 'label': m.group(1),
                        'selected': False})
        i -= 1
    options.reverse()
    if not options:
        return None
    while i >= 0 and not lines[i]:
        i -= 1
    question = lines[i] if i >= 0 and '?' in lines[i] else ''
    if not question:
        return None
    return {'question': question, 'options': options, 'free_text': False}


def extract_prompt(kind, text):
    """Pull the current question/options out of an agent's screen for
    quick reply. Returns None when no prompt is currently displayed.

    Claude: scans the last box-drawn panel for `❯? N. text` option lines
    (the ❯ marks the currently-selected option) and a `...?` question
    line inside the same panel.
    Codex: scans the trailing `Label (key)` lines (e.g. "Yes (y)") and
    the nearest preceding `...?` line above them.
    """
    if kind == 'codex':
        return _codex_prompt(text)
    return _claude_prompt(text)


class _Track:
    __slots__ = ('state', 'state_since', 'rule', 'candidate', 'candidate_n',
                 'hash', 'last_change', 'attention', 'history')

    def __init__(self):
        self.state = None
        self.state_since = 0.0
        self.rule = ''
        self.candidate = None
        self.candidate_n = 0
        self.hash = None
        self.last_change = 0.0
        self.attention = False
        self.history = deque(maxlen=HISTORY_MAXLEN)


class SessionTracker:
    """Per-session derived state: change times, debounced agent states,
    and latched attention flags. Single-threaded (engine thread only)."""

    def __init__(self):
        self._tracks = {}  # uid -> _Track

    def update(self, sessions, agent_kinds, now):
        """Process a new iTerm snapshot.

        sessions: iterable of SessionInfo
        agent_kinds: {tty: 'claude'|'codex'} for sessions running an agent
        now: time.time()
        Returns list of (uid, old_state, new_state) published transitions.
        """
        events = []
        seen = set()
        for s in sessions:
            seen.add(s.uid)
            tr = self._tracks.get(s.uid)
            if tr is None:
                tr = self._tracks[s.uid] = _Track()

            h = text_hash(s.text)
            if tr.hash is None or h != tr.hash:
                tr.hash = h
                tr.last_change = now

            kind = agent_kinds.get(s.tty)
            if kind:
                raw, rule = classify_agent(kind, s.text, s.is_processing)
            elif s.is_processing or now - tr.last_change < 5:
                raw, rule = ACTIVE, 'non-agent'
            else:
                raw, rule = QUIET, 'non-agent'

            published = self._debounce(tr, raw, rule, now)
            if published:
                old, new = published
                events.append((s.uid, old, new))
                tr.history.append((now, new))
                if new == WAITING:
                    tr.attention = True
                elif tr.attention:
                    tr.attention = False
        for uid in list(self._tracks):
            if uid not in seen:
                del self._tracks[uid]
        return events

    def _debounce(self, tr, raw, rule, now):
        """Returns (old, new) when a state change is published, else None."""
        if tr.state is None:  # first observation publishes immediately
            tr.state, tr.rule, tr.state_since = raw, rule, now
            tr.candidate, tr.candidate_n = None, 0
            tr.history.append((now, raw))
            if raw == WAITING:
                tr.attention = True
            return None
        if raw == tr.state:
            tr.rule = rule
            tr.candidate, tr.candidate_n = None, 0
            return None
        if raw == tr.candidate:
            tr.candidate_n += 1
        else:
            tr.candidate, tr.candidate_n = raw, 1
        if tr.candidate_n >= DEBOUNCE_COUNT:
            old = tr.state
            tr.state, tr.rule, tr.state_since = raw, rule, now
            tr.candidate, tr.candidate_n = None, 0
            return (old, raw)
        return None

    # ---- queries (return safe defaults for unknown uids) ----

    def state(self, uid):
        tr = self._tracks.get(uid)
        return (tr.state, tr.state_since, tr.rule) if tr else (None, 0.0, '')

    def last_change(self, uid):
        tr = self._tracks.get(uid)
        return tr.last_change if tr else 0.0

    def has_attention(self, uid):
        tr = self._tracks.get(uid)
        return bool(tr and tr.attention)

    def visit(self, uid):
        tr = self._tracks.get(uid)
        if tr:
            tr.attention = False

    def waiting_uids(self):
        """uids currently WAITING, longest-waiting first."""
        out = [(tr.state_since, uid) for uid, tr in self._tracks.items()
               if tr.state == WAITING]
        return [uid for _, uid in sorted(out)]

    def attention_count(self):
        return sum(1 for tr in self._tracks.values() if tr.state == WAITING)

    def seed(self, uid, state_since=None, last_change=None):
        """Move a tracked session's state_since / last_change *earlier*
        (demo history seeding; never later). Returns True if uid is
        tracked."""
        tr = self._tracks.get(uid)
        if tr is None:
            return False
        if state_since is not None and state_since < tr.state_since:
            tr.state_since = state_since
        if last_change is not None and last_change < tr.last_change:
            tr.last_change = last_change
        return True

    def history(self, uid):
        """Return the (at, state) ring buffer for `uid`, oldest first, as
        a tuple. Empty for unknown uids (P1 activity timeline, §3)."""
        tr = self._tracks.get(uid)
        return tuple(tr.history) if tr else ()
