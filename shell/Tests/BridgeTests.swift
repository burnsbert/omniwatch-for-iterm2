import Foundation

enum BridgeTests {
    static let all: [TestCase] = [
        TestCase(name: "parseMessages") {
            checkEqual(BridgeMessage.parse(["type": "ready"]), .ready)
            checkEqual(BridgeMessage.parse(["type": "theme", "value": "dark"]), .theme("dark"))
            checkEqual(BridgeMessage.parse(["type": "theme", "value": "purple"]), nil)
            checkEqual(BridgeMessage.parse(["type": "keepOnTop", "value": true]), .keepOnTop(true))
            checkEqual(BridgeMessage.parse(["type": "keepOnTop", "value": 1]), nil)
            checkEqual(BridgeMessage.parse(["type": "keepOnTop"]), nil)
            checkEqual(BridgeMessage.parse(["type": "notifyPermission"]), .notifyPermission)
            checkEqual(BridgeMessage.parse(["type": "visible", "uids": ["a", 3, "b"]]), .visible(["a", "b"]))
            checkEqual(BridgeMessage.parse(["type": "visible"]), nil)
            checkEqual(BridgeMessage.parse(["type": "closeWindow"]), .closeWindow)
            checkEqual(BridgeMessage.parse(["type": "restartBackend", "demo": true]), .restartBackend(demo: true))
            checkEqual(BridgeMessage.parse(["type": "restartBackend"]), .restartBackend(demo: false))
            checkEqual(BridgeMessage.parse(["type": "restartBackend", "demo": 1]), .restartBackend(demo: false))
            checkEqual(BridgeMessage.parse(["type": "later"]), .unknown("later"))
            checkEqual(BridgeMessage.parse("theme"), nil)
            checkEqual(BridgeMessage.parse(["value": 1]), nil)
        },
        TestCase(name: "commandJS") {
            checkEqual(BridgeJS.command(.viewGrid),
                       "window.omniwatch && window.omniwatch.command && window.omniwatch.command(\"view.grid\");")
            checkEqual(BridgeJS.command(.selectSession, args: ["uid": "A-1"]),
                       "window.omniwatch && window.omniwatch.command && window.omniwatch.command(\"session.select\", {\"uid\":\"A-1\"});")
            // Hostile strings stay inside one JSON string literal that round-trips exactly.
            let hostile = "x\");alert(1);//\u{2028}</script>"
            let lit = BridgeJS.literal(hostile)
            check(!lit.contains("\u{2028}"), lit)
            check(lit.contains("<\\/script>") || lit.contains("</script>"), lit)
            let back = try JSONSerialization.jsonObject(with: Data(lit.utf8), options: [.fragmentsAllowed]) as? String
            checkEqual(back, hostile)
            checkEqual(BridgeJS.command(hostile),
                       "window.omniwatch && window.omniwatch.command && window.omniwatch.command(\(lit));")
        },
        TestCase(name: "nativeEventAndBootstrap") {
            checkEqual(BridgeJS.nativeEvent(["type": "notifyPermission", "status": "granted"]),
                       "window.omniwatch && window.omniwatch.nativeEvent && window.omniwatch.nativeEvent({\"status\":\"granted\",\"type\":\"notifyPermission\"});")
            checkEqual(BridgeJS.bootstrap(version: "1.0.0"),
                       "window.__OMNIWATCH_NATIVE__ = Object.freeze({\"app\":\"Omniwatch\",\"bridge\":1,\"platform\":\"macos\",\"version\":\"1.0.0\"});")
            checkEqual(BridgeJS.literal("a\"b"), "\"a\\\"b\"")
            checkEqual(BridgeJS.literal(true), "true")
        },
        TestCase(name: "commandIdsAreUnique") {
            checkEqual(Set(NativeCommand.allCases.map { $0.rawValue }).count, NativeCommand.allCases.count)
        },
        TestCase(name: "navigationRule") {
            func d(_ s: String, _ port: Int? = 5000) -> NavigationRule.Decision { NavigationRule.decide(URL(string: s), backendPort: port) }
            checkEqual(d("http://127.0.0.1:5000/"), .allow)
            checkEqual(d("http://localhost:5000/auth?token=x"), .allow)
            checkEqual(d("http://127.0.0.1:5001/"), .openExternally)   // other local port: not ours
            checkEqual(d("http://127.0.0.1/"), .openExternally)
            checkEqual(d("http://127.0.0.1:5000/", nil), .openExternally)
            checkEqual(d("https://github.com/burnsbert/omniwatch-for-iterm2"), .openExternally)
            checkEqual(d("x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"), .openExternally)
            checkEqual(d("mailto:a@b.c"), .openExternally)
            checkEqual(d("file:///etc/passwd"), .cancel)
            checkEqual(d("javascript:alert(1)"), .cancel)
            checkEqual(d("about:blank"), .allow)
            checkEqual(d("about:srcdoc"), .cancel)
            checkEqual(NavigationRule.decide(nil, backendPort: 1), .cancel)
        },
    ]
}
