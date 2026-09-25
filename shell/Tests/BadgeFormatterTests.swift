import Foundation

enum BadgeFormatterTests {
    static let all: [TestCase] = [
        TestCase(name: "badge") {
            checkEqual(BadgeFormatter.badge(0), "")
            checkEqual(BadgeFormatter.badge(-2), "")
            checkEqual(BadgeFormatter.badge(3), "3")
            checkEqual(BadgeFormatter.badge(99), "99")
            checkEqual(BadgeFormatter.badge(100), "99+")
        },
        TestCase(name: "titles") {
            checkEqual(BadgeFormatter.menuBarTitle(0), "○")
            checkEqual(BadgeFormatter.menuBarTitle(2), "◉ 2")
            checkEqual(BadgeFormatter.menuBarTitle(250), "◉ 99+")
            checkEqual(BadgeFormatter.windowTitle(0), "Omniwatch")
            checkEqual(BadgeFormatter.windowTitle(2), "Omniwatch — 2 waiting")
            checkEqual(BadgeFormatter.menuHeader(0), "No sessions waiting")
            checkEqual(BadgeFormatter.menuHeader(1), "1 session waiting")
            checkEqual(BadgeFormatter.menuHeader(5), "5 sessions waiting")
        },
        TestCase(name: "age") {
            checkEqual(BadgeFormatter.age(-5), "0s")
            checkEqual(BadgeFormatter.age(59.9), "59s")
            checkEqual(BadgeFormatter.age(180), "3m")
            checkEqual(BadgeFormatter.age(3600), "1h")
            checkEqual(BadgeFormatter.age(7500), "2h 5m")
            checkEqual(BadgeFormatter.age(86400), "1d")
            checkEqual(BadgeFormatter.age(100800), "1d 4h")
        },
    ]
}
