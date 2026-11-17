import Foundation
import Testing
@testable import HelperCore

@Suite struct ConfigTests {
    let verifier = Token.hexDigest(token)

    func config(port: Int = 8792, tokens: [TokenEntry]? = nil, sources: [String: SourceSetting] = ["imessage": SourceSetting(enabled: true)]) -> Config {
        Config(port: port, tokens: tokens ?? [TokenEntry(name: "gbrain", verifier: verifier, scopes: ["read:imessage"])], sources: sources)
    }

    @Test func validates() throws {
        let checked = try config().validated()
        #expect(checked.port == 8792)
        #expect(checked.enabled == ["imessage"])
        #expect(checked.grants.first?.scopes == ["read:imessage"])
        #expect(checked.dbPath == Config.defaultDBPath)
        #expect(try config(sources: ["imessage": SourceSetting(enabled: false)]).validated().enabled.isEmpty)
        #expect(try config(sources: [:]).validated().enabled.isEmpty)
        #expect(try config(tokens: [TokenEntry(name: "status", verifier: verifier, scopes: [])]).validated().grants.first?.scopes.isEmpty == true)
    }

    @Test func refusesBadConfigs() {
        let bad = [
            config(port: 80),
            config(port: 70000),
            config(tokens: [TokenEntry(name: "gbrain", verifier: "abc", scopes: [])]),
            config(tokens: [TokenEntry(name: "gbrain", verifier: verifier, scopes: ["write:imessage"])]),
            config(tokens: [TokenEntry(name: "", verifier: verifier, scopes: [])]),
            config(tokens: [TokenEntry(name: "a", verifier: verifier, scopes: []), TokenEntry(name: "a", verifier: verifier, scopes: [])]),
            config(sources: ["unknown-source": SourceSetting(enabled: true)]),
        ]
        for config in bad {
            #expect(throws: ConfigError.self) { try config.validated() }
        }
    }

    @Test func hasNoFieldThatOpensANetworkListener() throws {
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(config())) as? [String: Any] ?? [:]
        #expect(Set(encoded.keys) == ["port", "tokens", "sources"])
        let older = Data(#"{"port": 8792, "tokens": [], "sources": {}, "host": "100.100.0.1", "allowed_sources": ["100.102.0.7"]}"#.utf8)
        #expect(try JSONDecoder().decode(Config.self, from: older) == Config(port: 8792))
    }

    @Test func writesPrivateFiles() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("helper-config-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent("config.json").path
        try config().write(path: path)
        #expect(try Config.load(path: path) == config())
        #expect(try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? Int == 0o600)
        #expect(try FileManager.default.attributesOfItem(atPath: directory.path)[.posixPermissions] as? Int == 0o700)
        let text = try String(contentsOfFile: path, encoding: .utf8)
        #expect(!text.contains(token))
        try config(tokens: []).write(path: path)
        #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path) == ["config.json"])
    }

    @Test func liveGrantsFollowTheConfigFile() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("helper-config-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent("config.json").path
        let live = LiveGrants(path: path)
        #expect(live.current().isEmpty)
        try config().write(path: path)
        #expect(live.current().map(\.name) == ["gbrain"])
        try config(tokens: []).write(path: path)
        #expect(live.current().isEmpty)
        try config().write(path: path)
        #expect(live.current().map(\.name) == ["gbrain"])
        #expect(FileManager.default.createFile(atPath: path, contents: Data("not json".utf8)))
        #expect(live.current().isEmpty)
        try FileManager.default.removeItem(atPath: path)
        #expect(live.current().isEmpty)
    }

    @Test func defaultPathsUseTheHelperNames() {
        #expect(Config.defaultPath.hasSuffix("/Library/Application Support/GBrain Helper/config.json"))
        #expect(Log.defaultPath.hasSuffix("/Library/Logs/gbrain-apple-helper.log"))
    }
}
