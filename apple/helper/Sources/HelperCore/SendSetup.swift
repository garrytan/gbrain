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

    public init(configPath: String, lockConfig: @escaping () -> () -> Void, loadConfig: @escaping () -> Config,
                saveConfig: @escaping (Config) -> Void, post: @escaping ([String: String], TimeInterval) -> AdminReply) {
        self.configPath = configPath
        self.lockConfig = lockConfig
        self.loadConfig = loadConfig
        self.saveConfig = saveConfig
        self.post = post
    }

    public func off() -> SendSetupResult {
        let unlock = lockConfig()
        defer { unlock() }
        var config = loadConfig()
        config.send = SendSetting(enabled: false)
        saveConfig(config)
        let saved = "sending is off in \(configPath)"
        switch post(["action": "off"], Self.offWait) {
        case .notRunning:
            return SendSetupResult(out: [saved, "GBrain Helper isn't running, and the config switch stops every send."], err: nil, code: 0)
        case .noReply:
            return SendSetupResult(out: [saved], err: "GBrain Helper didn't confirm within \(Int(Self.offWait)) seconds. The config switch stops any new text being handed to Messages, but a text it was already handing over may still go out.", code: 69)
        case .answered(200, _):
            return SendSetupResult(out: [saved, "GBrain Helper confirmed sending is off. " + Self.afterStop], err: nil, code: 0)
        case .answered(let status, let body):
            let code = ((try? JSONSerialization.jsonObject(with: body)) as? [String: Any])?["code"] as? String ?? "HTTP \(status)"
            let answer = code == "overloaded" ? "GBrain Helper was busy (overloaded)" : "GBrain Helper answered \(code)"
            return SendSetupResult(out: [saved], err: "\(answer) and didn't record sending off in its keychain item. The config switch still stops any new text being handed to Messages.", code: 1)
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
