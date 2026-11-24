import Darwin
import Foundation

public enum HelperIdentity {
    public static let appName = "GBrain Helper"
    public static let bundleId = "io.gbrain.apple-helper"
    public static let executable = "gbrain-apple-helper"
}

public struct ConfigError: Error, CustomStringConvertible {
    public let description: String
}

public struct TokenEntry: Codable, Equatable {
    public var name: String
    public var verifier: String
    public var scopes: [String]

    public init(name: String, verifier: String, scopes: [String]) {
        self.name = name
        self.verifier = verifier
        self.scopes = scopes
    }
}

public struct SourceSetting: Codable, Equatable {
    public var enabled: Bool

    public init(enabled: Bool) {
        self.enabled = enabled
    }
}

public struct TailnetSetting: Codable, Equatable {
    public var host: String?
    public var allowedPeers: [String]

    enum CodingKeys: String, CodingKey {
        case host
        case allowedPeers = "allowed_peers"
    }

    public init(host: String? = nil, allowedPeers: [String]) {
        self.host = host
        self.allowedPeers = allowedPeers
    }
}

public struct ListenSetting: Codable, Equatable {
    public var tailnet: TailnetSetting?

    public init(tailnet: TailnetSetting?) {
        self.tailnet = tailnet
    }
}

public struct SendSetting: Codable, Equatable {
    public var enabled: Bool

    public init(enabled: Bool) {
        self.enabled = enabled
    }
}

public struct Config: Codable, Equatable {
    public var port: Int
    public var tokens: [TokenEntry]
    public var sources: [String: SourceSetting]
    public var dbPath: String?
    public var listen: ListenSetting?
    public var send: SendSetting?
    public var contactsWrite: ContactsWriteSetting?

    enum CodingKeys: String, CodingKey {
        case port, tokens, sources, listen, send
        case dbPath = "db_path"
        case contactsWrite = "contacts_write"
    }

    public init(port: Int, tokens: [TokenEntry] = [], sources: [String: SourceSetting] = [:], dbPath: String? = nil,
                listen: ListenSetting? = nil, send: SendSetting? = nil, contactsWrite: ContactsWriteSetting? = nil) {
        self.port = port
        self.tokens = tokens
        self.sources = sources
        self.dbPath = dbPath
        self.listen = listen
        self.send = send
        self.contactsWrite = contactsWrite
    }

    public static func sendSwitchedOn(path: String) -> Bool {
        (try? load(path: path))?.send?.enabled ?? false
    }

    public static var defaultDirectory: String { NSHomeDirectory() + "/Library/Application Support/\(HelperIdentity.appName)" }
    public static var defaultPath: String { defaultDirectory + "/config.json" }
    public static var defaultDBPath: String { NSHomeDirectory() + "/Library/Messages/chat.db" }

    public static func load(path: String) throws -> Config {
        guard let data = FileManager.default.contents(atPath: path) else {
            throw ConfigError(description: "no config at \(path)")
        }
        do {
            return try JSONDecoder().decode(Config.self, from: data)
        } catch {
            throw ConfigError(description: "config at \(path) is not valid JSON for \(HelperIdentity.executable)")
        }
    }

