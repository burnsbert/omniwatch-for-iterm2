import Foundation

enum ReadyLineTests {
    static let good = #"{"event":"ready","port":53817,"token":"abc_DEF-123","pid":1234,"version":"1.0.0","demo":false}"#

    static let all: [TestCase] = [
        TestCase(name: "parsesDesignExample") {
            let r = try ReadyLine.parse(good)
            checkEqual(r, ReadyLine(port: 53817, token: "abc_DEF-123", pid: 1234, version: "1.0.0", demo: false))
            checkEqual(r.authURL.absoluteString, "http://127.0.0.1:53817/auth?token=abc_DEF-123")
            checkEqual(r.baseURL.absoluteString, "http://127.0.0.1:53817")
        },
        TestCase(name: "toleratesWhitespaceCRAndExtraFields") {
            let r = try ReadyLine.parse("  {\"event\":\"ready\",\"port\":1,\"token\":\"t\",\"pid\":2,\"demo\":true,\"new\":[1]}\r\n")
            checkEqual(r.port, 1)
            checkEqual(r.demo, true)
            checkEqual(r.version, "")
        },
        TestCase(name: "rejectsNonJSON") {
            do { _ = try ReadyLine.parse("Traceback (most recent call last):"); check(false, "no throw") }
            catch let e as ReadyLine.ParseError { checkEqual(e, .notJSON) }
            checkThrows { _ = try ReadyLine.parse("[1,2]") }
            checkThrows { _ = try ReadyLine.parse("") }
        },
        TestCase(name: "rejectsWrongEvent") {
            do { _ = try ReadyLine.parse(#"{"event":"hello","port":1,"token":"t","pid":2}"#); check(false) }
            catch let e as ReadyLine.ParseError { checkEqual(e, .wrongEvent("hello")) }
            do { _ = try ReadyLine.parse(#"{"port":1,"token":"t","pid":2}"#); check(false) }
            catch let e as ReadyLine.ParseError { checkEqual(e, .wrongEvent(nil)) }
        },
        TestCase(name: "rejectsBadPort") {
            for bad in ["0", "65536", "-1", "\"80\"", "80.5", "true"] {
                do { _ = try ReadyLine.parse("{\"event\":\"ready\",\"port\":\(bad),\"token\":\"t\",\"pid\":2}"); check(false, bad) }
                catch let e as ReadyLine.ParseError { checkEqual(e, .invalidField("port"), bad) }
            }
            do { _ = try ReadyLine.parse(#"{"event":"ready","token":"t","pid":2}"#); check(false) }
            catch let e as ReadyLine.ParseError { checkEqual(e, .missingField("port")) }
        },
        TestCase(name: "rejectsBadToken") {
            for bad in ["\"\"", "5", "\"a b\"", "\"a&b=c\"", "\"é\""] {
                do { _ = try ReadyLine.parse("{\"event\":\"ready\",\"port\":80,\"token\":\(bad),\"pid\":2}"); check(false, bad) }
                catch let e as ReadyLine.ParseError { checkEqual(e, .invalidField("token"), bad) }
            }
            do { _ = try ReadyLine.parse(#"{"event":"ready","port":80,"pid":2}"#); check(false) }
            catch let e as ReadyLine.ParseError { checkEqual(e, .missingField("token")) }
        },
        TestCase(name: "rejectsBadPidAndDemo") {
            do { _ = try ReadyLine.parse(#"{"event":"ready","port":80,"token":"t","pid":0}"#); check(false) }
            catch let e as ReadyLine.ParseError { checkEqual(e, .invalidField("pid")) }
            do { _ = try ReadyLine.parse(#"{"event":"ready","port":80,"token":"t"}"#); check(false) }
            catch let e as ReadyLine.ParseError { checkEqual(e, .missingField("pid")) }
            do { _ = try ReadyLine.parse(#"{"event":"ready","port":80,"token":"t","pid":3,"demo":1}"#); check(false) }
            catch let e as ReadyLine.ParseError { checkEqual(e, .invalidField("demo")) }
            check(!"\(ReadyLine.ParseError.invalidField("pid"))".isEmpty)
        },
        TestCase(name: "real43CharToken") {
            let tok = "Zx9_-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789ab" // token_urlsafe(32) is 43 chars
            checkEqual(tok.count, 43)
            let r = try ReadyLine.parse("{\"event\":\"ready\",\"port\":5,\"token\":\"\(tok)\",\"pid\":9,\"version\":\"1.0.0\",\"demo\":true}")
            checkEqual(r.token, tok)
        },
    ]
}
