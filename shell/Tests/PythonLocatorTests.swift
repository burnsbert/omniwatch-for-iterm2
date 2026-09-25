import Foundation

enum PythonLocatorTests {
    typealias R = PythonLocator.ProbeResult

    static func locator(config: String? = nil, env: [String: String] = [:], pythonPath: String? = nil,
                        executables: Set<String>, probes: [String: R]) -> PythonLocator {
        let cfgDir = URL(fileURLWithPath: "/cfg"), resDir = URL(fileURLWithPath: "/res")
        return PythonLocator(configDir: cfgDir, environment: env, resourcesDir: resDir,
                             isExecutable: { executables.contains($0) },
                             readFile: { url in
                                 if url.path == "/cfg/config.json", let c = config { return Data(c.utf8) }
                                 if url.path == "/res/python-path", let p = pythonPath { return Data(p.utf8) }
                                 return nil
                             },
                             probe: { probes[$0] })
    }

    static let hb = "/opt/homebrew/bin/python3", ul = "/usr/local/bin/python3", sys = "/usr/bin/python3"

    static let all: [TestCase] = [
        TestCase(name: "prefersDefaultWithIterm2") {
            let l = locator(executables: [hb, sys], probes: [hb: R(major: 3, minor: 13, hasIterm2: false),
                                                             sys: R(major: 3, minor: 9, hasIterm2: true)])
            let c = try l.locate()
            checkEqual(c.path, sys); checkEqual(c.source, "default"); check(c.probe.hasIterm2)
        },
        TestCase(name: "firstSupportedDefaultWithoutIterm2") {
            let l = locator(executables: [hb, ul, sys], probes: [hb: R(major: 3, minor: 8, hasIterm2: true),
                                                                 ul: R(major: 3, minor: 11, hasIterm2: false),
                                                                 sys: R(major: 3, minor: 9, hasIterm2: false)])
            checkEqual(try l.locate().path, ul) // 3.8 rejected even with iterm2
        },
        TestCase(name: "explicitOrderConfigEnvPythonPath") {
            let probes: [String: R] = ["/c/py": R(major: 3, minor: 12, hasIterm2: false),
                                       "/e/py": R(major: 3, minor: 12, hasIterm2: true),
                                       "/p/py": R(major: 3, minor: 12, hasIterm2: true),
                                       hb: R(major: 3, minor: 13, hasIterm2: true)]
            let all: Set<String> = ["/c/py", "/e/py", "/p/py", hb]
            let l1 = locator(config: #"{"python":"/c/py"}"#, env: ["OMNIWATCH_PYTHON": "/e/py"], pythonPath: "/p/py\n",
                             executables: all, probes: probes)
            let c1 = try l1.locate()
            checkEqual(c1.path, "/c/py"); checkEqual(c1.source, "config.json") // explicit wins without iterm2
            let l2 = locator(env: ["OMNIWATCH_PYTHON": "/e/py"], pythonPath: "/p/py", executables: all, probes: probes)
            checkEqual(try l2.locate().source, "OMNIWATCH_PYTHON")
            let l3 = locator(pythonPath: " /p/py \n", executables: all, probes: probes)
            checkEqual(try l3.locate().source, "python-path")
            checkEqual(l1.explicitCandidates().map { $0.path }, ["/c/py", "/e/py", "/p/py"])
        },
        TestCase(name: "brokenExplicitFallsThrough") {
            let l = locator(config: #"{"python":"/missing"}"#, env: ["OMNIWATCH_PYTHON": "/old"],
                            executables: ["/old", sys], probes: ["/old": R(major: 2, minor: 7, hasIterm2: false),
                                                                 sys: R(major: 3, minor: 9, hasIterm2: false)])
            checkEqual(try l.locate().path, sys)
        },
        TestCase(name: "tildeExpansionAndBadConfig") {
            let l = locator(config: #"{"python":"~/venv/bin/python3"}"#, env: ["HOME": "/Users/me"],
                            executables: [], probes: [:])
            checkEqual(l.explicitCandidates().map { $0.path }, ["/Users/me/venv/bin/python3"])
            let bad = locator(config: "{nope", executables: [], probes: [:])
            checkEqual(bad.explicitCandidates().count, 0)
            let empty = locator(config: #"{"python":"  "}"#, env: ["OMNIWATCH_PYTHON": ""], executables: [], probes: [:])
            checkEqual(empty.explicitCandidates().count, 0)
        },
        TestCase(name: "noneFound") {
            let l = locator(executables: [], probes: [:])
            do { _ = try l.locate(); check(false) } catch let e as PythonLocator.LocateError {
                check("\(e)".contains("/usr/bin/python3"), "\(e)")
            }
        },
        TestCase(name: "parseProbeOutput") {
            checkEqual(PythonLocator.parseProbeOutput("3 13 1\n"), R(major: 3, minor: 13, hasIterm2: true))
            checkEqual(PythonLocator.parseProbeOutput("3 9 0"), R(major: 3, minor: 9, hasIterm2: false))
            checkEqual(PythonLocator.parseProbeOutput("Python 3.9"), nil)
            check(R(major: 4, minor: 0, hasIterm2: false).isSupported)
            check(!R(major: 3, minor: 8, hasIterm2: false).isSupported)
        },
        TestCase(name: "realProbeOfLocalPython") {
            guard let py = TestPaths.python else { return }
            let r = PythonLocator.runProbe(py)
            check(r != nil, "probe of \(py) failed")
            checkEqual(r?.major, 3)
            checkEqual(PythonLocator.runProbe("/nonexistent/python3"), nil)
        },
    ]
}
