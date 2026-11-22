import CryptoKit
import Foundation

public struct SendRequest: Equatable {
    public let to: String
    public let text: String
    public let requestedBy: String
    public let ownerInstruction: String

    public static let fields: Set<String> = ["to", "text", "requested_by", "owner_instruction"]
    public static let maxUTF16 = 4000
    public static let maxGraphemes = 2000
    public static let maxInstruction = 1000

    public static func parse(_ body: [UInt8]) throws -> SendRequest {
        guard let object = StrictJSON.flatObject(body) else {
            throw Problem.badParam("the body must be one JSON object of string fields, with no duplicate keys")
        }
        for key in object.keys where !fields.contains(key) { throw Problem.badParam("unknown field \(key)") }
        guard let to = object["to"], let text = object["text"], let requestedBy = object["requested_by"], let instruction = object["owner_instruction"] else {
            throw Problem.badParam("to, text, requested_by and owner_instruction are required")
        }
        guard let recipient = Recipient.normalize(to) else {
            throw Problem.badParam("to must be one phone number in E.164 form (+15551234567) or one email address")
        }
        try checkText(text)
        guard requestedBy == "owner" else { throw Problem.requesterNotSupported }
        let trimmed = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, instruction.count <= maxInstruction else {
            throw Problem.badParam("owner_instruction must hold the owner's words, 1 to \(maxInstruction) characters")
        }
        return SendRequest(to: recipient, text: text.precomposedStringWithCanonicalMapping, requestedBy: requestedBy,
                           ownerInstruction: instruction.precomposedStringWithCanonicalMapping)
    }

    public static func checkText(_ text: String) throws {
        let units = text.utf16.count
        guard units >= 1, units <= maxUTF16, text.count <= maxGraphemes,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw Problem.badParam("text must be 1 to \(maxUTF16) UTF-16 code units and at most \(maxGraphemes) characters, not blank")
        }
    }

    public var canonicalHash: String {
        let canonical = "{\"owner_instruction\":\(StrictJSON.quote(ownerInstruction)),\"requested_by\":\(StrictJSON.quote(requestedBy)),\"text\":\(StrictJSON.quote(text)),\"to\":\(StrictJSON.quote(to))}"
        return SHA256.hash(data: Data(canonical.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

public enum Recipient {
    public static func normalize(_ raw: String) -> String? {
        let value = raw.trimmingCharacters(in: CharacterSet(charactersIn: " \t"))
        if value.contains("@") {
            let lower = value.lowercased()
            let parts = lower.split(separator: "@", omittingEmptySubsequences: false)
            guard parts.count == 2, !parts[0].isEmpty, parts[1].contains("."), !parts[1].hasPrefix("."), !parts[1].hasSuffix("."),
                  lower.count <= 254, lower.unicodeScalars.allSatisfy({ $0.value > 32 && $0.value < 127 && !"<>()[],;:\\\"".unicodeScalars.contains($0) })
            else { return nil }
            return lower
        }
        var digits = ""
        for (index, character) in value.enumerated() {
            if character == "+" && index == 0 { continue }
            if " -().".contains(character) { continue }
            guard character.isASCII, character.isNumber else { return nil }
            digits.append(character)
        }
        guard value.hasPrefix("+"), (7...15).contains(digits.count), digits.first != "0" else { return nil }
        return "+" + digits
    }

    public static func hash(_ recipient: String, key: [UInt8]) -> String {
        String(HMAC<SHA256>.authenticationCode(for: Data(recipient.utf8), using: SymmetricKey(data: key)).map { String(format: "%02x", $0) }.joined().prefix(12))
    }
}

enum StrictJSON {
    static func quote(_ string: String) -> String {
        var out = "\""
        for scalar in string.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case _ where scalar.value < 0x20: out += String(format: "\\u%04x", scalar.value)
            default: out.unicodeScalars.append(scalar)
            }
        }
        return out + "\""
    }

    static func flatObject(_ bytes: [UInt8]) -> [String: String]? {
        var index = 0
        func skip() { while index < bytes.count, [0x20, 0x09, 0x0A, 0x0D].contains(bytes[index]) { index += 1 } }
        func expect(_ byte: UInt8) -> Bool {
            skip()
            guard index < bytes.count, bytes[index] == byte else { return false }
            index += 1
            return true
        }
        func string() -> String? {
            skip()
            guard index < bytes.count, bytes[index] == 0x22 else { return nil }
            index += 1
            var raw: [UInt8] = []
            var scalars = String.UnicodeScalarView()
            func flush() -> Bool {
                guard !raw.isEmpty else { return true }
                guard let piece = String(bytes: raw, encoding: .utf8) else { return false }
                scalars.append(contentsOf: piece.unicodeScalars)
                raw.removeAll()
                return true
            }
            func hex4() -> UInt32? {
                guard index + 4 <= bytes.count, let text = String(bytes: bytes[index..<index + 4], encoding: .ascii),
                      let value = UInt32(text, radix: 16) else { return nil }
                index += 4
                return value
            }
            while index < bytes.count {
                let byte = bytes[index]
                index += 1
                if byte == 0x22 { return flush() ? String(scalars) : nil }
                if byte < 0x20 { return nil }
                guard byte == 0x5C else { raw.append(byte); continue }
                guard flush(), index < bytes.count else { return nil }
                let escape = bytes[index]
                index += 1
                switch escape {
                case 0x22: scalars.append("\"")
                case 0x5C: scalars.append("\\")
                case 0x2F: scalars.append("/")
                case 0x62: scalars.append("\u{08}")
                case 0x66: scalars.append("\u{0C}")
                case 0x6E: scalars.append("\n")
                case 0x72: scalars.append("\r")
                case 0x74: scalars.append("\t")
                case 0x75:
                    guard let high = hex4() else { return nil }
                    if (0xD800...0xDBFF).contains(high) {
                        guard index + 2 <= bytes.count, bytes[index] == 0x5C, bytes[index + 1] == 0x75 else { return nil }
                        index += 2
                        guard let low = hex4(), (0xDC00...0xDFFF).contains(low),
                              let scalar = Unicode.Scalar(0x10000 + ((high - 0xD800) << 10) + (low - 0xDC00)) else { return nil }
                        scalars.append(scalar)
                    } else {
                        guard let scalar = Unicode.Scalar(high) else { return nil }
                        scalars.append(scalar)
                    }
                default: return nil
                }
            }
            return nil
        }
        guard expect(0x7B) else { return nil }
        var result: [String: String] = [:]
        skip()
        if index < bytes.count, bytes[index] == 0x7D {
            index += 1
        } else {
            while true {
                guard let key = string(), expect(0x3A), let value = string(), result[key] == nil else { return nil }
                result[key] = value
                if expect(0x2C) { continue }
                guard expect(0x7D) else { return nil }
                break
            }
        }
        skip()
        return index == bytes.count ? result : nil
    }
}
