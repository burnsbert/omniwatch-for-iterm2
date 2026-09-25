import AppKit

let options = LaunchOptions.parse(CommandLine.arguments)

if options.version {
    print(AppInfo.version)
    exit(0)
}

if options.selfTest {
    // Headless: no Dock icon, no menu bar, no windows — and the event loop never runs.
    NSApplication.shared.setActivationPolicy(.prohibited)
    exit(SelfTest(options: options).run())
}

let app = NSApplication.shared
let delegate = AppDelegate(options: options)
app.delegate = delegate
// Menu-bar-only mode (no Dock icon) is decided before anything shows.
app.setActivationPolicy(ShellSettings(store: UserDefaults.standard).menuBarOnly ? .accessory : .regular)
app.run()
