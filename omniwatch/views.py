"""Pure JSON serializers for the HTTP API and SSE (docs/DESIGN.md §4.4.1).

Everything here is a function of its arguments: no clock reads, no I/O, no
module state. The engine (the only caller besides tests) passes in the
snapshots, the tracker (read-only queries), the store, and ``now``.

Model logic moved here from Ultrawatch's ``ui/app.py``: ``agent_kinds``,
``window_number``, ``tab_label``, ``session_path``, ``row_title`` and
``list_view.is_fresh`` (P-22..P-24, P-29).
"""
import copy
from datetime import datetime, timezone

from omniwatch import heuristics as H
from omniwatch import persist, usage_claude, usage_codex

PROJECT_COLORS = ('blue', 'purple', 'green', 'red', 'yellow')
DASHBOARD_BANNER = '▛▞ ULTRAWATCH'   # P-50: another Ultrawatch instance
FRESH_STARTUP_GRACE = 5              # P-29: ignore changes in the first 5 s

USAGE_PROVIDERS = {
    'claude': usage_claude.limits,
    'codex': usage_codex.limits,
}


def screen_hash(text):
    """P-10 change hash as 8 lowercase hex digits (spinners stripped)."""
    return '%08x' % H.text_hash(text)


def shorten(path, home):
    if home and path.startswith(home):
        return '~' + path[len(home):]
    return path


def agent_kinds(agents_snapshot):
    """{tty: 'claude'|'codex'}; Claude wins when both run on one TTY."""
    kinds = {}
    if agents_snapshot:
        for tty, agents in agents_snapshot.ttys:
            if 'claude' in agents:
                kinds[tty] = 'claude'
            elif 'codex' in agents:
                kinds[tty] = 'codex'
    return kinds


def agents_for(agents_snapshot, tty):
    if not agents_snapshot or not tty:
        return []
    return sorted(agents_snapshot.agents_for(tty))


def window_numbers(sessions):
    """{window_id: 1-based ordinal} in order of first appearance (P-22)."""
    numbers = {}
    for s in sessions:
        if s.window_id not in numbers:
            numbers[s.window_id] = len(numbers) + 1
    return numbers


def windows(sessions):
    return [{'id': wid, 'number': n}
            for wid, n in window_numbers(sessions).items()]


def tab_label(session, numbers):
    """'3' with a single window, '2.3' when several are open (P-22)."""
    if len(numbers) > 1:
        return '%d.%d' % (numbers.get(session.window_id, session.window_id),
                          session.tab_index)
    return str(session.tab_index)


def session_path(session, paths, agents_snapshot):
    """Shell-integration path, else the lsof cwd for the TTY (P-23)."""
    path = paths.get(session.uid, '')
    if not path and agents_snapshot and session.tty:
        for tty, cwd in agents_snapshot.tty_cwd:
            if tty == session.tty and cwd:
                return cwd
    return path


def row_title(label, path_display, name, uid):
    """label, else short path, else name, else uid[:8] (P-24)."""
    return label or path_display or name or uid[:8]


def is_dashboard(text):
    return DASHBOARD_BANNER in text.split('\n', 1)[0]


def fresh_until(state, last_change, started, now, fresh_seconds):
    """Epoch at which a "just finished" row stops being fresh, or None
    (P-29): not busy/waiting, changed after the startup grace, and the
    change is younger than `fresh_seconds`."""
    if state in (H.WAITING, H.BUSY):
        return None
    if last_change <= started + FRESH_STARTUP_GRACE:
        return None
    until = last_change + fresh_seconds
    return until if now < until else None


def project_slot(tab_color):
    """1-based project slot whose color equals `tab_color`, else None."""
    if tab_color in PROJECT_COLORS:
        return PROJECT_COLORS.index(tab_color) + 1
    return None


def is_stalled(state, last_change, now, stall_seconds):
    """Busy with an unchanged (spinner-normalized) screen for at least
    `stall_seconds` (0 disables)."""
    return bool(stall_seconds) and state == H.BUSY and \
        now - last_change >= stall_seconds


