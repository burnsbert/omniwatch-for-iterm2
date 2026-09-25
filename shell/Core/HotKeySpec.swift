import Foundation

/// A global hotkey parsed from config.json (`"ctrl+opt+cmd+o"`), expressed with Carbon's
/// virtual key codes and modifier masks so the App layer can pass it straight to
/// `RegisterEventHotKey`. Core stays Carbon-free, so the constants are duplicated here.
public struct HotKeySpec: Equatable {
    public static let cmdKey: UInt32 = 0x0100
    public static let shiftKey: UInt32 = 0x0200
    public static let optionKey: UInt32 = 0x0800
    public static let controlKey: UInt32 = 0x1000

    public let keyCode: UInt32
    public let modifiers: UInt32
    public let key: String

    public static let defaultToggle = "ctrl+opt+cmd+o"

    /// Returns nil for null/empty/"off"/"none" or anything unparseable. At least one of
    /// cmd/ctrl/opt is required so a bare letter can never be grabbed system-wide.
    public static func parse(_ spec: String?) -> HotKeySpec? {
        guard let spec = spec?.trimmingCharacters(in: .whitespaces).lowercased(), !spec.isEmpty,
              !["off", "none", "null", "false"].contains(spec) else { return nil }
        let parts = spec.split(separator: "+", omittingEmptySubsequences: false).map {
            $0.trimmingCharacters(in: .whitespaces)
        }
        guard let keyName = parts.last, !keyName.isEmpty else { return nil }
        var mods: UInt32 = 0
        for p in parts.dropLast() {
            switch p {
            case "cmd", "command", "⌘": mods |= cmdKey
            case "shift", "⇧": mods |= shiftKey
            case "opt", "option", "alt", "⌥": mods |= optionKey
            case "ctrl", "control", "⌃": mods |= controlKey
            default: return nil
            }
        }
        guard mods & (cmdKey | optionKey | controlKey) != 0 else { return nil }
        guard let code = keyCodes[keyName] else { return nil }
        return HotKeySpec(keyCode: code, modifiers: mods, key: keyName)
    }

    /// Human form for menus: "⌃⌥⌘O".
    public var display: String {
        var s = ""
        if modifiers & HotKeySpec.controlKey != 0 { s += "⌃" }
        if modifiers & HotKeySpec.optionKey != 0 { s += "⌥" }
        if modifiers & HotKeySpec.shiftKey != 0 { s += "⇧" }
        if modifiers & HotKeySpec.cmdKey != 0 { s += "⌘" }
        return s + (key.count == 1 ? key.uppercased() : key.capitalized)
    }

    // kVK_ANSI_* / kVK_* from Carbon's Events.h.
    static let keyCodes: [String: UInt32] = [
        "a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05, "z": 0x06, "x": 0x07,
        "c": 0x08, "v": 0x09, "b": 0x0B, "q": 0x0C, "w": 0x0D, "e": 0x0E, "r": 0x0F, "y": 0x10,
        "t": 0x11, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "6": 0x16, "5": 0x17, "=": 0x18,
        "9": 0x19, "7": 0x1A, "-": 0x1B, "8": 0x1C, "0": 0x1D, "]": 0x1E, "o": 0x1F, "u": 0x20,
        "[": 0x21, "i": 0x22, "p": 0x23, "l": 0x25, "j": 0x26, "'": 0x27, "k": 0x28, ";": 0x29,
        "\\": 0x2A, ",": 0x2B, "/": 0x2C, "n": 0x2D, "m": 0x2E, ".": 0x2F, "`": 0x32,
        "return": 0x24, "enter": 0x24, "tab": 0x30, "space": 0x31, "escape": 0x35, "esc": 0x35,
        "f1": 0x7A, "f2": 0x78, "f3": 0x63, "f4": 0x76, "f5": 0x60, "f6": 0x61, "f7": 0x62,
        "f8": 0x64, "f9": 0x65, "f10": 0x6D, "f11": 0x67, "f12": 0x6F,
        "left": 0x7B, "right": 0x7C, "down": 0x7D, "up": 0x7E,
    ]
}
