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

public struct Config: Codable, Equatable {
    public var port: Int
    public var tokens: [TokenEntry]
    public var sources: [String: SourceSetting]
    public var dbPath: String?

    enum CodingKeys: String, CodingKey {
        case port, tokens, sources
        case dbPath = "db_path"
    }

    public init(port: Int, tokens: [TokenEntry] = [], sources: [String: SourceSetting] = [:], dbPath: String? = nil) {
        self.port = port
        self.tokens = tokens
        self.sources = sources
        self.dbPath = dbPath
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
        return ValidatedConfig(port: UInt16(port), grants: grants, enabled: enabled, dbPath: dbPath ?? Config.defaultDBPath)
    }

    public func write(path: String) throws {
        let directory = (path as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(self)
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

    public init(path: String) {
        self.path = path
    }

    public func current() -> [TokenGrant] {
        lock.lock()
        defer { lock.unlock() }
        let now = FileStamp(path: path)
        if loaded && now == stamp { return grants }
        loaded = true
        stamp = now
        do {
            grants = try Config.load(path: path).validated().grants
            Log.line("config loaded: \(grants.count) token(s)")
        } catch {
            grants = []
            Log.line("config unreadable, refusing every token until it is fixed: \(error)")
        }
        return grants
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

public struct ValidatedConfig {
    public let port: UInt16
    public let grants: [TokenGrant]
    public let enabled: Set<String>
    public let dbPath: String
}
