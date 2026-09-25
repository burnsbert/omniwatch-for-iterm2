import Foundation

/// Authenticated calls from the shell to the backend (§4.4). Uses `Authorization: Bearer`
/// and sends no `Origin`, which the backend accepts for non-GET requests (§4.5).
public struct BackendAPI {
    public let baseURL: URL
    public let token: String
    public var session: URLSession

    public init(baseURL: URL, token: String, session: URLSession = BackendAPI.sharedSession) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
    }

    public init(ready: ReadyLine, session: URLSession = BackendAPI.sharedSession) {
        self.init(baseURL: ready.baseURL, token: ready.token, session: session)
    }

    public static let sharedSession: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.httpShouldSetCookies = false
        c.httpCookieAcceptPolicy = .never
        c.timeoutIntervalForRequest = 5
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.connectionProxyDictionary = [:]
        return URLSession(configuration: c)
    }()

    static let segmentAllowed: CharacterSet = {
        var s = CharacterSet.urlPathAllowed
        s.remove(charactersIn: "/?#;")
        return s
    }()

    public static func pathSegment(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: segmentAllowed) ?? s
    }

    public func request(_ method: String, _ path: String, json: Any? = nil) -> URLRequest {
        var r = URLRequest(url: URL(string: path, relativeTo: baseURL)!.absoluteURL)
        r.httpMethod = method
        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body = json {
            r.httpBody = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return r
    }

    public func gotoRequest(uid: String) -> URLRequest {
        request("POST", "/api/v1/sessions/\(BackendAPI.pathSegment(uid))/goto")
    }

    public func patchPrefsRequest(_ prefs: [String: Any]) -> URLRequest {
        request("PATCH", "/api/v1/prefs", json: prefs)
    }

    public func shutdownRequest() -> URLRequest { request("POST", "/api/v1/shutdown") }
    public func healthRequest() -> URLRequest { request("GET", "/api/v1/health") }
    public func stateRequest() -> URLRequest { request("GET", "/api/v1/state") }

    public typealias Completion = (_ status: Int, _ body: Data?, _ error: Error?) -> Void

    public func send(_ req: URLRequest, completion: Completion? = nil) {
        session.dataTask(with: req) { data, resp, err in
            completion?((resp as? HTTPURLResponse)?.statusCode ?? 0, data, err)
        }.resume()
    }

    /// Synchronous send (self-test and quit path only; never on the main thread in the app).
    public func sendSync(_ req: URLRequest, timeout: TimeInterval = 5) -> (status: Int, body: Data?, error: Error?) {
        let sem = DispatchSemaphore(value: 0)
        var result: (Int, Data?, Error?) = (0, nil, nil)
        send(req) { s, b, e in result = (s, b, e); sem.signal() }
        if sem.wait(timeout: .now() + timeout) == .timedOut {
            return (0, nil, URLError(.timedOut))
        }
        return result
    }
}