def session_view(s, *, numbers, paths, agents_snapshot, kinds, colors,
                 tracker, store, started, now, debug_rule, home,
                 fresh_seconds, activity=None, stall_seconds=0):
    """One Session object (§4.4.1). Screen text is not included here."""
    agent = kinds.get(s.tty)
    state, since, rule = tracker.state(s.uid)
    last_change = tracker.last_change(s.uid)
    path = session_path(s, paths, agents_snapshot)
    path_display = shorten(path, home)
    label = store.label(s.uid)
    tab_color = colors.get(s.uid)
    prompt = None
    if agent and state == H.WAITING:
        prompt = H.extract_prompt(agent, s.text)
    view = {
        'uid': s.uid,
        'window_id': s.window_id,
        'window_number': numbers.get(s.window_id, s.window_id),
        'tab_index': s.tab_index,
        'session_index': s.session_index,
        'tab_label': tab_label(s, numbers),
        'tty': s.tty,
        'name': s.name,
        'is_processing': s.is_processing,
        'path': path,
        'path_display': path_display,
        'agent': agent,
        'agents': agents_for(agents_snapshot, s.tty),
        'state': state,
        'state_since': since if state is not None else None,
        'attention': tracker.has_attention(s.uid),
        'last_change': last_change,
        'fresh_until': fresh_until(state, last_change, started, now,
                                   fresh_seconds),
        'label': label,
        'display_name': label or s.name,
        'title': row_title(label, path_display, s.name, s.uid),
        'tab_color': tab_color,
        'project': project_slot(tab_color),
        'muted': store.muted(s.uid),
        'is_dashboard': is_dashboard(s.text),
        'screen_hash': screen_hash(s.text),
        'prompt': prompt,
        'stalled': False,
        'stalled_since': None,
        'ribbon': activity.ribbon(s.uid, now) if activity is not None else None,
    }
    if is_stalled(state, last_change, now, stall_seconds):
        view['stalled'] = True
        view['stalled_since'] = last_change   # screen unchanged since
    if debug_rule:
        view['rule'] = rule
    return view


def build_sessions(sessions, **ctx):
    """Session objects in natural (snapshot) order."""
    numbers = window_numbers(sessions)
    kinds = agent_kinds(ctx.get('agents_snapshot'))
    return [session_view(s, numbers=numbers, kinds=kinds, **ctx)
            for s in sessions]


def summary(session_views, waiting_uids):
    live = {s['uid'] for s in session_views}
    return {
        'tabs': len(session_views),
        'agents': sum(1 for s in session_views if s['agent']),
        'waiting': sum(1 for s in session_views if s['state'] == H.WAITING),
        'busy': sum(1 for s in session_views if s['state'] == H.BUSY),
        'stalled': sum(1 for s in session_views if s.get('stalled')),
        'waiting_uids': [u for u in waiting_uids if u in live],
    }


def summary_endpoint(session_views, summ):
    """``GET /api/v1/summary`` (menu bar / plugin): waiting sessions
    longest-first."""
    by_uid = {s['uid']: s for s in session_views}
    waiting = []
    for uid in summ['waiting_uids']:
        s = by_uid[uid]
        waiting.append({'uid': uid, 'title': s['title'],
                        'since': s['state_since'], 'agent': s['agent']})
    return {'tabs': summ['tabs'], 'agents': summ['agents'],
            'waiting': summ['waiting'], 'busy': summ['busy'],
            'stalled': summ.get('stalled', 0), 'waiting_sessions': waiting}


def screens(sessions):
    return {s.uid: {'hash': screen_hash(s.text), 'text': s.text}
            for s in sessions}


def iterm_view(status, error, last_poll_at, poll_ms, stale,
              consecutive_failures=0, slow=False):
    return {'status': status, 'error': error, 'last_poll_at': last_poll_at,
            'poll_ms': poll_ms, 'stale': stale,
            'consecutive_failures': consecutive_failures, 'slow': slow}


def usage_block(kind, snap, show_dollars, now, stale_since=None,
                has_credentials=None, burn=None):
    """UsageBlock (§4.4.1) for 'claude' or 'codex'.

    status: ok | inactive | error | stale | no_credentials. `snap` is the
    latest UsageSnapshot (None before the first poll → inactive);
    `stale_since` is when fetches started failing with last-good data kept;
    `has_credentials` False turns a data-less failure into no_credentials.
    """
    block = {'status': 'inactive', 'fetched_at': None, 'stale_since': None,
             'limits': []}
    if snap is None or snap.inactive:
        return block
    block['fetched_at'] = snap.at
    if snap.data:
        now_dt = datetime.fromtimestamp(now, timezone.utc)
        block['limits'] = USAGE_PROVIDERS[kind](
            snap.data, show_dollars=show_dollars, now=now_dt)
        for limit in block['limits']:
            limit['burn'] = burn(limit['id']) if burn is not None else None
    if snap.ok:
        block['status'] = 'ok'
    elif snap.data:
        block['status'] = 'stale'
        block['stale_since'] = stale_since
    elif has_credentials is False:
        block['status'] = 'no_credentials'
    else:
        block['status'] = 'error'
    return block


def prefs(store):
    return {k: copy.deepcopy(store.get(k)) for k in sorted(persist.PREF_KEYS)}


def projects(store):
    return [{'slot': i + 1, 'name': store.project(i + 1), 'color': color}
            for i, color in enumerate(PROJECT_COLORS)]


def capabilities(tab_colors, quick_reply, debug_rule):
    return {'tab_colors': tab_colors, 'reply': bool(quick_reply),
            'debug_rule': bool(debug_rule)}
