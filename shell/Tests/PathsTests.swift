import Foundation

enum PathsTests {
    static let all: [TestCase] = [
        TestCase(name: "configDirPrecedence") {
            checkEqual(Paths.configDir(environment: ["OMNIWATCH_CONFIG_DIR": "/t/c", "XDG_CONFIG_HOME": "/x"], home: "/h").path, "/t/c")
            checkEqual(Paths.configDir(environment: ["XDG_CONFIG_HOME": "/x"], home: "/h").path, "/x/omniwatch")
            checkEqual(Paths.configDir(environment: [:], home: "/h").path, "/h/.config/omniwatch")
            checkEqual(Paths.logsDir(home: "/h").path, "/h/Library/Logs/Omniwatch")
        },
        TestCase(name: "shellConfigHotkeys") {
            checkEqual(ShellConfig.parse(nil), ShellConfig(toggleHotKey: "ctrl+opt+cmd+o", nextWaitingHotKey: nil))
            checkEqual(ShellConfig.parse(Data("{}".utf8)).toggleHotKey, "ctrl+opt+cmd+o")
            checkEqual(ShellConfig.parse(Data(#"{"hotkeys":{"toggle":null,"next_waiting":"ctrl+opt+cmd+n"}}"#.utf8)),
                       ShellConfig(toggleHotKey: nil, nextWaitingHotKey: "ctrl+opt+cmd+n"))
            checkEqual(ShellConfig.parse(Data(#"{"hotkeys":{"toggle":"cmd+shift+o"}}"#.utf8)).toggleHotKey, "cmd+shift+o")
            checkEqual(ShellConfig.parse(Data("garbage".utf8)), ShellConfig())
        },
        TestCase(name: "shellLogWritesAndTruncates") {
            let dir = TestPaths.tempDir()
            defer { try? FileManager.default.removeItem(at: dir) }
            let url = dir.appendingPathComponent("sub/shell.log")
            let log = ShellLog(url: url)
            log.log("first")
            log.flush()
            let s1 = try String(contentsOf: url, encoding: .utf8)
            check(s1.contains("first"))
            let log2 = ShellLog(url: url)
            log2.log("second")
            log2.flush()
            let s = try String(contentsOf: url, encoding: .utf8)
            check(!s.contains("first") && s.contains("second"), s)
        },
        TestCase(name: "backendLaunchArgv") {
            let l = BackendLaunch(python: "/py", program: ["/r/omniwatch.pyz"], parentPid: 42, logFile: "/l/backend.log",
                                  demo: true, extraArgs: ["--demo-seed", "7"])
            checkEqual(l.argv, ["/py", "/r/omniwatch.pyz", "serve", "--ready-json", "--parent-pid", "42",
                                "--log-file", "/l/backend.log", "--demo", "--demo-seed", "7"])
            let l2 = BackendLaunch(python: "/py", program: ["-m", "omniwatch"], parentPid: 1, logFile: nil, demo: false)
            checkEqual(l2.argv, ["/py", "-m", "omniwatch", "serve", "--ready-json", "--parent-pid", "1"])
            checkEqual(BackendLaunch.extraArgs(environment: ["OMNIWATCH_BACKEND_ARGS": " --a  1\t--b "]), ["--a", "1", "--b"])
            checkEqual(BackendLaunch.extraArgs(environment: [:]), [])
        },
        TestCase(name: "backendProgramResolution") {
            let res = URL(fileURLWithPath: "/app/Resources")
            let has: (String) -> Bool = { $0 == "/app/Resources/omniwatch.pyz" || $0 == "/x/fake.py" }
            checkEqual(try BackendLaunch.resolveProgram(override: nil, resourcesDir: res, fileExists: has), ["/app/Resources/omniwatch.pyz"])
            checkEqual(try BackendLaunch.resolveProgram(override: "/x/fake.py", resourcesDir: res, fileExists: has), ["/x/fake.py"])
            checkEqual(try BackendLaunch.resolveProgram(override: " -m  omniwatch ", resourcesDir: res, fileExists: has), ["-m", "omniwatch"])
            checkThrows { _ = try BackendLaunch.resolveProgram(override: "-m", resourcesDir: res, fileExists: has) }
            checkThrows { _ = try BackendLaunch.resolveProgram(override: "/missing.py", resourcesDir: res, fileExists: has) }
            checkThrows { _ = try BackendLaunch.resolveProgram(override: nil, resourcesDir: res, fileExists: { _ in false }) }
            checkEqual(try BackendLaunch.resolveProgram(override: "", resourcesDir: res, fileExists: has), ["/app/Resources/omniwatch.pyz"])
            checkEqual(try BackendLaunch.resolveProgram(override: "../x/fake.py", resourcesDir: res, currentDirectory: "/repo",
                                                        fileExists: has), ["/x/fake.py"])
        },
    ]
}
