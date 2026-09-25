import Foundation

enum BackendAPITests {
    static let api = BackendAPI(baseURL: URL(string: "http://127.0.0.1:5000")!, token: "tok")

    static let all: [TestCase] = [
        TestCase(name: "requestsCarryBearerAndNoOrigin") {
            let r = api.gotoRequest(uid: "AAAA-1")
            checkEqual(r.httpMethod, "POST")
            checkEqual(r.url?.absoluteString, "http://127.0.0.1:5000/api/v1/sessions/AAAA-1/goto")
            checkEqual(r.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
            checkEqual(r.value(forHTTPHeaderField: "Origin"), nil)
            checkEqual(api.shutdownRequest().url?.path, "/api/v1/shutdown")
            checkEqual(api.healthRequest().httpMethod, "GET")
            checkEqual(api.stateRequest().url?.path, "/api/v1/state")
        },
        TestCase(name: "uidIsEscapedAsOneSegment") {
            checkEqual(api.gotoRequest(uid: "a/b?c#d").url?.absoluteString,
                       "http://127.0.0.1:5000/api/v1/sessions/a%2Fb%3Fc%23d/goto")
        },
        TestCase(name: "patchPrefsBody") {
            let r = api.patchPrefsRequest(["keep_on_top": true])
            checkEqual(r.httpMethod, "PATCH")
            checkEqual(r.value(forHTTPHeaderField: "Content-Type"), "application/json")
            checkEqual(r.httpBody.flatMap { String(data: $0, encoding: .utf8) }, #"{"keep_on_top":true}"#)
        },
        TestCase(name: "readyInit") {
            let a = BackendAPI(ready: ReadyLine(port: 7, token: "t", pid: 1, version: "", demo: false))
            checkEqual(a.baseURL.absoluteString, "http://127.0.0.1:7")
            checkEqual(a.token, "t")
        },
    ]
}
