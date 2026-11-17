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

func printJSON<T: Encodable>(_ value: T) {
    let encoder = JSONEncoder()
    encoder.keyEncodingStrategy = .convertToSnakeCase
    encoder.outputFormatting = [.sortedKeys]
    if let data = try? encoder.encode(value) { print(String(decoding: data, as: UTF8.self)) }
}

struct DBState: Encodable {
    let db: String
}

let usage = "usage: \(name) serve | init --port <n> [--enable <source>] [--db <path>] | validate-config | check [--db <path>] | token add --name <name> --verifier <sha256> [--scope <scope>]... | token remove --name <name> | --version"

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
    _ = loadConfig()
    let lockPath = configPath + ".lock"
    let lockFile = Darwin.open(lockPath, O_CREAT | O_RDWR, 0o600)
    guard lockFile >= 0, flock(lockFile, LOCK_EX) == 0 else { fail("could not lock \(lockPath)", code: 75) }
    var config = loadConfig().0
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
    let settings = RouterSettings(listener: .loopback, liveGrants: grants.current, sources: [IMessageSource(dbPath: config.dbPath)],
                                  enabled: config.enabled, version: version)
    let server = Server(host: IPv4.parse("127.0.0.1")!, port: config.port, router: Router(settings: settings))
    do {
        try server.start()
    } catch {
        Log.line("not serving: \(error)")
        exit(75)
    }
    Log.line("serving \(name) \(version) on 127.0.0.1:\(server.boundPort)")
    server.serveForever()

default:
    fail(usage, code: 64)
}
