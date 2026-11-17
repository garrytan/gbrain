import Foundation

public enum BodyDecode: Equatable {
    case text(String)
    case undecodable
}

public enum TypedStream {
    static let header: [UInt8] = [0x04, 0x0B] + Array("streamtyped".utf8)
    static let stringClasses: [[UInt8]] = ["NSString", "NSMutableString"].map { [UInt8($0.utf8.count)] + Array($0.utf8) }
    static let stringType: [UInt8] = [0x84, 0x01, 0x2B]
    static let typeSearchWindow = 32

    public static func decodeText(_ data: [UInt8]) -> BodyDecode {
        guard data.count > header.count, Array(data[0..<header.count]) == header else { return .undecodable }
        guard let classEnd = earliestClassEnd(data) else { return .undecodable }
        guard let typeAt = find(stringType, in: data, from: classEnd, limit: classEnd + typeSearchWindow) else { return .undecodable }
        var cursor = typeAt + stringType.count
        guard let length = readLength(data, &cursor), length <= data.count - cursor else { return .undecodable }
        guard let text = String(bytes: data[cursor..<(cursor + length)], encoding: .utf8) else { return .undecodable }
        return .text(text)
    }

    static func earliestClassEnd(_ data: [UInt8]) -> Int? {
        var best: Int?
        for name in stringClasses {
            guard let at = find(name, in: data, from: header.count) else { continue }
            let end = at + name.count
            if let current = best, current <= end { continue }
            best = end
        }
        return best
    }

    static func find(_ needle: [UInt8], in data: [UInt8], from start: Int, limit: Int? = nil) -> Int? {
        let last = min(limit ?? data.count, data.count) - needle.count
        guard !needle.isEmpty, start >= 0, start <= last else { return nil }
        var i = start
        while i <= last {
            var j = 0
            while j < needle.count && data[i + j] == needle[j] { j += 1 }
            if j == needle.count { return i }
            i += 1
        }
        return nil
    }

    static func readLength(_ data: [UInt8], _ cursor: inout Int) -> Int? {
        guard cursor < data.count else { return nil }
        let marker = data[cursor]
        cursor += 1
        switch marker {
        case 0x81:
            guard data.count - cursor >= 2 else { return nil }
            let value = Int16(bitPattern: UInt16(data[cursor]) | UInt16(data[cursor + 1]) << 8)
            cursor += 2
            return value >= 0 ? Int(value) : nil
        case 0x82:
            guard data.count - cursor >= 4 else { return nil }
            var raw: UInt32 = 0
            for k in 0..<4 { raw |= UInt32(data[cursor + k]) << (8 * UInt32(k)) }
            cursor += 4
            let value = Int32(bitPattern: raw)
            return value >= 0 ? Int(value) : nil
        default:
            return marker < 0x80 ? Int(marker) : nil
        }
    }
}
