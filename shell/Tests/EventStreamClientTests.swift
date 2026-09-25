import Foundation

enum EventStreamClientTests {
    final class Recorder {
        var events: [SSEEvent] = []
        var statuses: [EventStreamClient.Status] = []
        func types() -> [String] { events.map { $0.type } }
    }

    static func connect(_ r: ReadyLine, token: String? = nil) -> (EventStreamClient, Recorder) {
        let c = EventStreamClient(baseURL: r.baseURL, token: token ?? r.token)
        let rec = Recorder()
        c.onEvent = { rec.events.append($0) }
        c.onStatus = { rec.statuses.append($0) }
        c.start()
        return (c, rec)
    }

    static let all: [TestCase] = [
        TestCase(name: "helloThenStateDrivesModel") {
            let (p, r) = try FakeBackend.start()
            defer { p.stopAndWait(grace: 0.5) }
            let (c, rec) = connect(r)
            defer { c.stop() }
            check(waitUntil(5) { rec.events.count >= 2 }, "\(rec.types())")
            checkEqual(Array(rec.types().prefix(2)), ["hello", "state"])
            check(rec.statuses.contains(.open))
            let m = ShellModel()
            for e in rec.events { m.apply(e) }
            checkEqual(m.summary.waiting, 2)
            check(m.demo)
            checkEqual(c.lastEventId, "812")
        },
        TestCase(name: "transitionActionAndPrefsEvents") {
            let (p, r) = try FakeBackend.start(["FAKE_BACKEND_TRANSITION_AFTER": "0.2"])
            defer { p.stopAndWait(grace: 0.5) }
            let (c, rec) = connect(r)
            defer { c.stop() }
            check(waitUntil(5) { rec.types().contains("transition") }, "\(rec.types())")
            let m = ShellModel()
            var effects: [ShellEffect] = []
            for e in rec.events { effects += m.apply(e) }
            check(effects.contains { if case .becameWaiting(let t) = $0 { return t.uid.hasSuffix("0001") }; return false },
                  "\(effects)")
            let api = BackendAPI(ready: r)
            checkEqual(api.sendSync(api.gotoRequest(uid: "AAAAAAAA-0002-4AAA-8AAA-000000000002")).status, 202)
            checkEqual(api.sendSync(api.patchPrefsRequest(["keep_on_top": true])).status, 200)
            check(waitUntil(5) { rec.types().contains("action") && rec.types().contains("prefs") }, "\(rec.types())")
            var fx: [ShellEffect] = []
            for e in rec.events where e.type == "prefs" { fx += m.apply(e) }
            check(fx.contains(.prefsChanged(Prefs(keepOnTop: true))), "\(fx)")
            checkEqual(api.sendSync(api.gotoRequest(uid: "nope")).status, 404)
        },
        TestCase(name: "badTokenIsUnauthorized") {
            let (p, r) = try FakeBackend.start()
            defer { p.stopAndWait(grace: 0.5) }
            let (c, rec) = connect(r, token: "wrong")
            defer { c.stop() }
            check(waitUntil(5) { rec.statuses.contains(.unauthorized) }, "\(rec.statuses)")
            checkEqual(rec.events.count, 0)
        },
        TestCase(name: "reconnectsWithLastEventId") {
            let dir = TestPaths.tempDir()
            defer { try? FileManager.default.removeItem(at: dir) }
            let record = dir.appendingPathComponent("requests.jsonl")
            let (p, r) = try FakeBackend.start(["FAKE_BACKEND_SSE_CLOSE_AFTER": "0.3", "FAKE_BACKEND_RECORD": record.path])
            defer { p.stopAndWait(grace: 0.5) }
            let (c, rec) = connect(r)
            defer { c.stop() }
            check(waitUntil(8) { rec.types().filter { $0 == "hello" }.count >= 2 }, "\(rec.types())")
            check(rec.statuses.contains { if case .disconnected = $0 { return true }; return false })
            let lines = (try? String(contentsOf: record, encoding: .utf8))?.split(separator: "\n") ?? []
            let sse = lines.compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
                .filter { ($0["path"] as? String) == "/api/v1/events" }
            check(sse.count >= 2, "\(sse.count) SSE requests")
            if sse.count >= 2 {
                check(sse[0]["last_event_id"] is NSNull, "first connect has no Last-Event-ID")
                checkEqual(sse[1]["last_event_id"] as? String, "812")
                checkEqual(sse[1]["authorization"] as? String, "Bearer \(r.token)")
                checkEqual(sse[1]["host"] as? String, "127.0.0.1:\(r.port)")
                checkEqual(sse[1]["cookie"] as? String, nil)
            }
        },
        TestCase(name: "stopEndsDelivery") {
            let (p, r) = try FakeBackend.start(["FAKE_BACKEND_TRANSITION_AFTER": "0.5"])
            defer { p.stopAndWait(grace: 0.5) }
            let (c, rec) = connect(r)
            check(waitUntil(5) { rec.events.count >= 2 })
            c.stop()
            _ = waitUntil(1.0) { false }
            check(!rec.types().contains("transition"), "\(rec.types())")
        },
        TestCase(name: "backoffSequence") {
            var b = ReconnectBackoff()
            checkEqual((0..<7).map { _ in b.next() }, [0.5, 1, 2, 4, 8, 8, 8])
            b.reset()
            checkEqual(b.next(), 0.5)
        },
    ]
}
