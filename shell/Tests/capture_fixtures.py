#!/usr/bin/env python3
"""Capture real backend payloads for the Swift shell's Models tests (stdlib only).

Runs `python3 -m omniwatch serve --demo --ready-json --demo-clock … --demo-seed 7` from the
repo (always demo mode, throwaway OMNIWATCH_CONFIG_DIR), then writes to
shell/Tests/fixtures/real/:

  ready.json    the ready line
  health.json   GET /api/v1/health
  summary.json  GET /api/v1/summary
  state.json    GET /api/v1/state
  events.txt    raw SSE bytes: hello + state, then whatever /demo/step, a goto, and a
                prefs PATCH produce (transition, sessions, screens, action, prefs, stall, …)

Usage: python3 shell/Tests/capture_fixtures.py [--python PY] [--out DIR]
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
CLOCK = "1790000000"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--python", default=sys.executable)
    ap.add_argument("--out", default=os.path.join(HERE, "fixtures", "real"))
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    with tempfile.TemporaryDirectory() as cfg:
        env = dict(os.environ, OMNIWATCH_CONFIG_DIR=cfg, OMNIWATCH_DEMO="1", PYTHONPATH=REPO)
        proc = subprocess.Popen(
            [args.python, "-m", "omniwatch", "serve", "--demo", "--ready-json",
             "--demo-clock", CLOCK, "--demo-seed", "7", "--parent-pid", str(os.getpid())],
            cwd=REPO, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        try:
            line = proc.stdout.readline().decode("utf-8")
            ready = json.loads(line)
            base = "http://127.0.0.1:%d" % ready["port"]
            auth = {"Authorization": "Bearer " + ready["token"]}

            def call(method, path, body=None):
                data = json.dumps(body).encode() if body is not None else None
                req = urllib.request.Request(base + path, data=data, method=method, headers=dict(auth))
                if data is not None:
                    req.add_header("Content-Type", "application/json")
                with urllib.request.urlopen(req, timeout=5) as r:
                    return json.loads(r.read().decode("utf-8"))

            def dump(name, obj):
                with open(os.path.join(args.out, name), "w", encoding="utf-8") as f:
                    json.dump(obj, f, indent=1, ensure_ascii=False, sort_keys=True)
                    f.write("\n")

            ready_redacted = dict(ready, token="T" * 43, pid=4242, port=53817)
            dump("ready.json", ready_redacted)
            dump("health.json", dict(call("GET", "/api/v1/health"), pid=4242, uptime_s=1.5))
            dump("summary.json", call("GET", "/api/v1/summary"))
            dump("state.json", call("GET", "/api/v1/state"))

            chunks = []
            req = urllib.request.Request(base + "/api/v1/events",
                                         headers=dict(auth, Accept="text/event-stream"))
            stream = urllib.request.urlopen(req, timeout=30)

            def reader():
                try:
                    while True:
                        b = stream.read1(65536)
                        if not b:
                            break
                        chunks.append(b)
                except Exception:
                    pass

            t = threading.Thread(target=reader, daemon=True)
            t.start()
            time.sleep(0.5)
            for seconds in (2, 6, 10, 700):  # timeline flips + a long step for stall detection
                call("POST", "/api/v1/demo/step", {"seconds": seconds})
                time.sleep(0.2)
            state = call("GET", "/api/v1/state")
            if state["sessions"]:
                uid = state["sessions"][0]["uid"]
                call("POST", "/api/v1/sessions/%s/goto" % uid)
            call("PATCH", "/api/v1/prefs", {"keep_on_top": True})
            time.sleep(0.8)
            stream.close()
            raw = b"".join(chunks).decode("utf-8")
            with open(os.path.join(args.out, "events.txt"), "w", encoding="utf-8") as f:
                f.write(raw)
            types = [l[7:] for l in raw.splitlines() if l.startswith("event: ")]
            print("captured %d events: %s" % (len(types), ", ".join(types)))
            call("POST", "/api/v1/shutdown")
            proc.wait(timeout=5)
            print("backend exit status", proc.returncode)
        finally:
            if proc.poll() is None:
                proc.kill()
    return 0


if __name__ == "__main__":
    sys.exit(main())
