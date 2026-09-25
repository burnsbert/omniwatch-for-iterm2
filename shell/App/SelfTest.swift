import Foundation

/// `Omniwatch --self-test` (§4.7 step 8): headless lifecycle check. Spawns the backend with
/// `--demo` (in a throwaway config dir), completes the ready-line handshake, checks the
/// `/auth` cookie redirect and `/health`, receives `hello` + `state` over SSE with the Bearer
/// token, checks `summary.waiting > 0`, POSTs `/shutdown`, verifies the child exited.
/// Exit code 0 = pass, 1 = fail. Never touches AppKit windows or notifications.
final class SelfTest {
    let options: LaunchOptions
    private var failures = 0
    private let started = Date()

    init(options: LaunchOptions) { self.options = options }

    private func say(_ s: String) {
        print("self-test: \(s)")
        fflush(stdout)
    }

    private func step(_ ok: Bool, _ what: String) {
        if !ok { failures += 1 }
        say("\(ok ? "ok  " : "FAIL") \(what)")
    }

    private func wait(_ timeout: TimeInterval, _ cond: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !cond() {
            if Date() > deadline { return false }
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
        return true
    }

    func run() -> Int32 {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("omniwatch-selftest-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: tmp.appendingPathComponent("config"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        step(Bundle.main.bundleIdentifier == "com.burnsbert.omniwatch",
             "bundle identifier \(Bundle.main.bundleIdentifier ?? "none")")
        let aeDesc = Bundle.main.object(forInfoDictionaryKey: "NSAppleEventsUsageDescription") as? String
        step(!(aeDesc ?? "").isEmpty, "Info.plist has NSAppleEventsUsageDescription")
        let ats = Bundle.main.object(forInfoDictionaryKey: "NSAppTransportSecurity") as? [String: Any]
        step((ats?["NSAllowsLocalNetworking"] as? Bool) == true, "Info.plist allows local networking (ATS)")

        var env = ProcessInfo.processInfo.environment
        env["OMNIWATCH_DEMO"] = "1"                                          // backend-side demo guard (§5)
        env["OMNIWATCH_CONFIG_DIR"] = tmp.appendingPathComponent("config").path // never the user's config
        let launch: BackendLaunch
        do {
            launch = try options.makeLaunch(environment: env,
                                            logFile: tmp.appendingPathComponent("backend.log").path, demo: true)
        } catch {
            step(false, "resolve backend: \(error)")
            return finish()
        }
        say("backend: \(launch.argv.joined(separator: " "))")

        let proc = BackendProcess(launch: launch, environment: env)
        proc.stderrHandle = FileHandle.standardError
        var ready: ReadyLine?
        var exit: BackendProcess.Exit?
        proc.onReady = { ready = $0 }
        proc.onExit = { exit = $0 }
        do { try proc.start() } catch {
            step(false, "spawn backend: \(error)")
            return finish()
        }
        _ = wait(12) { ready != nil || exit != nil }
        guard let r = ready else {
            step(false, "ready line: \(exit.map { "\($0)" } ?? "timeout")")
            proc.stopAndWait(grace: 1)
            return finish()
        }
        step(true, "ready line: port \(r.port), pid \(r.pid), version \(r.version), token \(r.token.count) chars")
        step(r.demo, "backend reports demo mode")
        step(r.pid == proc.pid, "ready pid matches the child pid")

        checkAuthRedirect(r)

        let api = BackendAPI(ready: r)
        let health = api.sendSync(api.healthRequest())
        let hbody = health.body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        step(health.status == 200 && (hbody?["ok"] as? Bool) == true, "GET /api/v1/health with Bearer → \(health.status)")

        let sumResp = api.sendSync(api.summaryRequest())
        let summary = sumResp.body.flatMap { try? OmniwatchJSON.decoder().decode(SummaryResponse.self, from: $0) }
        step(sumResp.status == 200 && summary != nil,
             "GET /api/v1/summary decodes (waiting \(summary?.waiting ?? -1), stalled \(summary?.stalled ?? -1))")

        let model = ShellModel()
        var types: [String] = []
        let sse = EventStreamClient(ready: r)
        sse.onEvent = { e in types.append(e.type); model.apply(e) }
        sse.start()
        let gotState = wait(10) { model.hasState }
        sse.stop()
        step(types.first == "hello", "SSE first event is hello (got \(types.first ?? "none"))")
        step(gotState, "SSE state received (events: \(types.prefix(5).joined(separator: ", ")))")
        step(model.summary.waiting > 0, "summary.waiting = \(model.summary.waiting) (> 0)")
        step(model.decodeErrors == 0, "SSE payloads decode (\(model.decodeErrors) errors)")
        if let s = summary { step(s.waiting == model.summary.waiting, "/summary waiting matches SSE state") }

        var shutdownStatus = 0
        let stopped = proc.stopAndWait(grace: 2) {
            shutdownStatus = api.sendSync(api.shutdownRequest()).status
        }
        step(shutdownStatus == 200, "POST /api/v1/shutdown → \(shutdownStatus)")
        _ = wait(1) { exit != nil }
        step(stopped && kill(r.pid, 0) != 0, "backend exited (\(exit.map { "\($0)" } ?? "no exit reported"))")
        if case .requested(let status)? = exit { step(status == 0, "backend exit status \(status)") }
        return finish()
    }

    /// `GET /auth?token=T` must 302 to `/` and set `ow_session` HttpOnly SameSite=Strict (§4.5).
    private func checkAuthRedirect(_ r: ReadyLine) {
        final class NoRedirect: NSObject, URLSessionTaskDelegate {
            func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                            newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
                completionHandler(nil)
            }
        }
        let cfg = URLSessionConfiguration.ephemeral
        cfg.httpShouldSetCookies = false
        cfg.connectionProxyDictionary = [:]
        let session = URLSession(configuration: cfg, delegate: NoRedirect(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let sem = DispatchSemaphore(value: 0)
        var resp: HTTPURLResponse?
        session.dataTask(with: r.authURL) { _, re, _ in resp = re as? HTTPURLResponse; sem.signal() }.resume()
        _ = sem.wait(timeout: .now() + 5)
        let cookie = resp?.value(forHTTPHeaderField: "Set-Cookie") ?? ""
        let location = resp?.value(forHTTPHeaderField: "Location") ?? ""
        step(resp?.statusCode == 302, "GET /auth → \(resp?.statusCode ?? 0) Location \(location)")
        step(cookie.contains("ow_session=\(r.token)") && cookie.lowercased().contains("httponly"),
             "/auth sets the ow_session HttpOnly cookie")
    }

    private func finish() -> Int32 {
        let dt = String(format: "%.1f", Date().timeIntervalSince(started))
        say(failures == 0 ? "PASS (\(dt)s)" : "FAILED: \(failures) check(s) (\(dt)s)")
        return failures == 0 ? 0 : 1
    }
}
