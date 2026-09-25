import Foundation

/// Integration tests against `fake_backend.py` (a local python child on 127.0.0.1; no UI).
enum FakeBackend {
    static func launch(demo: Bool = true) -> BackendLaunch? {
        guard let py = TestPaths.python else { return nil }
        return BackendLaunch(python: py, program: [TestPaths.fakeBackend],
                             parentPid: ProcessInfo.processInfo.processIdentifier, logFile: nil, demo: demo)
    }

    static func env(_ extra: [String: String] = [:]) -> [String: String] {
        var e = ProcessInfo.processInfo.environment
        for k in e.keys where k.hasPrefix("FAKE_BACKEND_") { e.removeValue(forKey: k) }
        for (k, v) in extra { e[k] = v }
        return e
    }

    /// Starts a fake backend and waits for its ready line.
    static func start(_ extra: [String: String] = [:]) throws -> (BackendProcess, ReadyLine) {
        guard let l = launch() else { throw Unexpected(description: "no python3") }
        let p = BackendProcess(launch: l, environment: env(extra))
        var ready: ReadyLine?
        var exit: BackendProcess.Exit?
        p.onReady = { ready = $0 }
        p.onExit = { exit = $0 }
        try p.start()
        guard waitUntil(10, { ready != nil || exit != nil }), let r = ready else {
            p.stopAndWait(grace: 0.5)
            throw Unexpected(description: "fake backend not ready: \(String(describing: exit))")
        }
        return (p, r)
    }

    static func isAlive(_ pid: Int32) -> Bool { kill(pid, 0) == 0 }
}

enum BackendProcessTests {
    static func runUntilExit(_ mode: String, readyTimeout: TimeInterval = 10) throws -> BackendProcess.Exit? {
        guard let l = FakeBackend.launch() else { return nil }
        let p = BackendProcess(launch: l, environment: FakeBackend.env(["FAKE_BACKEND_MODE": mode]))
        p.readyTimeout = readyTimeout
        var exit: BackendProcess.Exit?
        p.onExit = { exit = $0 }
        try p.start()
        _ = waitUntil(readyTimeout + 5) { exit != nil }
        return exit
    }

