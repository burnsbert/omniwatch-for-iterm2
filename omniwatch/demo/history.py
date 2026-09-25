"""Seed data that makes demo mode's P1-promoted features look lived-in
(activity timeline ribbons, "blocked on you" stats, a stalled session,
usage sparklines + burn rate).

Everything is a pure function of (world, now): the same scenario, seed and
clock always produce the same history, so screenshots stay byte-stable.
The engine consumes it through ``providers.demo.seed_history()``,
``.seed_last_change()`` and ``.seed_usage_history()`` right after its first
poll (see ``Engine.apply_demo_seed``).
"""
import random
from datetime import datetime, timezone

from omniwatch import usage_claude, usage_codex
from omniwatch.demo.usage_payloads import claude_usage_payload, codex_usage_payload

HOURS = 8
MIN = 60

# Default scenario: hand-written timelines, (minutes ago, state), oldest
# first. The last state matches what the session's screen classifies as
# right now, so the ribbon ends where the live state begins.
DEFAULT_SCRIPTS = {
    'DEMO-0001': [(480, 'idle'), (430, 'busy'), (402, 'waiting'), (396, 'busy'),
                  (340, 'waiting'), (327, 'busy'), (250, 'idle'), (236, 'busy'),
                  (180, 'waiting'), (176, 'busy'), (95, 'waiting'), (89, 'busy'),
                  (41, 'idle'), (30, 'busy'), (4, 'waiting')],
    'DEMO-0002': [(470, 'busy'), (455, 'waiting'), (452, 'busy'), (390, 'idle'),
                  (300, 'busy'), (262, 'waiting'), (255, 'busy'), (150, 'waiting'),
                  (142, 'busy'), (60, 'waiting'), (58, 'busy')],
    'DEMO-0003': [(480, 'idle'), (350, 'busy'), (318, 'waiting'), (316, 'busy'),
                  (120, 'idle'), (90, 'busy'), (66, 'waiting'), (61, 'busy'),
                  (38, 'idle'), (14, 'busy')],
    'DEMO-0004': [(480, 'quiet')],
    'DEMO-0005': [(480, 'active')],
    'DEMO-0006': [(480, 'busy'), (420, 'waiting'), (409, 'busy'), (300, 'idle'),
                  (210, 'busy'), (172, 'waiting'), (169, 'busy'), (22, 'idle')],
    'DEMO-0007': [(480, 'idle'), (260, 'busy'), (233, 'waiting'), (229, 'busy'),
                  (110, 'waiting'), (101, 'busy'), (2, 'waiting')],
    'DEMO-0008': [(480, 'quiet')],
    'DEMO-0009': [(480, 'quiet')],
    'DEMO-0010': [(480, 'quiet')],
    'DEMO-0011': [(480, 'quiet')],
}

# Busy sessions whose screen hasn't changed for this long: they show as
# stalled right away (default stall threshold: 10 min).
STALLED = {'default': {'DEMO-0003': 14 * MIN + 20},
           'many': {'DEMO-MANY-004': 12 * MIN}}

# Screen -> the state the real classifier gives it (asserted in tests).
SCREEN_STATES = {
    'claude_waiting_bash': 'waiting', 'claude_waiting_billing': 'waiting',
    'claude_busy_spinner': 'busy', 'claude_busy_build': 'busy',
    'claude_idle': 'idle', 'codex_approval': 'waiting', 'codex_working': 'busy',
    'tail_log': 'active', 'quiet_shell': 'quiet', 'plain_idle': 'quiet',
    'vite_dev_server': 'quiet',
}

PROJECTS = {'default': ['api-gateway', 'billing', 'tools', '', '']}


