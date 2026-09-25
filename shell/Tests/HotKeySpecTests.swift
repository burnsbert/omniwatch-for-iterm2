import Foundation

enum HotKeySpecTests {
    static let all: [TestCase] = [
        TestCase(name: "defaultToggle") {
            let h = HotKeySpec.parse(HotKeySpec.defaultToggle)
            checkEqual(h?.keyCode, 0x1F) // kVK_ANSI_O
            checkEqual(h?.modifiers, HotKeySpec.controlKey | HotKeySpec.optionKey | HotKeySpec.cmdKey)
            checkEqual(h?.display, "⌃⌥⌘O")
        },
        TestCase(name: "aliasesCaseAndSpaces") {
            let h = HotKeySpec.parse(" Control + Alt + Shift + F5 ")
            checkEqual(h?.keyCode, 0x60)
            checkEqual(h?.modifiers, HotKeySpec.controlKey | HotKeySpec.optionKey | HotKeySpec.shiftKey)
            checkEqual(h?.display, "⌃⌥⇧F5")
            checkEqual(HotKeySpec.parse("cmd+shift+space")?.keyCode, 0x31)
            checkEqual(HotKeySpec.parse("⌘+⇧+1")?.modifiers, HotKeySpec.cmdKey | HotKeySpec.shiftKey)
        },
        TestCase(name: "rejects") {
            for bad: String? in [nil, "", "off", "none", "o", "shift+o", "cmd+", "hyper+o", "cmd+unknownkey", "cmd++"] {
                checkEqual(HotKeySpec.parse(bad), nil, String(describing: bad))
            }
        },
    ]
}
