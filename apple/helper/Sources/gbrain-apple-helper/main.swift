import AppKit
import Darwin
import Foundation
import HelperCore

let arguments = Array(CommandLine.arguments.dropFirst())
let name = HelperIdentity.executable
let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"

func value(_ flag: String) -> String? {
    guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
    return arguments[index + 1]
}

func values(_ flag: String) -> [String] {
    arguments.indices.filter { arguments[$0] == flag && $0 + 1 < arguments.count }.map { arguments[$0 + 1] }
}

func fail(_ message: String, code: Int32) -> Never {
    FileHandle.standardError.write(Data("\(name): \(message)\n".utf8))
    exit(code)
}

let configPath = value("--config") ?? Config.defaultPath

func loadConfig() -> (Config, ValidatedConfig) {
    do {
        let config = try Config.load(path: configPath)
        return (config, try config.validated())
    } catch {
        fail("\(error)", code: 78)
    }
}

func save(_ config: Config) {
    do {
        _ = try config.validated()
        try config.write(path: configPath)
    } catch {
        fail("\(error)", code: 78)
    }
}

func lockedConfig() -> Config {
    _ = loadConfig()
    let lockPath = configPath + ".lock"
    let lockFile = Darwin.open(lockPath, O_CREAT | O_RDWR, 0o600)
    guard lockFile >= 0, flock(lockFile, LOCK_EX) == 0 else { fail("could not lock \(lockPath)", code: 75) }
    return loadConfig().0
}

func printJSON<T: Encodable>(_ value: T) {
    let encoder = JSONEncoder()
    encoder.keyEncodingStrategy = .convertToSnakeCase
    encoder.outputFormatting = [.sortedKeys]
    if let data = try? encoder.encode(value) { print(String(decoding: data, as: UTF8.self)) }
}

func admin(_ fields: [String: String], timeout: TimeInterval = 30) -> Never {
    let port = loadConfig().1.port
    guard let (status, body) = AdminClient.post(port: port, fields: fields, timeout: timeout) else {
        fail("GBrain Helper isn't answering on 127.0.0.1:\(port). Check it is running: launchctl print gui/\(getuid())/\(HelperIdentity.bundleId)", code: 69)
    }
    print(String(decoding: body, as: UTF8.self))
    exit(status == 200 ? 0 : 1)
}

struct DBState: Encodable {
    let db: String
}

let usage = """
usage: \(name) serve | init --port <n> [--enable <source>] [--db <path>] | validate-config | check [--db <path>]
       | token add --name <name> --verifier <sha256> [--scope <scope>]... | token remove --name <name>
       | send-setup [--off] | send-key add --name <name> --public-key-file <path or -> | send-key remove --name <name>
       | send-limits set <limit>=<n>... | send-audit show --redacted [--since <n>d] | --version
"""

