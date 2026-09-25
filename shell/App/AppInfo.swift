import Foundation

enum AppInfo {
    static var version: String {
        (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "0.0.0"
    }
    static var bundleIdentifier: String { Bundle.main.bundleIdentifier ?? "com.burnsbert.omniwatch" }
    static var resourcesDir: URL? { Bundle.main.resourceURL }
}

struct LaunchOptions {
    var selfTest = false
    var version = false
    /// Start the backend with `--demo` (also `OMNIWATCH_DEMO=1`).
    var demo = false
    /// `--backend X`: overrides `$OMNIWATCH_BACKEND` (script/zipapp path, or `-m module`).
    var backend: String?
    /// Passed by the LaunchAgent: start quietly in the menu bar, without showing the window.
    var launchedAtLogin = false

    static func parse(_ argv: [String]) -> LaunchOptions {
        var o = LaunchOptions()
        var i = 1
        while i < argv.count {
            let a = argv[i]
            switch a {
            case "--self-test": o.selfTest = true
            case "--version": o.version = true
            case "--demo": o.demo = true
            case LaunchAgent.loginFlag: o.launchedAtLogin = true
            case "--backend":
                if i + 1 < argv.count { o.backend = argv[i + 1]; i += 1 }
            default:
                if a.hasPrefix("--backend=") { o.backend = String(a.dropFirst("--backend=".count)) }
                // Anything else (e.g. -NSDocumentRevisionsDebugMode, -psn_…) is AppKit's business.
            }
            i += 1
        }
        let env = ProcessInfo.processInfo.environment
        if env["OMNIWATCH_DEMO"] == "1" { o.demo = true }
        return o
    }

    var backendOverride: String? { backend ?? ProcessInfo.processInfo.environment["OMNIWATCH_BACKEND"] }

    /// Builds the launch recipe: PythonLocator for the interpreter, the override or bundled zipapp.
    func makeLaunch(environment: [String: String], logFile: String?, demo: Bool) throws -> BackendLaunch {
        let program = try BackendLaunch.resolveProgram(override: backendOverride, resourcesDir: AppInfo.resourcesDir)
        let locator = PythonLocator(configDir: Paths.configDir(environment: environment), environment: environment,
                                    resourcesDir: AppInfo.resourcesDir)
        let python = try locator.locate()
        return BackendLaunch(python: python.path, program: program,
                             parentPid: ProcessInfo.processInfo.processIdentifier,
                             logFile: logFile, demo: demo, extraArgs: BackendLaunch.extraArgs(environment: environment))
    }
}
