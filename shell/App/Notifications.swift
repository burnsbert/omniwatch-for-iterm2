import AppKit
import UserNotifications

/// UNUserNotification posting and action routing (§2.8 step 2).
/// Actions: **Go to session** (iTerm2) and **Show in Omniwatch**; a plain click follows
/// `prefs.notifications.click` ("goto" | "show").
final class NotificationController: NSObject, UNUserNotificationCenterDelegate {
    static let category = "OW_WAITING"
    static let gotoAction = "OW_GOTO"
    static let showAction = "OW_SHOW"

    private lazy var center = UNUserNotificationCenter.current()
    var onGoto: ((String) -> Void)?
    var onShow: ((String) -> Void)?
    var clickBehavior: () -> String = { "goto" }
    var log: (String) -> Void = { _ in }
    private var posted = Set<String>()
    private(set) var authorization: String = "unknown"

    func setup() {
        center.delegate = self
        let goto = UNNotificationAction(identifier: NotificationController.gotoAction, title: "Go to session", options: [])
        let show = UNNotificationAction(identifier: NotificationController.showAction, title: "Show in Omniwatch",
                                        options: [.foreground])
        center.setNotificationCategories([UNNotificationCategory(identifier: NotificationController.category,
                                                                 actions: [goto, show], intentIdentifiers: [],
                                                                 options: [])])
        refreshStatus(nil)
    }

    /// Current permission as a string for the web UI: granted | denied | notDetermined | unknown.
    func refreshStatus(_ done: ((String) -> Void)?) {
        center.getNotificationSettings { settings in
            let s: String
            switch settings.authorizationStatus {
            case .authorized, .provisional: s = "granted"
            case .denied: s = "denied"
            case .notDetermined: s = "notDetermined"
            default: s = "granted" // .ephemeral: iOS-only App Clips
            }
            DispatchQueue.main.async {
                self.authorization = s
                done?(s)
            }
        }
    }

    /// Asks macOS (shows the system prompt only the first time). Falls back gracefully if
    /// authorization fails for an ad-hoc build (§8): in-app toast, sound, badge, and menu bar remain.
    func requestPermission(_ done: ((String, String?) -> Void)?) {
        center.requestAuthorization(options: [.alert, .sound]) { granted, error in
            if let e = error { self.log("notification authorization error: \(e.localizedDescription)") }
            DispatchQueue.main.async {
                self.authorization = granted ? "granted" : (error == nil ? "denied" : "error")
                done?(self.authorization, error?.localizedDescription)
            }
        }
    }

    enum Kind: String { case waiting, stalled }

    func post(uid: String, title: String, body: String, kind: Kind = .waiting) {
        let go = { [weak self] in
            guard let self = self else { return }
            let c = UNMutableNotificationContent()
            c.title = title
            c.body = body
            c.categoryIdentifier = NotificationController.category
            c.threadIdentifier = uid
            c.userInfo = ["uid": uid]
            c.sound = nil // the "Sound on attention" pref plays NSSound itself (P-33)
            let id = "\(kind.rawValue)-\(uid)" // a newer wait for the same session replaces the old banner
            self.center.add(UNNotificationRequest(identifier: id, content: c, trigger: nil)) { err in
                if let e = err { self.log("notification post failed: \(e.localizedDescription)") }
            }
            self.posted.insert(id)
        }
        if authorization == "notDetermined" || authorization == "unknown" {
            requestPermission { status, _ in if status == "granted" { go() } }
        } else if authorization == "granted" {
            go()
        }
    }

    /// Removes delivered banners for sessions that stopped waiting / stopped being stalled.
    func prune(waiting: Set<String>, stalled: Set<String>) {
        let keep = Set(waiting.map { "\(Kind.waiting.rawValue)-\($0)" } + stalled.map { "\(Kind.stalled.rawValue)-\($0)" })
        let stale = posted.subtracting(keep)
        guard !stale.isEmpty else { return }
        center.removeDeliveredNotifications(withIdentifiers: Array(stale))
        posted.subtract(stale)
    }

    // MARK: UNUserNotificationCenterDelegate

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        // Suppression already happened in NotificationPolicy; if we posted it, show it.
        completionHandler([.banner, .list])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let uid = response.notification.request.content.userInfo["uid"] as? String
        let action = response.actionIdentifier
        DispatchQueue.main.async {
            if let uid = uid {
                switch action {
                case NotificationController.gotoAction: self.onGoto?(uid)
                case NotificationController.showAction: self.onShow?(uid)
                case UNNotificationDefaultActionIdentifier:
                    if self.clickBehavior() == "show" { self.onShow?(uid) } else { self.onGoto?(uid) }
                default: break
                }
            }
            completionHandler()
        }
    }
}
