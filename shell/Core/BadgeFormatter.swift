import Foundation

/// Text for the dock badge, menu-bar item, and window title (§2.8 step 4).
public enum BadgeFormatter {
    /// Dock badge: "" for 0 (no badge), "3", "99+".
    public static func badge(_ count: Int) -> String {
        if count <= 0 { return "" }
        return count > 99 ? "99+" : String(count)
    }

    /// Menu-bar title: `◉ 2` when anyone is waiting, a bare `○` otherwise.
    public static func menuBarTitle(_ count: Int) -> String {
        count > 0 ? "◉ \(badge(count))" : "○"
    }

    /// Window title (§2.1): "Omniwatch — 2 waiting" / "Omniwatch".
    public static func windowTitle(_ count: Int) -> String {
        count > 0 ? "Omniwatch — \(count) waiting" : "Omniwatch"
    }

    /// Dropdown header line.
    public static func menuHeader(_ count: Int) -> String {
        switch count {
        case ..<1: return "No sessions waiting"
        case 1: return "1 session waiting"
        default: return "\(count) sessions waiting"
        }
    }

    /// Compact age like the web UI's `wait 3m` (P-30): "12s", "3m", "2h 5m", "1d 4h".
    public static func age(_ seconds: Double) -> String {
        let s = max(0, Int(seconds))
        if s < 60 { return "\(s)s" }
        let m = s / 60
        if m < 60 { return "\(m)m" }
        let h = m / 60
        if h < 24 { return m % 60 == 0 ? "\(h)h" : "\(h)h \(m % 60)m" }
        let d = h / 24
        return h % 24 == 0 ? "\(d)d" : "\(d)d \(h % 24)h"
    }
}
