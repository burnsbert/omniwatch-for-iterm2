#!/usr/bin/env python3
"""Stub Omniwatch backend for the Swift shell's tests and --self-test (stdlib only).

Implements the slice of the DESIGN.md §4.3/§4.4/§4.5/§4.7 contract the shell relies on:

  fake_backend.py serve --ready-json --parent-pid PID [--log-file PATH] [--demo] [...ignored]

* prints one ready line on stdout once listening on 127.0.0.1:<random>:
  {"event":"ready","port":N,"token":"…","pid":N,"version":"1.0.0","demo":true}
* GET /auth?token=T → 302 to / with `ow_session=T; HttpOnly; SameSite=Strict; Path=/`
* /api/* needs `Authorization: Bearer T` or the cookie; Host must be 127.0.0.1:<port> or
  localhost:<port>; non-GET needs Origin == that origin, or no Origin plus Bearer
* GET /api/v1/events: SSE `hello`, then `state` (fixtures/state.json), `: ping` heartbeats
* GET /api/v1/health, /state, /summary; POST /sessions/{uid}/goto (202 + `action` event);
  PATCH /api/v1/prefs (200 + `prefs` event); POST /api/v1/shutdown (200, then exits)
* exits when stdin hits EOF or the parent pid changes (checked every 2 s)

Knobs (env): FAKE_BACKEND_MODE = normal | crash | crash-after-ready | garbage | silent |
stubborn (ignores /shutdown, SIGTERM and stdin EOF); FAKE_BACKEND_TRANSITION_AFTER = seconds
after an SSE connect to emit a busy→waiting `transition`; FAKE_BACKEND_PING = heartbeat
seconds (default 15); FAKE_BACKEND_RECORD = path to append one JSON line per request;
FAKE_BACKEND_SSE_CLOSE_AFTER = seconds after which each SSE response is closed (reconnect tests).
"""
import argparse
import hmac
import json
import os
import queue
import secrets
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
VERSION = "1.0.0"
MODE = os.environ.get("FAKE_BACKEND_MODE", "normal")
PING = float(os.environ.get("FAKE_BACKEND_PING", "15"))
TRANSITION_AFTER = os.environ.get("FAKE_BACKEND_TRANSITION_AFTER")
RECORD = os.environ.get("FAKE_BACKEND_RECORD")
SSE_CLOSE_AFTER = os.environ.get("FAKE_BACKEND_SSE_CLOSE_AFTER")

with open(os.path.join(HERE, "fixtures", "state.json"), encoding="utf-8") as f:
    STATE = json.load(f)

LOCK = threading.Lock()
CLIENTS = []  # per-SSE-client queues
SEQ = [STATE["seq"]]
ACTION_N = [0]
SHUTDOWN = threading.Event()


def log(msg):
    sys.stderr.write("fake_backend: %s\n" % msg)
    sys.stderr.flush()


def next_seq():
    with LOCK:
        SEQ[0] += 1
        return SEQ[0]


def broadcast(event, data):
    seq = next_seq()
    with LOCK:
        for q in list(CLIENTS):
            try:
                q.put_nowait((seq, event, data))
            except queue.Full:
                pass


