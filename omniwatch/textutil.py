"""Curses-free text helpers shared with the web client.

Ported from the non-curses parts of ultrawatch_lib/ui/draw.py
(docs/DESIGN.md §4.2): `tail_lines`/`is_chrome`/`fuzzy_match`/`age_str`
are ported here *and* to web/js/preview.js, fuzzy.js, and format.js, and
tested against the same fixtures (tests/fixtures/) so the Python and JS
implementations can't drift apart.
"""

_CHROME_PREFIXES = ('⏵⏵',)


def is_chrome(line):
    """True if `line` is agent-CLI "chrome" (input-box divider, bare
    prompt, model/footer line) rather than real screen content."""
    s = line.strip()
    if not s or s == '❯':
        return True
    if set(s) <= {'─', '━'}:
        return True
    if s.startswith(_CHROME_PREFIXES):
        return True
    if '% remaining]' in s:
        return True
    return False


def strip_chrome_lines(lines, max_lines=8):
    """Drop up to `max_lines` trailing chrome lines (see is_chrome), then
    any trailing blank lines they uncovered. `lines` is a list, already
    right-trimmed; returns a new list."""
    lines = list(lines)
    stripped = 0
    while lines and stripped < max_lines and is_chrome(lines[-1]):
        lines.pop()
        stripped += 1
    while lines and not lines[-1]:
        lines.pop()
    return lines


def tail_lines(text, n, width, strip_chrome=False):
    """Last n non-trailing-blank screen lines, each clipped to width.

    strip_chrome drops trailing agent-CLI furniture (see
    strip_chrome_lines) so tiny previews show real content.
    """
    lines = [l.rstrip() for l in text.split('\n')]
    while lines and not lines[-1]:
        lines.pop()
    if strip_chrome:
        lines = strip_chrome_lines(lines)
    return [l[:max(0, width)] for l in lines[-n:]] if n > 0 else []


def age_str(seconds):
    seconds = max(0, int(seconds))
    if seconds < 60:
        return f'{seconds}s'
    if seconds < 3600:
        return f'{seconds // 60}m'
    if seconds < 86400:
        return f'{seconds // 3600}h'
    return f'{seconds // 86400}d'


def fuzzy_match(needle, haystack):
    """Case-insensitive subsequence match. Returns True/False."""
    if not needle:
        return True
    needle = needle.lower()
    haystack = haystack.lower()
    pos = 0
    for ch in needle:
        pos = haystack.find(ch, pos)
        if pos < 0:
            return False
        pos += 1
    return True
