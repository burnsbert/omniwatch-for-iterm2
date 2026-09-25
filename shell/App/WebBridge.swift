import WebKit

/// `webkit.messageHandlers.omniwatch` endpoint plus native → web calls (§4.7 step 6).
/// WKUserContentController retains its handlers, so this proxies to a weak target.
final class WebBridge: NSObject, WKScriptMessageHandler {
    static let handlerName = "omniwatch"

    weak var webView: WKWebView?
    var onMessage: ((BridgeMessage) -> Void)?
    /// The page's `window.omniwatch` API is only there after the page posted `ready`.
    private(set) var pageReady = false
    private var pending: [String] = []

    func install(in controller: WKUserContentController, version: String) {
        controller.add(self, name: WebBridge.handlerName)
        controller.addUserScript(WKUserScript(source: BridgeJS.bootstrap(version: version),
                                              injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        // Only trust the main frame of our own backend origin.
        guard message.frameInfo.isMainFrame,
              let host = message.frameInfo.securityOrigin.host as String?,
              host == "127.0.0.1" || host == "localhost",
              let parsed = BridgeMessage.parse(message.body) else { return }
        if parsed == .ready {
            pageReady = true
            let queued = pending
            pending.removeAll()
            queued.forEach(evaluate)
        }
        onMessage?(parsed)
    }

    /// Called on every new page load; commands sent before `ready` are queued.
    func pageWillLoad() { pageReady = false }

    func command(_ c: NativeCommand, args: [String: Any]? = nil) {
        send(BridgeJS.command(c, args: args))
    }

    func nativeEvent(_ event: [String: Any]) { send(BridgeJS.nativeEvent(event)) }

    private func send(_ js: String) {
        if pageReady { evaluate(js) } else { pending.append(js); if pending.count > 32 { pending.removeFirst() } }
    }

    private func evaluate(_ js: String) {
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }
}
