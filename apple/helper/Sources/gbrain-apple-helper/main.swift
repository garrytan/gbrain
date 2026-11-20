import AppKit
import Darwin
import Foundation
import HelperCore
import ServiceManagement

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

func lockConfigFile() -> Int32 {
    _ = loadConfig()
    let lockPath = configPath + ".lock"
    let lockFile = Darwin.open(lockPath, O_CREAT | O_RDWR, 0o600)
    guard lockFile >= 0, flock(lockFile, LOCK_EX) == 0 else { fail("could not lock \(lockPath)", code: 75) }
    return lockFile
}

func lockedConfig() -> Config {
    _ = lockConfigFile()
    return loadConfig().0
}

func printJSON<T: Encodable>(_ value: T) {
    let encoder = JSONEncoder()
    encoder.keyEncodingStrategy = .convertToSnakeCase
    encoder.outputFormatting = [.sortedKeys]
    if let data = try? encoder.encode(value) { print(String(decoding: data, as: UTF8.self)) }
}

func admin(_ fields: [String: String], timeout: TimeInterval = SendSetup.offWait, success: String? = nil) -> Never {
    let port = loadConfig().1.port
    guard case .answered(let status, let body) = AdminClient.post(port: port, fields: fields, timeout: timeout) else {
        fail("GBrain Helper isn't answering on 127.0.0.1:\(port). Check it is running: launchctl print gui/\(getuid())/\(HelperIdentity.bundleId)", code: 69)
    }
    print(String(decoding: body, as: UTF8.self))
    if status == 200, let success { print(success) }
    exit(status == 200 ? 0 : 1)
}

struct DBState: Encodable {
    let db: String
}

