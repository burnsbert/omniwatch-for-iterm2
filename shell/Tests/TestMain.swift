import Foundation

// Tiny assert harness (no XCTest in Command Line Tools). Each test runs in isolation: a
// thrown error or failed check marks only that test failed. Exit code 1 on any failure.

struct TestCase {
    let name: String
    let body: () throws -> Void
}

final class TestRun {
    static var checks = 0
    static var currentFailures: [String] = []
}

func check(_ condition: @autoclosure () -> Bool, _ message: @autoclosure () -> String = "",
           file: StaticString = #fileID, line: UInt = #line) {
    TestRun.checks += 1
    if !condition() { TestRun.currentFailures.append("\(file):\(line): check failed \(message())") }
}

func checkEqual<T: Equatable>(_ a: T, _ b: T, _ message: @autoclosure () -> String = "",
                              file: StaticString = #fileID, line: UInt = #line) {
    TestRun.checks += 1
    if a != b { TestRun.currentFailures.append("\(file):\(line): \(a) != \(b) \(message())") }
}

func checkThrows(_ message: @autoclosure () -> String = "", file: StaticString = #fileID, line: UInt = #line,
                 _ body: () throws -> Void) {
    TestRun.checks += 1
    do {
        try body()
        TestRun.currentFailures.append("\(file):\(line): expected an error \(message())")
    } catch {}
}

struct Unexpected: Error, CustomStringConvertible { let description: String }

/// Spins the main run loop until `condition` holds or `timeout` passes.
@discardableResult
func waitUntil(_ timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() {
        if Date() > deadline { return false }
        RunLoop.main.run(until: Date().addingTimeInterval(0.02))
    }
    return true
}

enum TestPaths {
    static let testsDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    static let fixtures = testsDir.appendingPathComponent("fixtures")
    static let fakeBackend = testsDir.appendingPathComponent("fake_backend.py").path
    static func fixture(_ name: String) throws -> String {
        try String(contentsOf: fixtures.appendingPathComponent(name), encoding: .utf8)
    }
    static let python: String? = {
        for p in ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"]
        where FileManager.default.isExecutableFile(atPath: p) { return p }
        return nil
    }()
    static func tempDir() -> URL {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("ow-shell-tests-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }
}

@main
enum TestMain {
    static func main() {
        let suites: [(String, [TestCase])] = [
            ("ReadyLine", ReadyLineTests.all),
            ("SSEParser", SSEParserTests.all),
            ("Models", ModelsTests.all),
            ("ShellModel", ShellModelTests.all),
            ("RestartPolicy", RestartPolicyTests.all),
            ("PythonLocator", PythonLocatorTests.all),
            ("BadgeFormatter", BadgeFormatterTests.all),
            ("HotKeySpec", HotKeySpecTests.all),
            ("Paths", PathsTests.all),
            ("Bridge", BridgeTests.all),
            ("LoginItem", LoginItemTests.all),
            ("Stall", StallTests.all),
            ("RealBackendFixture", RealBackendFixtureTests.all),
            ("BackendAPI", BackendAPITests.all),
            ("BackendProcess", BackendProcessTests.all),
            ("EventStreamClient", EventStreamClientTests.all),
        ]
        let filter = CommandLine.arguments.dropFirst().first
        var passed = 0, failed = 0
        var failures: [String] = []
        for (suite, cases) in suites {
            for t in cases {
                let full = "\(suite).\(t.name)"
                if let f = filter, !full.contains(f) { continue }
                TestRun.currentFailures = []
                do { try t.body() } catch { TestRun.currentFailures.append("threw: \(error)") }
                if TestRun.currentFailures.isEmpty {
                    passed += 1
                    print("PASS \(full)")
                } else {
                    failed += 1
                    print("FAIL \(full)")
                    for f in TestRun.currentFailures { print("     \(f)") }
                    failures.append(full)
                }
            }
        }
        print("\(passed + failed) tests, \(TestRun.checks) checks, \(failed) failures")
        if !failures.isEmpty { print("failed: \(failures.joined(separator: ", "))") }
        exit(failed == 0 ? 0 : 1)
    }
}
