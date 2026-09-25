import AppKit
import WebKit

/// The main window: WKWebView on the backend's UI, plus native loading and error views.
final class WindowController: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    let window: NSWindow
    let webView: WKWebView
    let bridge = WebBridge()
    private let loadingView = StatusPanel()
    private let errorView = StatusPanel()
    private(set) var backendPort: Int?
    private var loadedOnce = false
    private var authURL: URL?
    var onRetry: (() -> Void)?
    var onOpenLog: (() -> Void)?
    var onKeyChange: ((Bool) -> Void)?

    override init() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent() // cookie lives only as long as this app run
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.suppressesIncrementalRendering = true
        bridge.install(in: config.userContentController, version: AppInfo.version)

        webView = WKWebView(frame: .zero, configuration: config)
        webView.allowsBackForwardNavigationGestures = false
        webView.underPageBackgroundColor = .windowBackgroundColor
        if #available(macOS 13.3, *), ProcessInfo.processInfo.environment["OMNIWATCH_INSPECT"] == "1" {
            webView.isInspectable = true
        }

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 760),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: true)
        window.title = BadgeFormatter.windowTitle(0)
        window.minSize = NSSize(width: 640, height: 420)
        window.isReleasedWhenClosed = false
        window.collectionBehavior = [.fullScreenPrimary]
        window.tabbingMode = .disallowed
        super.init()

        bridge.webView = webView
        webView.navigationDelegate = self
        webView.uiDelegate = self
        window.delegate = self

        let content = NSView()
        window.contentView = content
        for v in [webView, loadingView, errorView] as [NSView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            content.addSubview(v)
            NSLayoutConstraint.activate([
                v.leadingAnchor.constraint(equalTo: content.leadingAnchor),
                v.trailingAnchor.constraint(equalTo: content.trailingAnchor),
                v.topAnchor.constraint(equalTo: content.topAnchor),
                v.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            ])
        }
        loadingView.configure(title: "Starting Omniwatch…", detail: nil, buttons: [])
        errorView.isHidden = true
        webView.isHidden = true

        // Frame restore: AppKit saves/restores under this name; center the first time.
        if !window.setFrameUsingName("OmniwatchMain") { window.center() }
        window.setFrameAutosaveName("OmniwatchMain")
    }

    // MARK: state

    func show() {
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    var isVisibleAndKey: Bool { window.isVisible && window.isKeyWindow && NSApp.isActive }

    func toggle() {
        if isVisibleAndKey { NSApp.hide(nil) } else { show() }
    }

    func setKeepOnTop(_ on: Bool) { window.level = on ? .floating : .normal }
    var keepOnTop: Bool { window.level == .floating }

    func setWaiting(_ count: Int) { window.title = BadgeFormatter.windowTitle(count) }

    /// Backend (re)started: load `/auth?token=…`, which sets the cookie and redirects to `/`.
    func load(ready: ReadyLine) {
        backendPort = ready.port
        authURL = ready.authURL
        errorView.isHidden = true
        if !loadedOnce {
            loadingView.isHidden = false
            loadingView.configure(title: "Starting Omniwatch…", detail: nil, buttons: [])
        }
        bridge.pageWillLoad()
        webView.load(URLRequest(url: ready.authURL))
    }

    func showStarting(_ text: String) {
        guard !loadedOnce || webView.isHidden else { return } // the web UI shows its own reconnect banner
        loadingView.isHidden = false
        loadingView.configure(title: text, detail: nil, buttons: [])
    }

    /// §4.7 step 4 / §2.9: after too many restarts, a native error view with the log path.
    func showError(_ reason: String, logPath: String) {
        webView.isHidden = true
        loadingView.isHidden = true
        errorView.isHidden = false
        errorView.configure(title: "Omniwatch's backend stopped",
                            detail: "\(reason)\n\nLog: \(logPath)",
                            buttons: [("Retry", { [weak self] in self?.onRetry?() }),
                                      ("Open Log", { [weak self] in self?.onOpenLog?() })])
    }

    // MARK: NSWindowDelegate

    func windowDidBecomeKey(_ notification: Notification) { onKeyChange?(true) }
    func windowDidResignKey(_ notification: Notification) { onKeyChange?(false) }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        switch NavigationRule.decide(url, backendPort: backendPort) {
        case .allow:
            decisionHandler(.allow)
        case .openExternally:
            decisionHandler(.cancel)
            if let u = url, navigationAction.navigationType == .linkActivated || navigationAction.targetFrame == nil
                || navigationAction.targetFrame?.isMainFrame == true {
                NSWorkspace.shared.open(u)
            }
        case .cancel:
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loadedOnce = true
        webView.isHidden = false
        loadingView.isHidden = true
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        retryLoadSoon()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        retryLoadSoon()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        retryLoadSoon()
    }

    private func retryLoadSoon() {
        let expected = authURL
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self = self, let u = self.authURL, u == expected, self.errorView.isHidden else { return }
            self.bridge.pageWillLoad()
            self.webView.load(URLRequest(url: u))
        }
    }

    // MARK: WKUIDelegate

    /// `target=_blank` / `window.open`: never open a second web view; hand it to NSWorkspace.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let u = navigationAction.request.url, NavigationRule.decide(u, backendPort: backendPort) != .cancel {
            NSWorkspace.shared.open(u)
        }
        return nil
    }
}

/// Centered title/detail/buttons panel used for "Starting…" and the error view.
final class StatusPanel: NSView {
    private let stack = NSStackView()
    private var actions: [() -> Void] = []

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            stack.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, constant: -48),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func updateLayer() { layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor }

    func configure(title: String, detail: String?, buttons: [(String, () -> Void)]) {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        actions = buttons.map { $0.1 }
        let t = NSTextField(labelWithString: title)
        t.font = .systemFont(ofSize: 17, weight: .semibold)
        stack.addArrangedSubview(t)
        if let d = detail {
            let l = NSTextField(wrappingLabelWithString: d)
            l.isSelectable = true
            l.alignment = .center
            l.textColor = .secondaryLabelColor
            l.preferredMaxLayoutWidth = 520
            stack.addArrangedSubview(l)
        }
        if !buttons.isEmpty {
            let row = NSStackView()
            row.orientation = .horizontal
            row.spacing = 8
            for (i, b) in buttons.enumerated() {
                let button = NSButton(title: b.0, target: self, action: #selector(tapped(_:)))
                button.tag = i
                button.bezelStyle = .rounded
                if i == 0 { button.keyEquivalent = "\r" }
                row.addArrangedSubview(button)
            }
            stack.addArrangedSubview(row)
        }
    }

    @objc private func tapped(_ sender: NSButton) {
        if actions.indices.contains(sender.tag) { actions[sender.tag]() }
    }
}