let usage = """
usage: \(name) serve | init --port <n> [--enable <source>] [--db <path>] | validate-config | check [--db <path>]
       | token add --name <name> --verifier <sha256> [--scope <scope>]... | token remove --name <name>
       | send-setup [--off] | contacts-setup [--off] | send-key add --name <name> --public-key-file <path or -> | send-key remove --name <name>
       | send-limits set <limit>=<n>... | send-audit show --redacted [--since <n>d] | register | --version
       | contacts-write on | off | status | key add --name <name> --public-key-file <path or -> | key remove --name <name>
       | contacts-write limits set new_cards=<n> deletes=<n> edits=<n> | contacts-restore --batch <id> [--apply]
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
    let setup = SendSetup(configPath: configPath,
                          lockConfig: { let lockFile = lockConfigFile(); return { Darwin.close(lockFile) } },
                          loadConfig: { loadConfig().0 },
                          saveConfig: save,
                          post: { fields, timeout in AdminClient.post(port: loadConfig().1.port, fields: fields, timeout: timeout) },
                          helperRunning: { HelperProcess.running(named: name) })
    let result = arguments.contains("--off") ? setup.off() : setup.on()
    result.out.forEach { print($0) }
    if let err = result.err { FileHandle.standardError.write(Data("\(name): \(err)\n".utf8)) }
    exit(result.code)

case "contacts-setup":
    if arguments.contains("--off") {
        var config = lockedConfig()
        config.sources["contacts"] = SourceSetting(enabled: false)
        save(config)
        print("Contacts reading is off in \(configPath). The helper refuses /v1/contacts/changes from its next request on.")
        print("macOS keeps \(HelperIdentity.appName) under System Settings > Privacy & Security > Contacts, and this command can't take that back. To remove it, switch it off there, or run: tccutil reset AddressBook \(HelperIdentity.bundleId)")
        exit(0)
    }
    let port = loadConfig().1.port
    guard case .answered(let status, let body) = AdminClient.post(port: port, route: ContactsSource.adminRoute, fields: ["action": "setup"],
                                                                  timeout: ContactsSource.accessWait + 30) else {
        fail("GBrain Helper isn't answering on 127.0.0.1:\(port). Start it, then run contacts-setup again.", code: 69)
    }
    print(String(decoding: body, as: UTF8.self))
    guard status == 200 else { exit(1) }
    var config = lockedConfig()
    config.sources["contacts"] = SourceSetting(enabled: true)
    save(config)
    let access = ((try? JSONSerialization.jsonObject(with: body)) as? [String: Any])?["contacts"] as? String
    guard access == ContactsAccess.allowed.rawValue else {
        fail("Contacts reading is switched on in \(configPath), but macOS hasn't given \(HelperIdentity.appName) access to Contacts (\(access ?? "unknown")), so reads answer contacts_not_allowed. Turn it on in System Settings > Privacy & Security > Contacts; the helper reads contacts from the next request after that.", code: 1)
    }
    print("Contacts reading is on in \(configPath). It reads names, emails, phones, company, job title and groups. Contacts writes are a separate switch, off until you run: \(name) contacts-write on")

case "contacts-write":
    var config = lockedConfig()
    var write = config.contactsWrite ?? ContactsWriteSetting(enabled: false)
    switch arguments.dropFirst().first {
    case "on":
        write.enabled = true
        config.contactsWrite = write
        save(config)
        print("Contacts writes are on. Signed owner changes and enrich-token fills are accepted from the next request, within today's limits: \((write.limits ?? .standard).newCards) new cards, \((write.limits ?? .standard).deletes) deletes or merges, \((write.limits ?? .standard).edits) other edits. To stop them: \(name) contacts-write off")
    case "off":
        write.enabled = false
        config.contactsWrite = write
        save(config)
        print("Contacts writes are off. Every write is refused with contacts_write_off from the next request; reading is unchanged.")
    case "status":
        printJSON(ContactsWriteSetting(enabled: write.enabled, ownerKeys: write.ownerKeys, limits: write.limits ?? .standard))
    case "key":
        guard let keyName = value("--name") else { fail(usage, code: 64) }
        if arguments.dropFirst(2).first == "remove" {
            write.ownerKeys.removeAll { $0.name == keyName }
        } else {
            guard arguments.dropFirst(2).first == "add", let source = value("--public-key-file") else { fail("contacts-write key add needs --name and --public-key-file <path or ->", code: 64) }
            let data = source == "-" ? FileHandle.standardInput.readDataToEndOfFile() : FileManager.default.contents(atPath: source)
            guard let data, let key = String(data: data, encoding: .utf8) else { fail("could not read the public key", code: 66) }
            write.ownerKeys.removeAll { $0.name == keyName }
            write.ownerKeys.append(OwnerKey(name: keyName, publicKey: key.trimmingCharacters(in: .whitespacesAndNewlines)))
        }
        config.contactsWrite = write
        save(config)
        print("owner key \(keyName) saved")
    case "limits":
        guard arguments.dropFirst(2).first == "set" else { fail(usage, code: 64) }
        var limits = write.limits ?? .standard
        for pair in arguments.dropFirst(3) where pair.contains("=") {
            let parts = pair.split(separator: "=", maxSplits: 1).map(String.init)
            guard parts.count == 2, let n = Int(parts[1]) else { fail("limits are new_cards, deletes and edits, as name=value", code: 64) }
            switch parts[0] {
            case "new_cards": limits.newCards = n
            case "deletes": limits.deletes = n
            case "edits": limits.edits = n
            default: fail("limits are new_cards, deletes and edits, as name=value", code: 64)
            }
        }
        write.limits = limits
        config.contactsWrite = write
        save(config)
        printJSON(limits)
    default:
        fail(usage, code: 64)
    }

case "contacts-restore":
    guard let batch = value("--batch") else { fail("contacts-restore needs --batch <id>", code: 64) }
    let port = loadConfig().1.port
    guard case .answered(let status, let body) = AdminClient.post(port: port, route: ContactsWriter.adminRoute,
                                                                  fields: ["action": "restore", "batch": batch, "dry_run": arguments.contains("--apply") ? "false" : "true"],
                                                                  timeout: 600) else {
        fail("GBrain Helper isn't answering on 127.0.0.1:\(port). Start it, then run contacts-restore again.", code: 69)
    }
    print(String(decoding: body, as: UTF8.self))
    if status == 200, !arguments.contains("--apply") { print("That was a dry run. To undo these changes, run the same command with --apply.") }
    exit(status == 200 ? 0 : 1)

case "send-key":
    guard let keyName = value("--name") else { fail(usage, code: 64) }
    switch arguments.dropFirst().first {
    case "add":
        guard let source = value("--public-key-file") else { fail("send-key add needs --public-key-file <path or ->", code: 64) }
        let data = source == "-" ? FileHandle.standardInput.readDataToEndOfFile() : FileManager.default.contents(atPath: source)
        guard let data, let key = String(data: data, encoding: .utf8) else { fail("could not read the public key", code: 66) }
        admin(["action": "add_key", "name": keyName, "public_key": key.trimmingCharacters(in: .whitespacesAndNewlines)], timeout: LocalOwnerPresence.wait + 60)
    case "remove":
        admin(["action": "remove_key", "name": keyName], timeout: 40,
              success: "No new text signed with the key \(keyName) will be handed to Messages. A text Messages has already accepted may still be delivered.")
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
    admin(fields, timeout: LocalOwnerPresence.wait + 60)

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

case "register":
    let agent = SMAppService.agent(plistName: "\(HelperIdentity.bundleId).plist")
    if agent.status == .enabled {
        do {
            try agent.unregister()
        } catch {
            FileHandle.standardError.write(Data("\(name): macOS didn't unregister the background agent, so it stays registered from the earlier install: \(error.localizedDescription)\n".utf8))
        }
    }
    if agent.status != .enabled, agent.status != .requiresApproval {
        do {
            try agent.register()
        } catch where agent.status != .requiresApproval {
            fail("macOS didn't register the background agent: \(error.localizedDescription)", code: 1)
        } catch {}
    }
    switch agent.status {
    case .enabled:
        print("background agent registered and on")
    case .requiresApproval:
        print("background agent registered but switched off: turn on \(HelperIdentity.appName) in System Settings > General > Login Items & Extensions")
    case .notFound:
        fail("this app has no Contents/Library/LaunchAgents/\(HelperIdentity.bundleId).plist", code: 1)
    default:
        fail("background agent not registered", code: 1)
    }

case "unregister":
    do {
        try SMAppService.agent(plistName: "\(HelperIdentity.bundleId).plist").unregister()
    } catch {
        fail("macOS didn't unregister the background agent: \(error.localizedDescription)", code: 1)
    }
    print("background agent unregistered")

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
    let contacts = ContactsSource(store: SystemContactsStore(),
                                  indexPath: ((configPath as NSString).deletingLastPathComponent as NSString).appendingPathComponent(ContactsSource.indexFile))
    let sources: [SourceModule] = [IMessageSource(dbPath: config.dbPath), contacts]
    let writer = ContactsWriter(store: SystemContactsStore(), directory: (configPath as NSString).deletingLastPathComponent, policy: grants.contactsWrite)
    let loopback = RouterSettings(listener: .loopback, liveGrants: grants.current, liveEnabled: grants.enabledSources, sources: sources, version: version,
                                  send: send, writer: writer)
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
        let settings = RouterSettings(listener: .tailnet(allowed: tailnet.peers), liveGrants: grants.current, liveEnabled: grants.enabledSources,
                                      sources: [contacts], version: version, send: send, writer: writer)
        Thread.detachNewThread {
            var delay: TimeInterval = 1
            while true {
                let interfaces = Interfaces.ipv4()
                if let host = tailnet.host ?? Interfaces.tailnetAddress(interfaces), BindPolicy.problem(host: host, interfaces: interfaces) == nil {
                    let listener = Server(host: host, port: config.port, router: Router(settings: settings))
                    do {
                        try listener.start()
                        Log.line("serving send and contacts on \(IPv4.string(host)):\(listener.boundPort)")
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
