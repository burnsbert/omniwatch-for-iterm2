import Foundation

enum ModelsTests {
    static let all: [TestCase] = [
        TestCase(name: "decodesFixtureState") {
            let s = try OmniwatchJSON.decode(StateDoc.self, from: try TestPaths.fixture("state.json"))
            checkEqual(s.seq, 812)
            checkEqual(s.demo, true)
            checkEqual(s.summary, Summary(tabs: 4, agents: 3, waiting: 2, busy: 1, waitingUids: [
                "AAAAAAAA-0002-4AAA-8AAA-000000000002", "AAAAAAAA-0004-4AAA-8AAA-000000000004"]))
            checkEqual(s.sessions.count, 4)
            let w = s.sessions[1]
            checkEqual(w.state, "waiting")
            checkEqual(w.title, "refactor")
            checkEqual(w.tabLabel, "1.2")
            checkEqual(w.pathDisplay, "~/src/billing")
            checkEqual(w.stateSince, 1789999820.0)
            checkEqual(w.attention, true)
            checkEqual(w.prompt?.question, "Do you want to proceed?")
            checkEqual(w.prompt?.options.count, 3)
            checkEqual(w.prompt?.options.first, PromptOption(key: "1", label: "Yes", selected: true))
            checkEqual(s.sessions[3].muted, true)
            checkEqual(s.sessions[2].agent, nil)
            checkEqual(s.prefs, Prefs(theme: "system", sound: false, keepOnTop: false, closeWindowOnQ: true,
                                      notifications: NotificationPrefs(enabled: true, click: "goto")))
            checkEqual(s.screens.count, 4)
        },
        TestCase(name: "toleratesMissingFields") {
            let s = try OmniwatchJSON.decode(StateDoc.self, from: "{}")
            checkEqual(s.summary, Summary())
            checkEqual(s.sessions.count, 0)
            checkEqual(s.prefs, Prefs())
            let t = try OmniwatchJSON.decode(Transition.self, from: #"{"uid":"u"}"#)
            checkEqual(t, Transition(uid: "u"))
            let p = try OmniwatchJSON.decode(Prefs.self, from: #"{"keep_on_top":true,"notifications":{"enabled":false}}"#)
            checkEqual(p.keepOnTop, true)
            checkEqual(p.notifications, NotificationPrefs(enabled: false, click: "goto"))
            checkEqual(try OmniwatchJSON.decode(PromptOption.self, from: "{}"), PromptOption(key: "", label: ""))
        },
        TestCase(name: "sessionWithoutUidFails") {
            checkThrows { _ = try OmniwatchJSON.decode(SessionInfo.self, from: #"{"title":"x"}"#) }
        },
        TestCase(name: "bestTitleFallbacks") {
            checkEqual(SessionInfo(uid: "12345678-abcd", title: "t", displayName: "d").bestTitle, "t")
            checkEqual(SessionInfo(uid: "12345678-abcd", displayName: "d").bestTitle, "d")
            checkEqual(SessionInfo(uid: "12345678-abcd", pathDisplay: "~/x").bestTitle, "~/x")
            checkEqual(SessionInfo(uid: "12345678-abcd").bestTitle, "12345678")
        },
        TestCase(name: "eventPayloads") {
            let h = try OmniwatchJSON.decode(Hello.self, from: #"{"version":"1.0.0","server_time":5.5,"demo":true}"#)
            checkEqual(h.version, "1.0.0"); checkEqual(h.serverTime, 5.5); checkEqual(h.demo, true)
            let a = try OmniwatchJSON.decode(ActionResult.self, from: #"{"id":"a-1","kind":"goto","uid":"u","ok":false,"detail":"session not found"}"#)
            checkEqual(a.kind, "goto"); checkEqual(a.ok, false); checkEqual(a.detail, "session not found")
            let su = try OmniwatchJSON.decode(ScreensUpdate.self, from: #"{"seq":3,"screens":{"u":{"hash":"h","text":"t"}},"removed":["v"]}"#)
            checkEqual(su.screens["u"]?.text, "t"); checkEqual(su.removed, ["v"])
            let pu = try OmniwatchJSON.decode(PrefsUpdate.self, from: #"{"seq":1,"prefs":{"sound":true},"projects":[]}"#)
            checkEqual(pu.prefs.sound, true)
            let ss = try OmniwatchJSON.decode(SessionsUpdate.self, from: #"{"seq":2,"sessions":[{"uid":"x"}],"summary":{"waiting":1}}"#)
            checkEqual(ss.sessions.map { $0.uid }, ["x"]); checkEqual(ss.summary.waiting, 1)
        },
    ]
}
