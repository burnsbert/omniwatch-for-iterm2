import Foundation

enum StallTests {
    static let away = FocusContext(appActive: false, windowKey: false, visibleUids: [])

    static let all: [TestCase] = [
        TestCase(name: "stallEventShapeFromEngine") {
            let m = ShellModel()
            let fx = m.apply(SSEEvent(type: "stall", data: #"{"uid":"DEMO-0003","title":"~/src/web-app","agent":"codex","since":1789999140.0,"minutes":10,"muted":false}"#, id: "9"))
            checkEqual(fx, [.becameStalled(StallEvent(uid: "DEMO-0003", title: "~/src/web-app", agent: "codex",
                                                      since: 1789999140.0, minutes: 10, muted: false))])
            checkEqual(m.apply(SSEEvent(type: "stalled", data: #"{"uid":"x"}"#, id: nil)), [.becameStalled(StallEvent(uid: "x"))])
            let t = m.apply(SSEEvent(type: "transition", data: #"{"uid":"y","from":"busy","to":"stalled","at":5,"title":"T"}"#, id: nil))
            checkEqual(t, [.becameStalled(StallEvent(uid: "y", title: "T", since: 5))])
            checkEqual(m.apply(SSEEvent(type: "stall", data: #"{"title":"no uid"}"#, id: nil)), [])
            checkEqual(m.decodeErrors, 1)
        },
        TestCase(name: "stalledUidsFromSessions") {
            let m = ShellModel()
            _ = m.apply(SSEEvent(type: "sessions", data: #"{"sessions":[{"uid":"a","stalled":true,"stalled_since":5},{"uid":"b"}],"summary":{"stalled":1}}"#, id: nil))
            checkEqual(m.stalledUids, ["a"])
            checkEqual(m.summary.stalled, 1)
            checkEqual(m.session("a")?.stalledSince, 5)
        },
        TestCase(name: "stallNotificationText") {
            let e = StallEvent(uid: "u", title: "~/src/web-app", since: 1000, minutes: 10)
            checkEqual(NotificationPolicy.decideStall(e, prefs: Prefs(), focus: away, session: nil, now: 1000 + 725),
                       .post(title: "~/src/web-app may be stalled", body: "Busy with no screen change for 12m. Check on it?"))
            let noSince = StallEvent(uid: "abcdefghij", minutes: 15)
            checkEqual(NotificationPolicy.decideStall(noSince, prefs: Prefs(), focus: away, session: nil, now: 0),
                       .post(title: "abcdefgh may be stalled", body: "Busy with no screen change for 15m. Check on it?"))
            let viaSession = NotificationPolicy.decideStall(StallEvent(uid: "s"), prefs: Prefs(stallMinutes: 20), focus: away,
                                                            session: SessionInfo(uid: "s", title: "api"), now: 0)
            checkEqual(viaSession, .post(title: "api may be stalled", body: "Busy with no screen change for 20m. Check on it?"))
        },
        TestCase(name: "stallSuppression") {
            let e = StallEvent(uid: "u", title: "t")
            var p = Prefs()
            p.notifications.enabled = false
            checkEqual(NotificationPolicy.decideStall(e, prefs: p, focus: away, session: nil, now: 0), .suppress("notifications off"))
            checkEqual(NotificationPolicy.decideStall(e, prefs: Prefs(stallMinutes: 0), focus: away, session: nil, now: 0),
                       .suppress("stall notifications off"))
            var q = Prefs(); q.notifications.stall = false
            checkEqual(NotificationPolicy.decideStall(e, prefs: q, focus: away, session: nil, now: 0), .suppress("stall notifications off"))
            checkEqual(NotificationPolicy.decideStall(StallEvent(uid: "u", muted: true), prefs: Prefs(), focus: away, session: nil, now: 0),
                       .suppress("muted"))
            checkEqual(NotificationPolicy.decideStall(e, prefs: Prefs(), focus: away, session: SessionInfo(uid: "u", muted: true), now: 0),
                       .suppress("muted"))
            let looking = FocusContext(appActive: true, windowKey: true, visibleUids: ["u"])
            checkEqual(NotificationPolicy.decideStall(e, prefs: Prefs(), focus: looking, session: nil, now: 0), .suppress("visible"))
            let decoded = try OmniwatchJSON.decode(Prefs.self, from: #"{"notifications":{"enabled":true,"stall":false},"stall_minutes":3}"#)
            checkEqual(decoded.notifications.stall, false)
            checkEqual(decoded.stallMinutes, 3)
        },
        TestCase(name: "serverClockOffset") {
            let m = ShellModel()
            m.localClock = { 500 }
            checkEqual(m.serverNow(), 500)
            _ = m.apply(SSEEvent(type: "hello", data: #"{"version":"1","server_time":1790000000,"demo":true}"#, id: nil))
            checkEqual(m.serverOffset, 1790000000 - 500)
            checkEqual(m.serverNow(600), 1790000100)
            _ = m.apply(SSEEvent(type: "hello", data: #"{"version":"1","demo":true}"#, id: nil)) // no server_time: keep
            checkEqual(m.serverOffset, 1790000000 - 500)
        },
    ]
}
