import Carbon
import Foundation

/// Global hotkeys via Carbon `RegisterEventHotKey` — works without Accessibility permission.
final class HotKeyCenter {
    static let shared = HotKeyCenter()

    private var handlers: [UInt32: () -> Void] = [:]
    private var refs: [UInt32: EventHotKeyRef] = [:]
    private var nextId: UInt32 = 1
    private var handlerRef: EventHandlerRef?
    private static let signature: OSType = 0x4F57_484B // 'OWHK'

    /// Returns false if the combination is already taken by another app (or invalid).
    @discardableResult
    func register(_ spec: HotKeySpec, handler: @escaping () -> Void) -> Bool {
        installHandlerIfNeeded()
        let id = nextId
        nextId += 1
        var ref: EventHotKeyRef?
        let status = RegisterEventHotKey(spec.keyCode, spec.modifiers, EventHotKeyID(signature: HotKeyCenter.signature, id: id),
                                         GetApplicationEventTarget(), 0, &ref)
        guard status == noErr, let r = ref else { return false }
        refs[id] = r
        handlers[id] = handler
        return true
    }

    func unregisterAll() {
        for (_, r) in refs { UnregisterEventHotKey(r) }
        refs.removeAll()
        handlers.removeAll()
    }

    fileprivate func fire(_ id: UInt32) { handlers[id]?() }

    private func installHandlerIfNeeded() {
        guard handlerRef == nil else { return }
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ -> OSStatus in
            var hk = EventHotKeyID()
            let err = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                                        nil, MemoryLayout<EventHotKeyID>.size, nil, &hk)
            guard err == noErr, hk.signature == HotKeyCenter.signature else { return OSStatus(eventNotHandledErr) }
            let id = hk.id
            DispatchQueue.main.async { HotKeyCenter.shared.fire(id) }
            return noErr
        }, 1, &spec, nil, &handlerRef)
    }
}
