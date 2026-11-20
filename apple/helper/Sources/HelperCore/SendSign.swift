import CryptoKit
import Foundation

public struct SendSignature: Equatable {
    public let keyName: String
    public let timestamp: Int
    public let nonce: String
    public let signature: [UInt8]

    public static let scheme = "GBrain-Sign"
    public static let version = "GBRAIN-SIGN-V1"
    public static let route = "/v1/imessage/send"
    public static let maxSkew = 60
    public static let nonceWindow: TimeInterval = 600

    public static func parse(_ header: String?) -> SendSignature? {
        guard let header, header.hasPrefix(scheme + " ") else { return nil }
        var fields: [String: String] = [:]
        for part in header.dropFirst(scheme.count + 1).split(separator: ",") {
            let pair = part.trimmingCharacters(in: .whitespaces).split(separator: "=", maxSplits: 1)
            guard pair.count == 2, fields[String(pair[0])] == nil else { return nil }
            fields[String(pair[0])] = String(pair[1])
        }
        guard Set(fields.keys) == ["key", "ts", "nonce", "sig"], let key = fields["key"], !key.isEmpty,
              let tsText = fields["ts"], tsText.allSatisfy(\.isASCII), tsText.allSatisfy(\.isNumber), let ts = Int(tsText),
              let nonce = fields["nonce"], nonce.count == 32, nonce.allSatisfy({ "0123456789abcdef".contains($0) }),
              let sig = fields["sig"].flatMap(Base64URL.decode), sig.count == 64 else { return nil }
        return SendSignature(keyName: key, timestamp: ts, nonce: nonce, signature: sig)
    }

    public static func canonical(timestamp: Int, nonce: String, idempotencyKey: String, body: [UInt8]) -> String {
        let digest = SHA256.hash(data: Data(body)).map { String(format: "%02x", $0) }.joined()
        return [version, "POST", route, String(timestamp), nonce, idempotencyKey, digest].joined(separator: "\n")
    }

    public func verifies(publicKey: [UInt8], idempotencyKey: String, body: [UInt8]) -> Bool {
        guard let key = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKey) else { return false }
        let message = Data(Self.canonical(timestamp: timestamp, nonce: nonce, idempotencyKey: idempotencyKey, body: body).utf8)
        return key.isValidSignature(Data(signature), for: message)
    }

    public static func validIdempotencyKey(_ key: String?) -> Bool {
        guard let key, (8...128).contains(key.count) else { return false }
        return key.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) && $0.isASCII || "._-".unicodeScalars.contains($0) }
    }
}

public enum Base64URL {
    public static func decode(_ text: String) -> [UInt8]? {
        guard text.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { return nil }
        var base = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while base.count % 4 != 0 { base += "=" }
        return Data(base64Encoded: base).map(Array.init)
    }

    public static func encode(_ bytes: [UInt8]) -> String {
        Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

public final class NonceCache {
    let lock = NSLock()
    var seen: [String: Date] = [:]

    public init() {}

    public func claim(_ nonce: String, now: Date) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        seen = seen.filter { now.timeIntervalSince($0.value) < SendSignature.nonceWindow }
        guard seen[nonce] == nil else { return false }
        seen[nonce] = now
        return true
    }
}