class Handler(BaseHTTPRequestHandler):
    server_version = "OmniwatchFake/1.0"
    protocol_version = "HTTP/1.0"  # SSE body is delimited by connection close

    def log_message(self, fmt, *args):  # keep stderr quiet
        pass

    # --- helpers ---------------------------------------------------------------
    def _record(self):
        if not RECORD:
            return
        entry = {"method": self.command, "path": self.path,
                 "authorization": self.headers.get("Authorization"),
                 "origin": self.headers.get("Origin"), "host": self.headers.get("Host"),
                 "cookie": self.headers.get("Cookie"),
                 "last_event_id": self.headers.get("Last-Event-ID")}
        with LOCK, open(RECORD, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")

    def _json(self, code, obj, extra=None):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _error(self, code, name, message):
        self._json(code, {"ok": False, "error": {"code": name, "message": message}})

    def _origin(self):
        return "http://127.0.0.1:%d" % self.server.server_port

    def _host_ok(self):
        port = self.server.server_port
        return self.headers.get("Host") in ("127.0.0.1:%d" % port, "localhost:%d" % port)

    def _bearer(self):
        auth = self.headers.get("Authorization") or ""
        return auth[7:] if auth.startswith("Bearer ") else None

    def _cookie_token(self):
        for part in (self.headers.get("Cookie") or "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == "ow_session":
                return v
        return None

    def _authed(self):
        tok = self.server.token
        b = self._bearer()
        if b is not None and hmac.compare_digest(b, tok):
            return True
        c = self._cookie_token()
        return c is not None and hmac.compare_digest(c, tok)

    def _guard(self):
        """Host, auth and Origin checks. Returns True if the request may proceed."""
        if not self._host_ok():
            self._error(403, "forbidden", "bad Host")
            return False
        if not self._authed():
            self._error(401, "unauthorized", "missing or bad token")
            return False
        if self.command != "GET":
            origin = self.headers.get("Origin")
            if origin is None:
                if self._bearer() is None:
                    self._error(403, "forbidden", "Origin required without Bearer")
                    return False
            elif origin not in (self._origin(), "http://localhost:%d" % self.server.server_port):
                self._error(403, "forbidden", "bad Origin")
                return False
        return True

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except ValueError:
            return None

    # --- routes -----------------------------------------------------------------
    def do_GET(self):
        self._record()
        url = urlsplit(self.path)
        if url.path == "/auth":
            if not self._host_ok():
                return self._error(403, "forbidden", "bad Host")
            tok = (parse_qs(url.query).get("token") or [""])[0]
            if not hmac.compare_digest(tok, self.server.token):
                return self._error(401, "unauthorized", "bad token")
            self.send_response(302)
            self.send_header("Location", "/")
            self.send_header("Set-Cookie", "ow_session=%s; HttpOnly; SameSite=Strict; Path=/" % tok)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if url.path == "/":
            body = (b"<!doctype html><meta charset=utf-8><title>Omniwatch (fake backend)</title>"
                    b"<h1>Omniwatch fake backend</h1>")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if not url.path.startswith("/api/"):
            return self._error(404, "not_found", url.path)
        if not self._guard():
            return
        if url.path == "/api/v1/health":
            return self._json(200, {"ok": True, "version": VERSION, "demo": self.server.demo,
                                    "pid": os.getpid(), "uptime_s": time.time() - self.server.started})
        if url.path == "/api/v1/state":
            return self._json(200, dict(STATE, seq=SEQ[0]))
        if url.path == "/api/v1/summary":
            s = STATE["summary"]
            waiting = [{"uid": x["uid"], "title": x["title"], "since": x["state_since"], "agent": x["agent"]}
                       for x in STATE["sessions"] if x["state"] == "waiting"]
            return self._json(200, {"tabs": s["tabs"], "agents": s["agents"], "waiting": s["waiting"],
                                    "busy": s["busy"], "waiting_sessions": waiting})
        if url.path == "/api/v1/events":
            return self._sse()
        return self._error(404, "not_found", url.path)

    def do_POST(self):
        self._record()
        url = urlsplit(self.path)
        if not url.path.startswith("/api/"):
            return self._error(404, "not_found", url.path)
        if not self._guard():
            return
        body = self._body()
        if body is None:
            return self._error(400, "bad_request", "invalid JSON")
        parts = url.path.split("/")
        if url.path == "/api/v1/shutdown":
            self._json(200, {"ok": True})
            if MODE != "stubborn":
                SHUTDOWN.set()
            return
        if len(parts) == 6 and parts[3] == "sessions" and parts[5] == "goto":
            uid = parts[4]
            if not any(s["uid"] == uid for s in STATE["sessions"]):
                return self._error(404, "not_found", "session not found")
            ACTION_N[0] += 1
            aid = "a-%d" % ACTION_N[0]
            self._json(202, {"ok": True, "action_id": aid})
            broadcast("action", {"id": aid, "kind": "goto", "uid": uid, "ok": True, "detail": "→ tab"})
            return
        return self._error(404, "not_found", url.path)

    def do_PATCH(self):
        self._record()
        url = urlsplit(self.path)
        if not self._guard():
            return
        if url.path != "/api/v1/prefs":
            return self._error(404, "not_found", url.path)
        body = self._body()
        if not isinstance(body, dict):
            return self._error(400, "bad_request", "invalid JSON")
        prefs = STATE["prefs"]
        for k, v in body.items():
            if k not in prefs or type(v) is not type(prefs[k]):
                return self._error(422, "invalid", "bad pref %s" % k)
        prefs.update(body)
        self._json(200, prefs)
        broadcast("prefs", {"seq": SEQ[0], "prefs": prefs, "projects": STATE["projects"]})

    def _sse(self):
        q = queue.Queue(maxsize=256)
        with LOCK:
            CLIENTS.append(q)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        def send(seq, event, data):
            payload = "id: %d\nevent: %s\ndata: %s\n\n" % (seq, event, json.dumps(data))
            self.wfile.write(payload.encode("utf-8"))
            self.wfile.flush()

        try:
            send(SEQ[0], "hello", {"version": VERSION, "server_time": time.time(), "demo": self.server.demo})
            send(SEQ[0], "state", dict(STATE, seq=SEQ[0]))
            if TRANSITION_AFTER is not None:
                def later():
                    time.sleep(float(TRANSITION_AFTER))
                    s = STATE["sessions"][0]
                    q.put((next_seq(), "transition",
                           {"uid": s["uid"], "from": "busy", "to": "waiting", "at": time.time(),
                            "title": s["title"], "agent": s["agent"],
                            "prompt": {"question": "Allow edit?", "options": [], "free_text": False},
                            "muted": False}))
                threading.Thread(target=later, daemon=True).start()
            deadline = time.time() + float(SSE_CLOSE_AFTER) if SSE_CLOSE_AFTER else None
            while not SHUTDOWN.is_set():
                timeout = PING
                if deadline is not None:
                    timeout = min(PING, deadline - time.time())
                    if timeout <= 0:
                        break
                try:
                    seq, event, data = q.get(timeout=timeout)
                    send(seq, event, data)
                except queue.Empty:
                    if deadline is not None and time.time() >= deadline:
                        break
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with LOCK:
                if q in CLIENTS:
                    CLIENTS.remove(q)


def watch_parent(parent_pid):
    while not SHUTDOWN.is_set():
        if parent_pid and os.getppid() != parent_pid:
            log("parent changed; exiting")
            SHUTDOWN.set()
        SHUTDOWN.wait(2)


def watch_stdin():
    # os.read, not sys.stdin.buffer.read: a daemon thread blocked inside the buffered reader
    # holds its lock, and Python 3.13 aborts at interpreter shutdown ("Fatal Python error:
    # _enter_buffered_busy", exit status 134/SIGABRT).
    try:
        while os.read(0, 4096):
            pass
    except OSError:
        pass
    if MODE != "stubborn":
        log("stdin EOF; exiting")
        SHUTDOWN.set()


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["serve"])
    ap.add_argument("--ready-json", action="store_true")
    ap.add_argument("--parent-pid", type=int, default=0)
    ap.add_argument("--log-file")
    ap.add_argument("--demo", action="store_true")
    ap.add_argument("--port", type=int, default=0)
    args, _unknown = ap.parse_known_args(argv)

    if MODE == "crash":
        log("crashing on purpose")
        return 3
    if MODE == "silent":
        time.sleep(3600)
        return 0
    if MODE == "garbage":
        print("Traceback (most recent call last): not a ready line", flush=True)
        time.sleep(3600)
        return 0
    if MODE == "stubborn":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    server.token = secrets.token_urlsafe(32)
    server.demo = bool(args.demo)
    server.started = time.time()
    threading.Thread(target=server.serve_forever, daemon=True).start()
    threading.Thread(target=watch_parent, args=(args.parent_pid,), daemon=True).start()
    threading.Thread(target=watch_stdin, daemon=True).start()

    if args.ready_json:
        sys.stdout.write(json.dumps({"event": "ready", "port": server.server_port, "token": server.token,
                                     "pid": os.getpid(), "version": VERSION, "demo": server.demo},
                                    separators=(",", ":")) + "\n")
        sys.stdout.flush()

    if MODE == "crash-after-ready":
        time.sleep(0.3)
        log("crashing after ready on purpose")
        os._exit(5)

    SHUTDOWN.wait()
    time.sleep(0.1)  # let the /shutdown response flush
    server.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