    static let all: [TestCase] = [
        TestCase(name: "handshakeHealthAndShutdownSequence") {
            let (p, r) = try FakeBackend.start()
            checkEqual(r.demo, true)
            checkEqual(r.version, "1.0.0")
            checkEqual(p.pid, r.pid)
            check(p.isRunning)
            let api = BackendAPI(ready: r)
            let h = api.sendSync(api.healthRequest())
            checkEqual(h.status, 200)
            let body = h.body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            checkEqual(body?["ok"] as? Bool, true)
            // No token → 401 (the contract the shell relies on for detecting a stale token).
            var noAuth = api.healthRequest(); noAuth.setValue(nil, forHTTPHeaderField: "Authorization")
            checkEqual(api.sendSync(noAuth).status, 401)
            var shutdownStatus = 0
            var exit: BackendProcess.Exit?
            p.onExit = { exit = $0 }
            let t0 = Date()
            let done = p.stopAndWait(grace: 2) { shutdownStatus = api.sendSync(api.shutdownRequest()).status }
            check(done, "stop did not complete")
            check(Date().timeIntervalSince(t0) < 2, "POST /shutdown should exit before the SIGTERM stage")
            checkEqual(shutdownStatus, 200)
            _ = waitUntil(2) { exit != nil }
            checkEqual(exit, .requested(status: 0))
            check(!FakeBackend.isAlive(r.pid), "child still alive")
            check(!p.isRunning)
        },
        TestCase(name: "stopWithoutApiClosesStdinAndTerminates") {
            let (p, r) = try FakeBackend.start()
            check(p.stopAndWait(grace: 2))
            check(!FakeBackend.isAlive(r.pid))
        },
        TestCase(name: "stubbornBackendIsKilled") {
            let (p, r) = try FakeBackend.start(["FAKE_BACKEND_MODE": "stubborn"])
            let api = BackendAPI(ready: r)
            let t0 = Date()
            check(p.stopAndWait(grace: 0.5) { _ = api.sendSync(api.shutdownRequest()) })
            let dt = Date().timeIntervalSince(t0)
            check(dt >= 0.9 && dt < 3, "took \(dt)s; expected shutdown→SIGTERM→SIGKILL ≈ 2×grace")
            check(!FakeBackend.isAlive(r.pid))
        },
        TestCase(name: "crashBeforeReady") {
            guard let exit = try runUntilExit("crash") else { return }
            checkEqual(exit, .handshakeFailed("backend exited with status 3 before the ready line"))
        },
        TestCase(name: "garbageReadyLine") {
            guard let exit = try runUntilExit("garbage") else { return }
            checkEqual(exit, .handshakeFailed("ready line is not a JSON object"))
        },
        TestCase(name: "silentBackendTimesOut") {
            guard let exit = try runUntilExit("silent", readyTimeout: 1) else { return }
            checkEqual(exit, .handshakeFailed("no ready line within 1 s"))
        },
        TestCase(name: "crashAfterReady") {
            guard let exit = try runUntilExit("crash-after-ready") else { return }
            checkEqual(exit, .crashed(status: 5))
        },
        TestCase(name: "spawnFailureOfMissingInterpreter") {
            let p = BackendProcess(launch: BackendLaunch(python: "/nonexistent/python3", program: ["x"], parentPid: 1,
                                                         logFile: nil, demo: false))
            checkThrows { try p.start() }
        },
        TestCase(name: "supervisorRestartsThenGivesUp") {
            guard let l = FakeBackend.launch() else { return }
            let s = BackendSupervisor(makeLaunch: { l }, environment: FakeBackend.env(["FAKE_BACKEND_MODE": "crash"]),
                                      policy: RestartPolicy(delays: [0.1], maxRestarts: 2, window: 60))
            var seen: [String] = []
            s.onStatus = { st in
                switch st {
                case .starting: seen.append("starting")
                case .restarting: seen.append("restarting")
                case .failed: seen.append("failed")
                default: seen.append("\(st)")
                }
            }
            s.start()
            check(waitUntil(15) { seen.last == "failed" }, "\(seen)")
            checkEqual(seen, ["starting", "restarting", "starting", "restarting", "starting", "failed"])
            checkEqual(s.attempts, 3)
            if case .failed(let why) = s.status { check(why.contains("status 3"), why) }
            s.retry()
            checkEqual(seen.last, "starting")
            check(waitUntil(15) { s.status != .starting(attempt: 4) })
            s.stop()
        },
        TestCase(name: "supervisorRecoversFromCrashAfterReady") {
            guard let l = FakeBackend.launch() else { return }
            let s = BackendSupervisor(makeLaunch: { l }, environment: FakeBackend.env(["FAKE_BACKEND_MODE": "crash-after-ready"]),
                                      policy: RestartPolicy(delays: [0.1], maxRestarts: 5, window: 60))
            var readies: [ReadyLine] = []
            var restarts = 0
            s.onStatus = { st in
                if case .running(let r) = st { readies.append(r) }
                if case .restarting = st { restarts += 1 }
            }
            s.start()
            check(waitUntil(15) { readies.count >= 2 }, "readies \(readies.count)")
            check(restarts >= 1)
            if readies.count >= 2 { check(readies[0].token != readies[1].token, "new token per launch") }
            var stopped = false
            s.stop(completion: { stopped = true })
            check(waitUntil(5) { stopped })
            checkEqual(s.status, .stopped)
        },
        TestCase(name: "supervisorLaunchErrorFails") {
            struct NoPython: Error {}
            let s = BackendSupervisor(makeLaunch: { throw NoPython() })
            s.start()
            if case .failed = s.status {} else { check(false, "\(s.status)") }
        },
        TestCase(name: "supervisorCleanStop") {
            guard let l = FakeBackend.launch() else { return }
            let s = BackendSupervisor(makeLaunch: { l }, environment: FakeBackend.env())
            s.start()
            check(waitUntil(10) { s.ready != nil })
            guard let r = s.ready else { return }
            var stopped = false
            s.stop(requestShutdown: { ready in
                let api = BackendAPI(ready: ready)
                api.send(api.shutdownRequest())
            }, completion: { stopped = true })
            check(waitUntil(6) { stopped })
            checkEqual(s.status, .stopped)
            check(!FakeBackend.isAlive(r.pid))
        },
    ]
}
