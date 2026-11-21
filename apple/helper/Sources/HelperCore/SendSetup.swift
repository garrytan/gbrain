import Darwin
import Foundation

public enum AdminReply: Equatable {
    case answered(status: Int, body: Data)
    case notRunning
    case noReply
}

public struct SendSetupResult: Equatable {
    public var out: [String]
    public var err: String?
    public var code: Int32
}

public struct SendSetup {
    public static let offWait: TimeInterval = 40
    public static let setupWait: TimeInterval = 300
    public static let afterStop = "No new text will be handed to Messages. A text Messages has already accepted may still be delivered."

    let configPath: String
    let lockConfig: () -> () -> Void
    let loadConfig: () -> Config
    let saveConfig: (Config) -> Void
    let post: ([String: String], TimeInterval) -> AdminReply
    let helperRunning: () -> Bool

    public init(configPath: String, lockConfig: @escaping () -> () -> Void, loadConfig: @escaping () -> Config,
                saveConfig: @escaping (Config) -> Void, post: @escaping ([String: String], TimeInterval) -> AdminReply,
                helperRunning: @escaping () -> Bool) {
        self.configPath = configPath
        self.lockConfig = lockConfig
        self.loadConfig = loadConfig
        self.saveConfig = saveConfig
        self.post = post
        self.helperRunning = helperRunning
    }

    public func off() -> SendSetupResult {
        let unlock = lockConfig()
        defer { unlock() }
        var config = loadConfig()
        config.send = SendSetting(enabled: false)
        saveConfig(config)
        let saved = "sending is off in \(configPath)"
        switch post(["action": "off"], Self.offWait) {
        case .notRunning where helperRunning():
            return SendSetupResult(out: [saved], err: "Nothing answered on 127.0.0.1:\(config.port), but a \(HelperIdentity.executable) process is still running, so sending off isn't confirmed. The config switch stops any new text being handed to Messages, but a text it was already handing over may still go out.", code: 69)
        case .notRunning:
            return SendSetupResult(out: [saved, "GBrain Helper isn't running, and the config switch stops every send."], err: nil, code: 0)
        case .noReply:
            return SendSetupResult(out: [saved], err: "GBrain Helper didn't confirm within \(Int(Self.offWait)) seconds. The config switch stops any new text being handed to Messages, but a text it was already handing over may still go out.", code: 69)
        case .answered(200, _):
            return SendSetupResult(out: [saved, "GBrain Helper confirmed sending is off. " + Self.afterStop], err: nil, code: 0)
        case .answered(let status, let body):
            let code = ((try? JSONSerialization.jsonObject(with: body)) as? [String: Any])?["code"] as? String ?? "HTTP \(status)"
            let busy = code == "overloaded" || code == "HTTP \(status)"
            let answer = code == "overloaded" ? "GBrain Helper was busy (overloaded)" : "GBrain Helper answered \(code)"
            let caveat = busy ? ", but a text it was already handing over may still go out" : ""
            return SendSetupResult(out: [saved], err: "\(answer) and didn't record sending off in its keychain item. The config switch still stops any new text being handed to Messages\(caveat).", code: 1)
        }
    }

    public func on() -> SendSetupResult {
        let unlock = lockConfig()
        var config = loadConfig()
        let notAnswering = "GBrain Helper isn't answering on 127.0.0.1:\(config.port). Start it, then run send-setup again."
        if config.send?.enabled != true {
            guard case .answered(200, _) = post(["action": "off"], Self.offWait) else {
                unlock()
                return SendSetupResult(out: [], err: notAnswering, code: 69)
            }
        }
        config.send = SendSetting(enabled: true)
        saveConfig(config)
        unlock()
        guard case .answered(let status, let body) = post(["action": "setup"], Self.setupWait) else {
            return SendSetupResult(out: [], err: notAnswering, code: 69)
        }
        return SendSetupResult(out: [String(decoding: body, as: UTF8.self)], err: nil, code: status == 200 ? 0 : 1)
    }
}

public enum HelperProcess {
    public static func running(named name: String, in pids: [pid_t]? = allPids()) -> Bool {
        guard let pids else { return true }
        return !others(named: name, in: pids).isEmpty
    }

    public static func others(named name: String, in pids: [pid_t]) -> [pid_t] {
        var path = [CChar](repeating: 0, count: 4096)
        return pids.filter { pid in
            guard pid > 0, pid != getpid(), proc_pidpath(pid, &path, UInt32(path.count)) > 0 else { return false }
            return (String(cString: path) as NSString).lastPathComponent == name
        }
    }

    public static func allPids() -> [pid_t]? {
        let count = proc_listallpids(nil, 0)
        guard count > 0 else { return nil }
        var pids = [pid_t](repeating: 0, count: Int(count) + 64)
        let filled = proc_listallpids(&pids, Int32(pids.count * MemoryLayout<pid_t>.size))
        guard filled > 0 else { return nil }
        return Array(pids.prefix(Int(filled)))
    }
}
