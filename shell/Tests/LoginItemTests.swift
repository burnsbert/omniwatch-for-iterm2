import Foundation

final class MemoryFileSystem: FileSystem {
    var files: [String: Data] = [:]
    var extraExisting: Set<String> = []
    var writes = 0
    func read(_ url: URL) -> Data? { files[url.path] }
    func exists(_ path: String) -> Bool { files[path] != nil || extraExisting.contains(path) }
    func write(_ data: Data, to url: URL) throws { files[url.path] = data; writes += 1 }
    func remove(_ url: URL) throws { files.removeValue(forKey: url.path) }
}

final class DictStore: BoolStore {
    var values: [String: Bool] = [:]
    func bool(forKey key: String) -> Bool { values[key] ?? false }
    func set(_ value: Bool, forKey key: String) { values[key] = value }
}

enum LoginItemTests {
    static let dir = URL(fileURLWithPath: "/home/me/Library/LaunchAgents")
    static let app = "/Users/me/Applications/Omniwatch.app"

    static func plist(_ fs: MemoryFileSystem) -> [String: Any]? {
        fs.files["/home/me/Library/LaunchAgents/com.burnsbert.omniwatch.login.plist"].flatMap {
            try? PropertyListSerialization.propertyList(from: $0, format: nil) as? [String: Any]
        }
    }

    static let all: [TestCase] = [
        TestCase(name: "enableWritesAgentPlist") {
            let fs = MemoryFileSystem()
            let a = LaunchAgent(agentsDir: dir, fs: fs)
            checkEqual(a.status(), .disabled)
            try a.enable(appPath: app)
            checkEqual(a.status(), .enabled(appPath: app))
            check(a.isEnabled)
            let p = plist(fs)
            checkEqual(p?["Label"] as? String, "com.burnsbert.omniwatch.login")
            checkEqual(p?["ProgramArguments"] as? [String], ["/usr/bin/open", "-a", app, "--args", "--launched-at-login"])
            checkEqual(p?["RunAtLoad"] as? Bool, true)
            checkEqual(p?["KeepAlive"] as? Bool, nil)
            checkEqual(p?["LimitLoadToSessionType"] as? String, "Aqua")
            checkEqual(p?["AssociatedBundleIdentifiers"] as? [String], ["com.burnsbert.omniwatch"])
            checkEqual(a.plistURL.path, "/home/me/Library/LaunchAgents/com.burnsbert.omniwatch.login.plist")
        },
        TestCase(name: "disableRemovesAndIsIdempotent") {
            let fs = MemoryFileSystem()
            let a = LaunchAgent(agentsDir: dir, fs: fs)
            try a.setEnabled(true, appPath: app)
            try a.setEnabled(false, appPath: app)
            checkEqual(a.status(), .disabled)
            checkEqual(fs.files.count, 0)
            try a.disable()
        },
        TestCase(name: "foreignFileNeverTouched") {
            let fs = MemoryFileSystem()
            let a = LaunchAgent(agentsDir: dir, fs: fs)
            let foreign = Data("not a plist".utf8)
            fs.files[a.plistURL.path] = foreign
            checkEqual(a.status(), .foreign)
            checkThrows { try a.enable(appPath: app) }
            checkThrows { try a.disable() }
            checkEqual(fs.files[a.plistURL.path], foreign)
            let other = try PropertyListSerialization.data(fromPropertyList: ["Label": "someone.else", "ProgramArguments": ["/bin/x"]],
                                                           format: .xml, options: 0)
            fs.files[a.plistURL.path] = other
            checkEqual(a.status(), .foreign)
        },
        TestCase(name: "rejectsNonAppPaths") {
            let a = LaunchAgent(agentsDir: dir, fs: MemoryFileSystem())
            for bad in ["relative/Omniwatch.app", "/usr/bin/python3", ""] {
                do { try a.enable(appPath: bad); check(false, bad) } catch let e as LaunchAgent.AgentError {
                    checkEqual(e, .badAppPath(bad))
                }
            }
        },
        TestCase(name: "repairOnlyWhenRecordedAppIsGone") {
            let fs = MemoryFileSystem()
            let a = LaunchAgent(agentsDir: dir, fs: fs)
            try a.enable(appPath: "/old/Omniwatch.app")
            fs.extraExisting.insert("/old/Omniwatch.app")
            checkEqual(try a.repairIfNeeded(appPath: app), false) // old copy still there: user's choice
            fs.extraExisting.removeAll()
            checkEqual(try a.repairIfNeeded(appPath: app), true)
            checkEqual(a.status(), .enabled(appPath: app))
            checkEqual(try a.repairIfNeeded(appPath: app), false)
            try a.disable()
            checkEqual(try a.repairIfNeeded(appPath: app), false) // disabled stays disabled
            checkEqual(a.status(), .disabled)
        },
        TestCase(name: "realFileSystemInTempDir") {
            let tmp = TestPaths.tempDir()
            defer { try? FileManager.default.removeItem(at: tmp) }
            let a = LaunchAgent(agentsDir: tmp.appendingPathComponent("Library/LaunchAgents"))
            check(a.plistURL.path.hasPrefix(tmp.path), "must stay in the temp dir")
            try a.enable(appPath: app)
            checkEqual(a.status(), .enabled(appPath: app))
            // launchd's own validator accepts it.
            let lint = Process()
            lint.executableURL = URL(fileURLWithPath: "/usr/bin/plutil")
            lint.arguments = ["-lint", "-s", a.plistURL.path]
            try lint.run(); lint.waitUntilExit()
            checkEqual(lint.terminationStatus, 0)
            try a.disable()
            check(!FileManager.default.fileExists(atPath: a.plistURL.path))
            checkEqual(LaunchAgent.defaultAgentsDir(home: "/h").path, "/h/Library/LaunchAgents")
        },
        TestCase(name: "shellSettingsMenuBarOnly") {
            let store = DictStore()
            let s = ShellSettings(store: store)
            checkEqual(s.menuBarOnly, false)
            s.menuBarOnly = true
            checkEqual(store.values["menuBarOnly"], true)
            checkEqual(ShellSettings(store: store).menuBarOnly, true)
        },
        TestCase(name: "bridgeNativeSettingsMessages") {
            checkEqual(BridgeMessage.parse(["type": "launchAtLogin", "value": true]), .launchAtLogin(true))
            checkEqual(BridgeMessage.parse(["type": "menuBarOnly", "value": false]), .menuBarOnly(false))
            checkEqual(BridgeMessage.parse(["type": "menuBarOnly", "value": "yes"]), nil)
            checkEqual(BridgeMessage.parse(["type": "launchAtLogin"]), nil)
            checkEqual(BridgeJS.nativeEvent(BridgeJS.nativeSettings(launchAtLogin: true, menuBarOnly: false)),
                       "window.omniwatch && window.omniwatch.nativeEvent && window.omniwatch.nativeEvent({\"launchAtLogin\":true,\"menuBarOnly\":false,\"type\":\"nativeSettings\"});")
            checkEqual(BridgeJS.nativeSettings(launchAtLogin: false, menuBarOnly: true, error: "x")["launchAtLoginError"] as? String, "x")
        },
    ]
}
