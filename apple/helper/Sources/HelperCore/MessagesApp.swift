import AppKit
import CoreServices
import Foundation
import UserNotifications

public enum PrepareResult: Equatable {
    case ready
    case automationDenied
    case signedOut
    case unavailable
    case failed(Int)
}

public enum DispatchResult: Equatable {
    case submitted(guid: String?)
    case error(Int)
}

public protocol MessagesPort {
    func prepare(askPermission: Bool) -> PrepareResult
    func send(text: String, to recipient: String) -> DispatchResult
}

public final class MessagesApp: MessagesPort {
    static let bundleId = "com.apple.MobileSMS"
    static let source = """
    on gbrain_send(theText, theHandle)
        with timeout of 20 seconds
            tell application id "com.apple.MobileSMS"
                set theAccount to first account whose service type = iMessage
                send theText to participant theHandle of theAccount
            end tell
        end timeout
    end gbrain_send

    on gbrain_signed_in()
        with timeout of 10 seconds
            tell application id "com.apple.MobileSMS"
                return (count of (accounts whose service type = iMessage and enabled is true)) > 0
            end tell
        end timeout
    end gbrain_signed_in
    """

    static let appleScriptSuite: AEEventClass = 0x6173_6372
    static let subroutineEvent: AEEventID = 0x7073_6272
    static let subroutineName: AEKeyword = 0x736E_616D

    var script: NSAppleScript?

    public init() {}

    func onMain<T>(_ body: () -> T) -> T {
        Thread.isMainThread ? body() : DispatchQueue.main.sync(execute: body)
    }

    func launch() -> Bool {
        if NSRunningApplication.runningApplications(withBundleIdentifier: Self.bundleId).contains(where: \.isFinishedLaunching) { return true }
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: Self.bundleId) else { return false }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.hides = true
        configuration.addsToRecentItems = false
        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, _ in }
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            if NSRunningApplication.runningApplications(withBundleIdentifier: Self.bundleId).contains(where: \.isFinishedLaunching) { return true }
            Thread.sleep(forTimeInterval: 0.2)
        }
        return false
    }

    func permission(ask: Bool) -> OSStatus {
        let target = NSAppleEventDescriptor(bundleIdentifier: Self.bundleId)
        return AEDeterminePermissionToAutomateTarget(target.aeDesc, typeWildCard, typeWildCard, ask)
    }

    public func prepare(askPermission: Bool) -> PrepareResult {
        guard launch() else { return .unavailable }
        switch permission(ask: askPermission) {
        case noErr: break
        case OSStatus(errAEEventNotPermitted), OSStatus(errAEEventWouldRequireUserConsent): return .automationDenied
        case OSStatus(procNotFound): return .unavailable
        case let other: return .failed(Int(other))
        }
        switch call("gbrain_signed_in", []) {
        case .success(let reply): return reply.booleanValue ? .ready : .signedOut
        case .failure(let failure): return failure.number == Int(errAEEventNotPermitted) ? .automationDenied : .failed(failure.number)
        }
    }

    public func send(text: String, to recipient: String) -> DispatchResult {
        switch call("gbrain_send", [NSAppleEventDescriptor(string: text), NSAppleEventDescriptor(string: recipient)]) {
        case .success(let reply): return .submitted(guid: reply.stringValue.flatMap { $0.isEmpty ? nil : $0 })
        case .failure(let failure): return .error(failure.number)
        }
    }

    struct CallFailure: Error {
        let number: Int
    }

    func call(_ handler: String, _ arguments: [NSAppleEventDescriptor]) -> Result<NSAppleEventDescriptor, CallFailure> {
        onMain {
            if script == nil {
                let compiled = NSAppleScript(source: Self.source)
                var error: NSDictionary?
                guard let compiled, compiled.compileAndReturnError(&error) else {
                    return .failure(CallFailure(number: (error?[NSAppleScript.errorNumber] as? Int) ?? -2700))
                }
                script = compiled
            }
            let event = NSAppleEventDescriptor(eventClass: Self.appleScriptSuite, eventID: Self.subroutineEvent,
                                               targetDescriptor: .currentProcess(), returnID: AEReturnID(kAutoGenerateReturnID),
                                               transactionID: AETransactionID(kAnyTransactionID))
            event.setParam(NSAppleEventDescriptor(string: handler), forKeyword: Self.subroutineName)
            let list = NSAppleEventDescriptor.list()
            for (index, argument) in arguments.enumerated() { list.insert(argument, at: index + 1) }
            event.setParam(list, forKeyword: AEKeyword(keyDirectObject))
            var error: NSDictionary?
            guard let reply = script?.executeAppleEvent(event, error: &error), error == nil else {
                return .failure(CallFailure(number: (error?[NSAppleScript.errorNumber] as? Int) ?? -2700))
            }
            return .success(reply)
        }
    }
}

public protocol Banner {
    func post(_ text: String)
    func requestAuthorization() -> Bool
}

public final class NotificationBanner: Banner {
    public init() {}

    var available: Bool { Bundle.main.bundleIdentifier == HelperIdentity.bundleId }

    public func requestAuthorization() -> Bool {
        guard available else { return false }
        let done = DispatchSemaphore(value: 0)
        var granted = false
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert]) { ok, _ in
            granted = ok
            done.signal()
        }
        _ = done.wait(timeout: .now() + 120)
        return granted
    }

    public func post(_ text: String) {
        guard available else { return }
        let content = UNMutableNotificationContent()
        content.title = HelperIdentity.appName
        content.body = text
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)) { error in
            if error != nil { Log.line("send banner not shown") }
        }
    }
}
