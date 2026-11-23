import Foundation

public enum PhoneKey {
    static let extensionTail = try! NSRegularExpression(pattern: "\\s*(?:[;,#]|(?:ext(?:ension)?\\.?|x)\\s*\\d).*$", options: [.caseInsensitive])
    static let spaces = try! NSRegularExpression(pattern: "[\\u00a0\\u2000-\\u200b\\u2010-\\u2015]", options: [])

    public static func canonical(_ raw: String, countryCode: String = "1") -> String? {
        var s = raw.precomposedStringWithCompatibilityMapping
        s = spaces.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: " ")
        s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        s = extensionTail.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: "")
        guard !s.isEmpty, s.unicodeScalars.allSatisfy({ "0123456789+-.()/ \t\n\r".unicodeScalars.contains($0) }) else { return nil }
        if let plus = s.lastIndex(of: "+"), plus != s.startIndex { return nil }
        let digits = String(s.filter { $0.isASCII && $0.isNumber })
        var full: String
        if s.hasPrefix("+") {
            full = digits
        } else if digits.hasPrefix("00") {
            full = String(digits.dropFirst(2))
        } else if countryCode == "1" && digits.hasPrefix("011") {
            full = String(digits.dropFirst(3))
        } else if countryCode == "1" {
            if digits.count == 10 { full = "1" + digits } else if digits.count == 11 && digits.hasPrefix("1") { full = digits } else { return nil }
        } else {
            full = countryCode + (digits.hasPrefix("0") ? String(digits.dropFirst()) : digits)
        }
        return (8...15).contains(full.count) && !full.hasPrefix("0") ? "+" + full : nil
    }

    public static func validCountryCode(_ raw: String) -> Bool {
        raw.count >= 1 && raw.count <= 3 && raw.first != "0" && raw.allSatisfy { $0.isASCII && $0.isNumber }
    }

    public static func email(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}