def _generated(rng, final_state, agent, now):
    """A plausible 8 h random walk for an agent session ending in
    `final_state` (plain shells just hold their state)."""
    if not agent:
        return [(now - HOURS * 3600, final_state)]
    entries = []
    t = now - HOURS * 3600
    state = rng.choice(('idle', 'busy'))
    final_start = now - rng.uniform(2, 25) * MIN
    while t < final_start:
        entries.append((t, state))
        if state == 'busy':
            state = 'waiting' if rng.random() < 0.55 else 'idle'
            t += rng.uniform(15, 70) * MIN
        elif state == 'waiting':
            state = 'busy'
            t += rng.uniform(1, 12) * MIN
        else:
            state = 'busy'
            t += rng.uniform(10, 60) * MIN
    entries = [e for e in entries if e[0] < final_start]
    entries.append((final_start, final_state))
    return entries


def seed_history(world, now):
    """{uid: [(at, state), …]} for every live session."""
    out = {}
    rng = random.Random(world.seed * 1000003 + 11)
    for uid in world.order:
        s = world.sessions.get(uid)
        if s is None:
            continue
        script = DEFAULT_SCRIPTS.get(uid) if world.name == 'default' else None
        if script:
            out[uid] = [(now - minutes * MIN, state) for minutes, state in script]
        else:
            final = SCREEN_STATES.get(s.screen_key, 'quiet')
            out[uid] = _generated(rng, final, s.agent, now)
    return out


def seed_last_change(world, now):
    return {uid: now - age for uid, age in STALLED.get(world.name, {}).items()
            if uid in world.sessions}


def initial_state(world):
    labels = {uid: s.label for uid, s in world.sessions.items() if s.label}
    return {'labels': labels, 'projects': list(PROJECTS.get(world.name, [''] * 5))}


_WINDOW_SECONDS = {'5h': 5 * 3600, '7d': 7 * 86400, 'month': 30 * 86400}


def _pct_at(limit, t, now, rng_peak):
    """Sawtooth usage curve: the current cycle rises to today's pct at
    `now`; earlier cycles peak somewhere between 35 % and 95 %."""
    window = _WINDOW_SECONDS.get(limit['window'])
    resets = limit.get('resets_at')
    if not window or not resets:
        return None, None
    k = int((resets - t) // window)
    cycle_end = resets - k * window
    cycle_start = cycle_end - window
    if k == 0:
        span = max(1.0, now - cycle_start)
        pct = limit['pct'] * max(0.0, (t - cycle_start) / span) ** 1.1
    else:
        pct = rng_peak(k) * ((t - cycle_start) / window) ** 1.1
    return round(min(100.0, pct), 1), int(cycle_end)


def seed_usage_history(world, now):
    """usage-history.jsonl entries for the last 7 days (hourly), then every
    15 min for the last 24 h, per provider. Empty when no agent runs or the
    scenario is about usage errors."""
    if world.usage_errors:
        return []
    kinds = set()
    for agents in world.agent_ttys().values():
        kinds |= set(agents)
    now_dt = datetime.fromtimestamp(now, timezone.utc)
    providers = []
    if 'claude' in kinds:
        providers.append(('claude', usage_claude.limits(
            claude_usage_payload(world.start_epoch, world.usage_jitter), now=now_dt)))
    if 'codex' in kinds:
        providers.append(('codex', usage_codex.limits(
            codex_usage_payload(world.start_epoch, world.usage_jitter), now=now_dt)))
    times = [now - 7 * 86400 + h * 3600 for h in range(7 * 24 - 24)]
    # stops one step before `now`: the live snapshot at `now` is recorded for real
    times += [now - 86400 + q * 900 for q in range(96)]
    out = []
    for provider, limits in providers:
        peaks = {}

        def peak(k, lid):
            key = (lid, k)
            if key not in peaks:
                peaks[key] = random.Random('%s:%s:%d' % (world.seed, lid, k)).uniform(35, 95)
            return peaks[key]
        for t in times:
            values = {}
            for limit in limits:
                pct, resets = _pct_at(limit, t, now, lambda k, lid=limit['id']: peak(k, lid))
                if pct is not None:
                    values[limit['id']] = [pct, resets]
            if values:
                out.append({'t': t, 'p': provider, 'l': values})
    return out
