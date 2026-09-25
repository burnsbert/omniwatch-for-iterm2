"""Per-launch token, auth cookie, and Host/Origin checks (docs/DESIGN.md §4.5,
docs/SHELL_CONTRACT.md §4).

Pure functions over a header mapping (anything with ``.get(name)``), so the
HTTP server and the tests share one implementation:

- The token is ``secrets.token_urlsafe(32)`` (43 chars of ``[A-Za-z0-9_-]``);
  it goes unescaped into a URL and a header.
- Accepted as ``Authorization: Bearer T`` or the ``ow_session`` cookie that
  ``GET /auth?token=T`` sets. Comparisons use ``hmac.compare_digest``.
- ``Host`` must be ``127.0.0.1:<port>`` or ``localhost:<port>`` (DNS
  rebinding defense).
- Non-GET requests need ``Origin`` equal to one of those origins, or no
  ``Origin`` at all plus a Bearer token (CSRF defense; the Swift shell sends
  Bearer without Origin).
"""
import hmac
import secrets

COOKIE_NAME = 'ow_session'

CSP = ("default-src 'self'; img-src 'self' data:; style-src 'self'; "
       "script-src 'self'; connect-src 'self'; frame-ancestors 'none'")

SAFE_METHODS = frozenset({'GET', 'HEAD'})


def new_token():
    return secrets.token_urlsafe(32)


def tokens_equal(given, token):
    """Constant-time comparison; False for None/empty or non-ASCII input."""
    if not given or not token:
        return False
    try:
        return hmac.compare_digest(given.encode('ascii'), token.encode('ascii'))
    except (UnicodeEncodeError, AttributeError):
        return False


def allowed_hosts(port):
    return ('127.0.0.1:%d' % port, 'localhost:%d' % port)


def allowed_origins(port):
    return tuple('http://' + h for h in allowed_hosts(port))


def host_ok(headers, port):
    return headers.get('Host') in allowed_hosts(port)


def bearer_token(headers):
    auth = headers.get('Authorization') or ''
    if auth[:7].lower() == 'bearer ':
        return auth[7:].strip() or None
    return None


def cookie_token(headers):
    for part in (headers.get('Cookie') or '').split(';'):
        name, sep, value = part.strip().partition('=')
        if sep and name == COOKIE_NAME:
            return value.strip() or None
    return None


def authenticated(headers, token):
    """True when the request carries the right Bearer token or cookie."""
    return (tokens_equal(bearer_token(headers), token) or
            tokens_equal(cookie_token(headers), token))


def origin_ok(method, headers, port, token):
    """CSRF rule for state-changing requests (§4.5)."""
    if method.upper() in SAFE_METHODS:
        return True
    origin = headers.get('Origin')
    if origin is None:
        return tokens_equal(bearer_token(headers), token)
    return origin in allowed_origins(port)


def check_api(method, headers, port, token):
    """Run every §4.5 check for an ``/api/*`` request.

    Returns None when the request may proceed, else ``(status, code,
    message)`` for the error response."""
    if not host_ok(headers, port):
        return (403, 'forbidden', 'bad Host header')
    if not authenticated(headers, token):
        return (401, 'unauthorized', 'missing or bad token')
    if not origin_ok(method, headers, port, token):
        return (403, 'forbidden', 'bad or missing Origin')
    return None


def session_cookie(token):
    return '%s=%s; HttpOnly; SameSite=Strict; Path=/' % (COOKIE_NAME, token)
