import CryptoKit
import Foundation

public struct TokenGrant: Equatable {
    public let name: String
    public let verifier: [UInt8]
    public let scopes: Set<String>

    public init(name: String, verifier: [UInt8], scopes: Set<String>) {
        self.name = name
        self.verifier = verifier
        self.scopes = scopes
    }
}

public enum Token {
    public static func verifier(fromHex hex: String) -> [UInt8]? {
        let chars = Array(hex.lowercased())
        guard chars.count == 64 else { return nil }
        var bytes: [UInt8] = []
        for i in stride(from: 0, to: 64, by: 2) {
            guard let byte = UInt8(String(chars[i...i + 1]), radix: 16) else { return nil }
            bytes.append(byte)
        }
        return bytes
    }

    public static func hexDigest(_ token: String) -> String {
        SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    public static func grant(authorization: String?, grants: [TokenGrant]) -> TokenGrant? {
        guard let authorization else { return nil }
        let parts = authorization.split(separator: " ", maxSplits: 1)
        guard parts.count == 2, parts[0].lowercased() == "bearer" else { return nil }
        let presented = parts[1].trimmingCharacters(in: .whitespaces)
        guard !presented.isEmpty else { return nil }
        let digest = Array(SHA256.hash(data: Data(presented.utf8)))
        var match: TokenGrant?
        for grant in grants where equal(digest, grant.verifier) && match == nil {
            match = grant
        }
        return match
    }

    static func equal(_ a: [UInt8], _ b: [UInt8]) -> Bool {
        guard a.count == b.count else { return false }
        var difference: UInt8 = 0
        for i in 0..<a.count { difference |= a[i] ^ b[i] }
        return difference == 0
    }
}
