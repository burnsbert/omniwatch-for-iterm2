import Foundation

/// Reconnect delays for the SSE client: 0.5 s doubling to 8 s (matches §2.9's web backoff);
/// reset once a connection opens.
public struct ReconnectBackoff {
    public let initial: TimeInterval
    public let maximum: TimeInterval
    public private(set) var current: TimeInterval

    public init(initial: TimeInterval = 0.5, maximum: TimeInterval = 8) {
        self.initial = initial
        self.maximum = maximum
        self.current = initial
    }

    public mutating func next() -> TimeInterval {
        let d = current
        current = min(current * 2, maximum)
        return d
    }

    public mutating func reset() { current = initial }
}

/// Native SSE client for `GET /api/v1/events` with a Bearer token (§4.7 step 3). Reconnects
/// with backoff and sends `Last-Event-ID`; the server replies with `hello` + full `state`.
public final class EventStreamClient: NSObject, URLSessionDataDelegate {
    public enum Status: Equatable {
        case connecting
        case open
        case disconnected(String)
        case unauthorized
    }

    public let url: URL
    public let token: String
    public var callbackQueue: DispatchQueue = .main
    public var onEvent: ((SSEEvent) -> Void)?
    public var onStatus: ((Status) -> Void)?
    /// Idle timeout; the server sends `: ping` every 15 s.
    public var idleTimeout: TimeInterval = 45

    private let q = OperationQueue()
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private let parser = SSEParser()
    private var backoff = ReconnectBackoff()
    private var stopped = true
    private var lastStatusCode = 0

    public init(baseURL: URL, token: String) {
        self.url = URL(string: "/api/v1/events", relativeTo: baseURL)!.absoluteURL
        self.token = token
        super.init()
        q.maxConcurrentOperationCount = 1
        q.name = "omniwatch.sse"
    }

    public convenience init(ready: ReadyLine) {
        self.init(baseURL: ready.baseURL, token: ready.token)
    }

    public var lastEventId: String? { parser.lastEventId }

    public func start() {
        q.addOperation {
            guard self.stopped else { return }
            self.stopped = false
            let c = URLSessionConfiguration.ephemeral
            c.httpShouldSetCookies = false
            c.httpCookieAcceptPolicy = .never
            c.timeoutIntervalForRequest = self.idleTimeout
            c.timeoutIntervalForResource = 60 * 60 * 24 * 365
            c.requestCachePolicy = .reloadIgnoringLocalCacheData
            c.connectionProxyDictionary = [:]
            self.session = URLSession(configuration: c, delegate: self, delegateQueue: self.q)
            self.connect()
        }
    }

    public func stop() {
        q.addOperation {
            self.stopped = true
            self.task?.cancel()
            self.task = nil
            self.session?.invalidateAndCancel() // breaks the session → delegate retain cycle
            self.session = nil
        }
    }

    private func connect() {
        guard !stopped, let session = session else { return }
        parser.resetConnection()
        lastStatusCode = 0
        var r = URLRequest(url: url)
        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        r.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        r.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        if let id = parser.lastEventId { r.setValue(id, forHTTPHeaderField: "Last-Event-ID") }
        r.timeoutInterval = idleTimeout
        emit(.connecting)
        let t = session.dataTask(with: r)
        task = t
        t.resume()
    }

    private func emit(_ s: Status) {
        let cb = onStatus
        callbackQueue.async { cb?(s) }
    }

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                           completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let http = response as? HTTPURLResponse
        lastStatusCode = http?.statusCode ?? 0
        let type = (http?.value(forHTTPHeaderField: "Content-Type") ?? "").lowercased()
        guard lastStatusCode == 200, type.hasPrefix("text/event-stream") else {
            emit(lastStatusCode == 401 ? .unauthorized : .disconnected("HTTP \(lastStatusCode) \(type)"))
            completionHandler(.cancel)
            return
        }
        backoff.reset()
        emit(.open)
        completionHandler(.allow)
    }

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        let events = parser.feed(data)
        guard !events.isEmpty else { return }
        let cb = onEvent
        callbackQueue.async { for e in events { cb?(e) } }
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard !stopped, task === self.task else { return }
        if lastStatusCode == 200 {
            emit(.disconnected(error.map { $0.localizedDescription } ?? "stream ended"))
        }
        let delay = max(backoff.next(), Double(parser.retryMs ?? 0) / 1000)
        DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.q.addOperation { self?.connect() }
        }
    }
}