switch arguments.first {
case "--version", "version":
    print("\(name) \(version)")

case "init":
    guard let portText = value("--port"), let port = Int(portText) else { fail("init needs --port", code: 64) }
    guard !FileManager.default.fileExists(atPath: configPath) else { fail("a config already exists at \(configPath)", code: 73) }
    let enable = values("--enable")
    for id in enable where !SourceCatalog.ids.contains(id) { fail("unknown source \(id)", code: 64) }
    let sources = Dictionary(uniqueKeysWithValues: SourceCatalog.ids.map { ($0, SourceSetting(enabled: enable.contains($0))) })
    save(Config(port: port, sources: sources, dbPath: value("--db")))
    print("config written to \(configPath)")

case "validate-config":
    _ = loadConfig()
    print("config ok")

case "token":
    var config = lockedConfig()
    guard let tokenName = value("--name") else { fail(usage, code: 64) }
    switch arguments.dropFirst().first {
    case "add":
        guard let verifier = value("--verifier") else { fail("token add needs --verifier <sha256 of the token>", code: 64) }
        config.tokens.removeAll { $0.name == tokenName }
        config.tokens.append(TokenEntry(name: tokenName, verifier: verifier.lowercased(), scopes: values("--scope")))
        save(config)
        print("token \(tokenName) saved")
    case "remove":
        guard config.tokens.contains(where: { $0.name == tokenName }) else { fail("no token named \(tokenName)", code: 1) }
        config.tokens.removeAll { $0.name == tokenName }
        save(config)
        print("token \(tokenName) removed")
    default:
        fail(usage, code: 64)
    }

case "send-setup":
    var config = lockedConfig()
    let off = arguments.contains("--off")
    if !off, config.send?.enabled != true, AdminClient.post(port: UInt16(config.port), fields: ["action": "off"], timeout: 10)?.0 != 200 {
        fail("GBrain Helper isn't answering on 127.0.0.1:\(config.port). Start it, then run send-setup again.", code: 69)
    }
    config.send = SendSetting(enabled: !off)
    save(config)
    if off {
        print("sending is off in \(configPath)")
        let port = config.port
        if let (status, _) = AdminClient.post(port: UInt16(port), fields: ["action": "off"], timeout: 10), status == 200 {
            print("GBrain Helper confirmed sending is off")
        } else {
            print("GBrain Helper didn't answer; the config switch already stops every send")
        }
        exit(0)
    }
    admin(["action": "setup"], timeout: 300)

case "send-key":
    guard let keyName = value("--name") else { fail(usage, code: 64) }
    switch arguments.dropFirst().first {
    case "add":
        guard let source = value("--public-key-file") else { fail("send-key add needs --public-key-file <path or ->", code: 64) }
        let data = source == "-" ? FileHandle.standardInput.readDataToEndOfFile() : FileManager.default.contents(atPath: source)
        guard let data, let key = String(data: data, encoding: .utf8) else { fail("could not read the public key", code: 66) }
        admin(["action": "add_key", "name": keyName, "public_key": key.trimmingCharacters(in: .whitespacesAndNewlines)], timeout: 180)
    case "remove":
        admin(["action": "remove_key", "name": keyName])
    default:
        fail(usage, code: 64)
    }

case "send-limits":
    guard arguments.dropFirst().first == "set" else { fail(usage, code: 64) }
    var fields = ["action": "set_limits"]
    var pairs = Array(arguments.dropFirst(2))
    if let index = pairs.firstIndex(of: "--config") { pairs.removeSubrange(index..<min(index + 2, pairs.count)) }
    for pair in pairs {
        let parts = pair.split(separator: "=", maxSplits: 1).map(String.init)
        guard parts.count == 2, SendLimits.names.contains(parts[0]) else { fail("limits are \(SendLimits.names.joined(separator: ", ")), as name=value", code: 64) }
        fields[parts[0]] = parts[1]
    }
    guard fields.count > 1 else { fail(usage, code: 64) }
    admin(fields, timeout: 180)

case "send-audit":
    guard arguments.dropFirst().first == "show", arguments.contains("--redacted") else {
        fail("only send-audit show --redacted is offered; the raw send log stays on this Mac", code: 64)
    }
    var since = Date.distantPast
    if let raw = value("--since") {
        guard raw.hasSuffix("d"), let days = Double(raw.dropLast()), days > 0 else { fail("--since takes days, such as 7d", code: 64) }
        since = Date().addingTimeInterval(-days * 86400)
    }
    let audit = SendAudit(directory: SendAudit.defaultDirectory)
    for path in audit.monthFiles() {
        for record in audit.read(path, repair: false) where (record.date ?? .distantPast) >= since {
            printJSON(record.redacted)
        }
    }

case "check":
    let path = value("--db") ?? (try? Config.load(path: configPath))?.dbPath ?? Config.defaultDBPath
    do {
        let reader = Reader(db: try ChatDB.open(path: path))
        try reader.healthCheck()
        printJSON(try reader.stats())
    } catch DBError.noAccess {
        printJSON(DBState(db: "no_access"))
        exit(1)
    } catch DBError.missing {
        printJSON(DBState(db: "missing"))
        exit(1)
    } catch DBError.schemaMismatch {
        printJSON(DBState(db: "schema_mismatch"))
        exit(1)
    } catch {
        printJSON(DBState(db: "error"))
        exit(1)
    }

case "serve":
    do {
        try Log.open(path: Log.defaultPath)
    } catch {
        Log.line("logging to stderr: \(error)")
    }
    let config: ValidatedConfig
    do {
        config = try Config.load(path: configPath).validated()
    } catch {
        Log.line("not serving: \(error)")
        exit(78)
    }
    let grants = LiveGrants(path: configPath)
    let send = SendService(store: KeychainSendStateStore(helperPath: Bundle.main.executablePath ?? CommandLine.arguments[0]),
                           switchedOn: { Config.sendSwitchedOn(path: configPath) }, audit: SendAudit(directory: SendAudit.defaultDirectory),
                           messages: MessagesApp(), ledger: ChatDeliveryLedger(dbPath: config.dbPath), banner: NotificationBanner(),
                           presence: LocalOwnerPresence())
    send.start()
    let sources: [SourceModule] = [IMessageSource(dbPath: config.dbPath)]
    let loopback = RouterSettings(listener: .loopback, liveGrants: grants.current, sources: sources, enabled: config.enabled, version: version, send: send)
    let server = Server(host: IPv4.parse("127.0.0.1")!, port: config.port, router: Router(settings: loopback))
    do {
        try server.start()
    } catch {
        Log.line("not serving: \(error)")
        exit(75)
    }
    Log.line("serving \(name) \(version) on 127.0.0.1:\(server.boundPort)")
    Thread.detachNewThread { server.serveForever() }
    if let tailnet = config.tailnet {
        let settings = RouterSettings(listener: .tailnet(allowed: tailnet.peers), grants: [], sources: [], enabled: [], version: version, send: send)
        Thread.detachNewThread {
            var delay: TimeInterval = 1
            while true {
                let interfaces = Interfaces.ipv4()
                if let host = tailnet.host ?? Interfaces.tailnetAddress(interfaces), BindPolicy.problem(host: host, interfaces: interfaces) == nil {
                    let listener = Server(host: host, port: config.port, router: Router(settings: settings))
                    do {
                        try listener.start()
                        Log.line("serving send on \(IPv4.string(host)):\(listener.boundPort)")
                        delay = 1
                        listener.serveForever()
                    } catch {
                        Log.line("tailnet listener not up yet: \(error)")
                    }
                } else {
                    Log.line("tailnet listener waiting for this Mac's Tailscale address")
                }
                Thread.sleep(forTimeInterval: delay)
                delay = min(delay * 2, 30)
            }
        }
    }
    _ = NSApplication.shared
    RunLoop.main.run()

default:
    fail(usage, code: 64)
}