    public func validated() throws -> ValidatedConfig {
        guard (1024...65535).contains(port) else { throw ConfigError(description: "port must be 1024-65535") }
        var grants: [TokenGrant] = []
        var names = Set<String>()
        for entry in tokens {
            guard !entry.name.isEmpty, names.insert(entry.name).inserted else {
                throw ConfigError(description: "every token needs a unique, non-empty name")
            }
            guard let verifier = Token.verifier(fromHex: entry.verifier) else {
                throw ConfigError(description: "token \(entry.name): verifier must be the token's sha256 as 64 hex characters")
            }
            for scope in entry.scopes where !SourceCatalog.scopes.contains(scope) {
                throw ConfigError(description: "token \(entry.name): unknown scope \(scope)")
            }
            grants.append(TokenGrant(name: entry.name, verifier: verifier, scopes: Set(entry.scopes)))
        }
        for id in sources.keys where !SourceCatalog.ids.contains(id) {
            throw ConfigError(description: "unknown source \(id)")
        }
        let enabled = Set(sources.filter { $0.value.enabled }.map(\.key))
        var tailnetHost: UInt32?
        var tailnetPeers = Set<UInt32>()
        if let tailnet = listen?.tailnet {
            if let host = tailnet.host {
                guard let parsed = IPv4.parse(host), IPv4.isTailnet(parsed) else {
                    throw ConfigError(description: "listen.tailnet.host must be this Mac's Tailscale IPv4 address (100.64.0.0/10)")
                }
                tailnetHost = parsed
            }
            guard !tailnet.allowedPeers.isEmpty else { throw ConfigError(description: "listen.tailnet.allowed_peers must name at least one peer") }
            for peer in tailnet.allowedPeers {
                guard let parsed = IPv4.parse(peer), IPv4.isTailnet(parsed) else {
                    throw ConfigError(description: "listen.tailnet.allowed_peers: \(peer) is not a Tailscale IPv4 address (100.64.0.0/10)")
                }
                tailnetPeers.insert(parsed)
            }
        }
        var writePolicy = ContactsWritePolicy.off
        if let write = contactsWrite {
            var keys: [String: [UInt8]] = [:]
            for key in write.ownerKeys {
                guard !key.name.isEmpty, keys[key.name] == nil, let raw = Base64URL.decode(key.publicKey), raw.count == 32 else {
                    throw ConfigError(description: "contacts_write.owner_keys: every key needs a unique name and a 32-byte Ed25519 public key in base64url")
                }
                keys[key.name] = raw
            }
            let limits = write.limits ?? .standard
            guard [limits.newCards, limits.deletes, limits.edits].allSatisfy({ (0...ContactsWriter.maxChanges * 10).contains($0) }) else {
                throw ConfigError(description: "contacts_write.limits must each be 0 to \(ContactsWriter.maxChanges * 10)")
            }
            writePolicy = ContactsWritePolicy(enabled: write.enabled, ownerKeys: keys, limits: limits)
        }
        return ValidatedConfig(port: UInt16(port), grants: grants, enabled: enabled, dbPath: dbPath ?? Config.defaultDBPath,
                               tailnet: listen?.tailnet == nil ? nil : TailnetListen(host: tailnetHost, peers: tailnetPeers), contactsWrite: writePolicy)
    }

    public func write(path: String) throws {
        let directory = (path as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        try Self.writePrivate(try encoder.encode(self), path: path)
    }

    public static func writePrivate(_ data: Data, path: String) throws {
        let temp = path + ".tmp-\(getpid())-\(UUID().uuidString)"
        let fd = Darwin.open(temp, O_WRONLY | O_CREAT | O_EXCL, 0o600)
        guard fd >= 0 else { throw ConfigError(description: "could not write \(path)") }
        let written = data.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
        let synced = fsync(fd) == 0
        close(fd)
        guard written == data.count, synced, rename(temp, path) == 0 else {
            unlink(temp)
            throw ConfigError(description: "could not write \(path)")
        }
    }
}

public final class LiveGrants {
    let path: String
    let lock = NSLock()
    var loaded = false
    var stamp: FileStamp?
    var grants: [TokenGrant] = []
    var enabled: Set<String> = []
    var write = ContactsWritePolicy.off

    public init(path: String) {
        self.path = path
    }

    public func current() -> [TokenGrant] {
        reload().grants
    }

    public func enabledSources() -> Set<String> {
        reload().enabled
    }

    public func contactsWrite() -> ContactsWritePolicy {
        _ = reload()
        lock.lock()
        defer { lock.unlock() }
        return write
    }

    func reload() -> (grants: [TokenGrant], enabled: Set<String>) {
        lock.lock()
        defer { lock.unlock() }
        let now = FileStamp(path: path)
        if loaded && now == stamp { return (grants, enabled) }
        loaded = true
        stamp = now
        do {
            let config = try Config.load(path: path).validated()
            grants = config.grants
            enabled = config.enabled
            write = config.contactsWrite
            Log.line("config loaded: \(grants.count) token(s)")
        } catch {
            grants = []
            enabled = []
            write = .off
            Log.line("config unreadable, refusing every token until it is fixed: \(error)")
        }
        return (grants, enabled)
    }
}

struct FileStamp: Equatable {
    let device: Int64
    let inode: UInt64
    let size: Int64
    let seconds: Int
    let nanoseconds: Int

    init?(path: String) {
        var info = stat()
        guard stat(path, &info) == 0 else { return nil }
        device = Int64(info.st_dev)
        inode = UInt64(info.st_ino)
        size = Int64(info.st_size)
        seconds = Int(info.st_mtimespec.tv_sec)
        nanoseconds = Int(info.st_mtimespec.tv_nsec)
    }
}

public struct TailnetListen: Equatable {
    public let host: UInt32?
    public let peers: Set<UInt32>
}

public struct ValidatedConfig {
    public let port: UInt16
    public let grants: [TokenGrant]
    public let enabled: Set<String>
    public let dbPath: String
    public let tailnet: TailnetListen?
    public let contactsWrite: ContactsWritePolicy
}
