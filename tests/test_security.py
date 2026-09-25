"""New (docs/DESIGN.md §4.5, docs/SHELL_CONTRACT.md §4): token, cookie,
Host and Origin checks."""
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _support import TripwireTestCase

from omniwatch import security

PORT = 53817
TOKEN = 'tok_EN-123'


def hdrs(**kw):
    out = {'Host': '127.0.0.1:%d' % PORT}
    out.update({k.replace('_', '-'): v for k, v in kw.items() if v is not None})
    for k in [k for k, v in kw.items() if v is None]:
        out.pop(k.replace('_', '-'), None)
    return out


class TestToken(TripwireTestCase):
    def test_new_token_shape(self):
        t = security.new_token()
        self.assertEqual(len(t), 43)
        self.assertRegex(t, r'^[A-Za-z0-9_-]+$')
        self.assertNotEqual(t, security.new_token())

    def test_tokens_equal(self):
        self.assertTrue(security.tokens_equal(TOKEN, TOKEN))
        self.assertFalse(security.tokens_equal('nope', TOKEN))
        self.assertFalse(security.tokens_equal('', TOKEN))
        self.assertFalse(security.tokens_equal(None, TOKEN))
        self.assertFalse(security.tokens_equal(TOKEN, ''))
        self.assertFalse(security.tokens_equal('tök', 'tök'))   # non-ASCII never matches


class TestHeaders(TripwireTestCase):
    def test_host(self):
        self.assertTrue(security.host_ok({'Host': '127.0.0.1:%d' % PORT}, PORT))
        self.assertTrue(security.host_ok({'Host': 'localhost:%d' % PORT}, PORT))
        for bad in ('evil.com', '127.0.0.1', '127.0.0.1:1', 'localhost', None,
                    'evil.com:%d' % PORT, '0.0.0.0:%d' % PORT):
            self.assertFalse(security.host_ok({'Host': bad}, PORT), bad)

    def test_bearer(self):
        self.assertEqual(security.bearer_token({'Authorization': 'Bearer abc'}), 'abc')
        self.assertEqual(security.bearer_token({'Authorization': 'bearer abc '}), 'abc')
        self.assertIsNone(security.bearer_token({'Authorization': 'Basic abc'}))
        self.assertIsNone(security.bearer_token({'Authorization': 'Bearer '}))
        self.assertIsNone(security.bearer_token({}))

    def test_cookie(self):
        self.assertEqual(security.cookie_token({'Cookie': 'a=1; ow_session=xyz; b=2'}), 'xyz')
        self.assertIsNone(security.cookie_token({'Cookie': 'ow_sessionx=1; ow_session'}))
        self.assertIsNone(security.cookie_token({'Cookie': 'ow_session='}))
        self.assertIsNone(security.cookie_token({}))

    def test_authenticated(self):
        self.assertTrue(security.authenticated({'Authorization': 'Bearer ' + TOKEN}, TOKEN))
        self.assertTrue(security.authenticated({'Cookie': 'ow_session=' + TOKEN}, TOKEN))
        self.assertFalse(security.authenticated({'Authorization': 'Bearer x',
                                                 'Cookie': 'ow_session=y'}, TOKEN))
        self.assertFalse(security.authenticated({}, TOKEN))

    def test_origin_rules(self):
        bearer = {'Authorization': 'Bearer ' + TOKEN}
        cookie = {'Cookie': 'ow_session=' + TOKEN}
        o = 'http://127.0.0.1:%d' % PORT
        self.assertTrue(security.origin_ok('GET', {}, PORT, TOKEN))
        self.assertTrue(security.origin_ok('HEAD', {'Origin': 'http://evil'}, PORT, TOKEN))
        self.assertTrue(security.origin_ok('POST', bearer, PORT, TOKEN))       # shell
        self.assertFalse(security.origin_ok('POST', cookie, PORT, TOKEN))      # no Origin, cookie only
        self.assertTrue(security.origin_ok('POST', dict(cookie, Origin=o), PORT, TOKEN))
        self.assertTrue(security.origin_ok('PATCH', dict(cookie, Origin='http://localhost:%d' % PORT),
                                           PORT, TOKEN))
        self.assertFalse(security.origin_ok('POST', dict(bearer, Origin='http://evil.com'), PORT, TOKEN))
        self.assertFalse(security.origin_ok('DELETE', dict(cookie, Origin='null'), PORT, TOKEN))
        self.assertFalse(security.origin_ok('PUT', dict(cookie, Origin='http://127.0.0.1:1'), PORT, TOKEN))

    def test_check_api_order(self):
        good = {'Host': '127.0.0.1:%d' % PORT, 'Authorization': 'Bearer ' + TOKEN}
        self.assertIsNone(security.check_api('POST', good, PORT, TOKEN))
        self.assertEqual(security.check_api('GET', dict(good, Host='evil.com'), PORT, TOKEN)[:2],
                         (403, 'forbidden'))
        self.assertEqual(security.check_api('GET', {'Host': good['Host']}, PORT, TOKEN)[:2],
                         (401, 'unauthorized'))
        cookie_post = {'Host': good['Host'], 'Cookie': 'ow_session=' + TOKEN}
        self.assertEqual(security.check_api('POST', cookie_post, PORT, TOKEN)[:2],
                         (403, 'forbidden'))

    def test_session_cookie(self):
        c = security.session_cookie(TOKEN)
        self.assertEqual(c, 'ow_session=%s; HttpOnly; SameSite=Strict; Path=/' % TOKEN)

    def test_csp(self):
        for directive in ("default-src 'self'", "img-src 'self' data:", "style-src 'self'",
                          "script-src 'self'", "connect-src 'self'", "frame-ancestors 'none'"):
            self.assertIn(directive, security.CSP)
        self.assertNotIn('unsafe', security.CSP)
        self.assertTrue(re.match(r"^[^\n]+$", security.CSP))


if __name__ == '__main__':
    unittest.main()
