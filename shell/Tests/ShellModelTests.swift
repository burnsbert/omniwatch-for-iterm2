import Foundation

enum ShellModelTests {
    static func loaded() throws -> ShellModel {
        let m = ShellModel()
        _ = m.apply(SSEEvent(type: "hello", data: #"{"version":"1.0.0","server_time":1,"demo":true}"#, id: "1"))
        _ = m.apply(SSEEvent(type: "state", data: try TestPaths.fixture("state.json"), id: "812"))
        return m
    }

    static let w2 = "AAAAAAAA-0002-4AAA-8AAA-000000000002"
    static let w4 = "AAAAAAAA-0004-4AAA-8AAA-000000000004"

    static func transition(_ uid: String, to: String = "waiting", muted: Bool = false,
                           prompt: Prompt? = nil, title: String = "") -> Transition {
        Transition(uid: uid, from: "busy", to: to, at: 1, title: title, agent: "claude", prompt: prompt, muted: muted)
    }

    static let all: [TestCase] = [
        TestCase(name: "helloAndStateEffects") {
            let m = ShellModel()
            checkEqual(m.apply(SSEEvent(type: "hello", data: #"{"version":"1.0.0","demo":true}"#, id: nil)),
                       [.hello(version: "1.0.0", demo: true)])
            let fx = m.apply(SSEEvent(type: "state", data: try TestPaths.fixture("state.json"), id: nil))
            checkEqual(fx.count, 2)
            if case .summaryChanged(let s)? = fx.first { checkEqual(s.waiting, 2) } else { check(false, "\(fx)") }
            check(m.hasState)
            // A second identical state changes nothing.
            checkEqual(m.apply(SSEEvent(type: "state", data: try TestPaths.fixture("state.json"), id: nil)), [])
        },
        TestCase(name: "waitingSessionsLongestFirst") {
            let m = try loaded()
            checkEqual(m.waitingSessions.map { $0.uid }, [w4, w2]) // 1789999700 < 1789999820
        },
        TestCase(name: "nextWaitingCycles") {
            let m = try loaded()
            checkEqual(m.nextWaiting(after: nil)?.uid, w4)
            checkEqual(m.nextWaiting(after: w4)?.uid, w2)
            checkEqual(m.nextWaiting(after: w2)?.uid, w4)
            checkEqual(m.nextWaiting(after: "gone")?.uid, w4)
            checkEqual(ShellModel().nextWaiting(after: nil), nil)
        },
        TestCase(name: "sessionsEventUpdatesSummaryAndPrunesScreens") {
            let m = try loaded()
            let fx = m.apply(SSEEvent(type: "sessions", data: """
                {"seq":900,"sessions":[{"uid":"\(w2)","state":"waiting","title":"refactor"}],
                 "summary":{"tabs":1,"agents":1,"waiting":1,"busy":0,"waiting_uids":["\(w2)"]}}
                """, id: nil))
            checkEqual(fx, [.summaryChanged(Summary(tabs: 1, agents: 1, waiting: 1, busy: 0, waitingUids: [w2]))])
            checkEqual(Array(m.screens.keys), [w2])
            checkEqual(m.session(w2)?.title, "refactor")
            checkEqual(m.session(w4), nil)
        },
        TestCase(name: "screensAndPrefsEvents") {
            let m = try loaded()
            checkEqual(m.apply(SSEEvent(type: "screens", data: #"{"screens":{"new":{"hash":"1","text":"hi"}},"removed":["\#(w2)"]}"#, id: nil)), [])
            checkEqual(m.screens["new"], "hi")
            checkEqual(m.screens[w2], nil)
            let fx = m.apply(SSEEvent(type: "prefs", data: #"{"prefs":{"keep_on_top":true},"projects":[]}"#, id: nil))
            checkEqual(fx, [.prefsChanged(Prefs(keepOnTop: true))])
            checkEqual(m.apply(SSEEvent(type: "prefs", data: #"{"prefs":{"keep_on_top":true}}"#, id: nil)), [])
        },
        TestCase(name: "transitionOnlyToWaiting") {
            let m = try loaded()
            let fx = m.apply(SSEEvent(type: "transition", data: #"{"uid":"u","from":"busy","to":"waiting","at":5,"title":"T","muted":false}"#, id: nil))
            checkEqual(fx, [.becameWaiting(Transition(uid: "u", from: "busy", to: "waiting", at: 5, title: "T"))])
            checkEqual(m.apply(SSEEvent(type: "transition", data: #"{"uid":"u","from":"waiting","to":"idle"}"#, id: nil)), [])
        },
        TestCase(name: "failedActionsOnly") {
            let m = ShellModel()
            checkEqual(m.apply(SSEEvent(type: "action", data: #"{"id":"a-1","kind":"goto","ok":true,"detail":""}"#, id: nil)), [])
            checkEqual(m.apply(SSEEvent(type: "action", data: #"{"id":"a-2","kind":"goto","ok":false,"detail":"session not found"}"#, id: nil)),
                       [.actionFailed(kind: "goto", detail: "session not found")])
        },
        TestCase(name: "badJSONAndUnknownEventsIgnored") {
            let m = ShellModel()
            checkEqual(m.apply(SSEEvent(type: "state", data: "{not json", id: nil)), [])
            checkEqual(m.decodeErrors, 1)
            checkEqual(m.apply(SSEEvent(type: "usage", data: "{}", id: nil)), [])
            checkEqual(m.apply(SSEEvent(type: "toast", data: "{}", id: nil)), [])
            check(!m.hasState)
        },
        TestCase(name: "notificationPostsWithPromptQuestion") {
            let m = try loaded()
            let focus = FocusContext(appActive: false, windowKey: false, visibleUids: [])
            let d = NotificationPolicy.decide(transition(w2, prompt: Prompt(question: " Proceed? ")), prefs: m.prefs,
                                              focus: focus, session: m.session(w2), screenText: m.screens[w2])
            checkEqual(d, .post(title: "refactor needs you", body: "Proceed?"))
            // Falls back to the session's own prompt, then to the screen's last meaningful line.
            let d2 = NotificationPolicy.decide(transition(w2, title: "X"), prefs: m.prefs, focus: focus,
                                               session: m.session(w2), screenText: nil)
            checkEqual(d2, .post(title: "X needs you", body: "Do you want to proceed?"))
            let d3 = NotificationPolicy.decide(transition("zz", title: "Z"), prefs: m.prefs, focus: focus,
                                               session: nil, screenText: "Allow `rm`?\n  Yes (y)\n\n───\n› \n")
            checkEqual(d3, .post(title: "Z needs you", body: "Yes (y)"))
            let d4 = NotificationPolicy.decide(transition("abcdefghij"), prefs: m.prefs, focus: focus,
                                               session: nil, screenText: "\n\n")
            checkEqual(d4, .post(title: "abcdefgh needs you", body: "Waiting for your input"))
        },
        TestCase(name: "notificationSuppression") {
            let m = try loaded()
            let away = FocusContext(appActive: false, windowKey: false, visibleUids: [w2])
            let looking = FocusContext(appActive: true, windowKey: true, visibleUids: [w2])
            checkEqual(NotificationPolicy.decide(transition(w2), prefs: m.prefs, focus: looking,
                                                 session: m.session(w2), screenText: nil), .suppress("visible"))
            // Visible but the app isn't key → still notify.
            if case .post = NotificationPolicy.decide(transition(w2), prefs: m.prefs, focus: away,
                                                      session: m.session(w2), screenText: nil) {} else { check(false) }
            // Key window but another session is visible → notify.
            let other = FocusContext(appActive: true, windowKey: true, visibleUids: ["other"])
            if case .post = NotificationPolicy.decide(transition(w2), prefs: m.prefs, focus: other,
                                                      session: m.session(w2), screenText: nil) {} else { check(false) }
            checkEqual(NotificationPolicy.decide(transition(w2, muted: true), prefs: m.prefs, focus: away,
                                                 session: m.session(w2), screenText: nil), .suppress("muted"))
            checkEqual(NotificationPolicy.decide(transition(w4), prefs: m.prefs, focus: away,
                                                 session: m.session(w4), screenText: nil), .suppress("muted"))
            var off = m.prefs; off.notifications.enabled = false
            checkEqual(NotificationPolicy.decide(transition(w2), prefs: off, focus: away,
                                                 session: m.session(w2), screenText: nil), .suppress("notifications off"))
            checkEqual(NotificationPolicy.decide(transition(w2, to: "idle"), prefs: m.prefs, focus: away,
                                                 session: nil, screenText: nil), .suppress("not a waiting transition"))
        },
        TestCase(name: "soundPolicy") {
            var p = Prefs()
            check(!NotificationPolicy.shouldPlaySound(transition("u"), prefs: p, session: nil))
            p.sound = true
            check(NotificationPolicy.shouldPlaySound(transition("u"), prefs: p, session: nil))
            check(!NotificationPolicy.shouldPlaySound(transition("u", muted: true), prefs: p, session: nil))
            check(!NotificationPolicy.shouldPlaySound(transition("u"), prefs: p, session: SessionInfo(uid: "u", muted: true)))
            check(!NotificationPolicy.shouldPlaySound(transition("u", to: "busy"), prefs: p, session: nil))
        },
        TestCase(name: "lastMeaningfulLine") {
            checkEqual(ScreenText.lastMeaningfulLine("a\nb\n\n"), "b")
            checkEqual(ScreenText.lastMeaningfulLine("│ Do it? │\n╰────╯\n❯\n"), "Do it?")
            checkEqual(ScreenText.lastMeaningfulLine("real\n⏵⏵ accept edits on\n  ██ 40% remaining]\n>"), "real")
            checkEqual(ScreenText.lastMeaningfulLine("x\r\ny\r\n"), "y")
            checkEqual(ScreenText.lastMeaningfulLine(""), nil)
            checkEqual(ScreenText.lastMeaningfulLine("───\n   \n"), nil)
            let long = String(repeating: "z", count: 300)
            checkEqual(ScreenText.lastMeaningfulLine(long)?.count, 200)
        },
    ]
}
