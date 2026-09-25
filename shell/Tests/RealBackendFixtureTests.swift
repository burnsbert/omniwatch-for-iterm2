import Foundation

/// Payloads captured from the real backend (`python3 -m omniwatch serve --demo --ready-json
/// --demo-clock 1790000000 --demo-seed 7`) by `capture_fixtures.py` into fixtures/real/.
enum RealBackendFixtureTests {
    static func real(_ name: String) throws -> String { try TestPaths.fixture("real/\(name)") }

    static let all: [TestCase] = [
        TestCase(name: "readyLine") {
            let obj = try JSONSerialization.jsonObject(with: Data(try real("ready.json").utf8))
            let line = String(data: try JSONSerialization.data(withJSONObject: obj), encoding: .utf8)!
            let r = try ReadyLine.parse(line)
            checkEqual(r.demo, true)
            checkEqual(r.token.count, 43)
            check(!r.version.isEmpty)
        },
        TestCase(name: "state") {
            let s = try OmniwatchJSON.decode(StateDoc.self, from: try real("state.json"))
            checkEqual(s.demo, true)
            checkEqual(s.serverTime, 1790000000.0)
            check(s.summary.waiting >= 1, "demo default has someone waiting")
            checkEqual(s.summary.waiting, s.sessions.filter { $0.state == "waiting" }.count)
            checkEqual(s.summary.waitingUids.count, s.summary.waiting)
            checkEqual(s.summary.stalled, s.sessions.filter { $0.stalled }.count)
            check(s.sessions.allSatisfy { !$0.uid.isEmpty && !$0.title.isEmpty })
            check(s.sessions.contains { $0.prompt?.options.isEmpty == false }, "a waiting prompt with options")
            if let st = s.sessions.first(where: { $0.stalled }) { check(st.stalledSince != nil) }
            checkEqual(s.prefs.stallMinutes, 10)
            checkEqual(s.prefs.notifications, NotificationPrefs(enabled: true, click: "goto"))
            checkEqual(Set(s.screens.keys), Set(s.sessions.map { $0.uid }))
        },
        TestCase(name: "summaryEndpointMatchesState") {
            let sum = try OmniwatchJSON.decode(SummaryResponse.self, from: try real("summary.json"))
            let s = try OmniwatchJSON.decode(StateDoc.self, from: try real("state.json"))
            checkEqual(sum.waiting, s.summary.waiting)
            checkEqual(sum.tabs, s.summary.tabs)
            checkEqual(sum.stalled, s.summary.stalled)
            checkEqual(sum.waitingSessions.map { $0.uid }, s.summary.waitingUids)
            check(sum.waitingSessions.allSatisfy { $0.since != nil && !$0.title.isEmpty })
        },
        TestCase(name: "health") {
            let h = try JSONSerialization.jsonObject(with: Data(try real("health.json").utf8)) as? [String: Any]
            checkEqual(h?["ok"] as? Bool, true)
            checkEqual(h?["demo"] as? Bool, true)
        },
        TestCase(name: "sseStreamDrivesModelWithoutDecodeErrors") {
            let events = SSEParser().feed(try real("events.txt"))
            check(events.count >= 5, "\(events.count) events")
            checkEqual(Array(events.prefix(2).map { $0.type }), ["hello", "state"])
            check(events.allSatisfy { $0.id != nil }, "every real event carries an id")
            let m = ShellModel()
            m.localClock = { 1000 }
            var fx: [ShellEffect] = []
            for e in events { fx += m.apply(e) }
            checkEqual(m.decodeErrors, 0)
            checkEqual(m.serverOffset, 1790000000.0 - 1000, "demo clock offset from hello/state")
            let waiting = fx.compactMap { if case .becameWaiting(let t) = $0 { return t }; return nil }
            check(!waiting.isEmpty, "the scripted busy→waiting flip")
            check(waiting.allSatisfy { $0.to == "waiting" && !$0.title.isEmpty })
            check(fx.contains { if case .prefsChanged(let p) = $0 { return p.keepOnTop }; return false }, "PATCH echo")
            checkEqual(m.summary.waiting, m.waitingSessions.count)
            // Every event type the real backend sent is one the shell knows or deliberately ignores.
            let known: Set<String> = ["hello", "state", "sessions", "screens", "usage", "prefs", "capabilities",
                                      "transition", "toast", "action", "quota", "stats", "stall"]
            let unknown = Set(events.map { $0.type }).subtracting(known)
            check(unknown.isEmpty, "unexpected event types \(unknown)")
        },
    ]
}
