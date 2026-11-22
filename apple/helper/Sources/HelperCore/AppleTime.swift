import Foundation

public enum AppleTime {
    public static let referenceOffset: Int64 = 978_307_200
    static let secondsThreshold: Int64 = 100_000_000_000

    public static func nanoseconds(fromRaw raw: Int64) -> Int64 {
        guard raw > -secondsThreshold, raw < secondsThreshold else { return raw }
        let (nanoseconds, overflow) = raw.multipliedReportingOverflow(by: 1_000_000_000)
        return overflow ? (raw < 0 ? .min : .max) : nanoseconds
    }

    public static func date(fromRaw raw: Int64) -> Date {
        Date(timeIntervalSince1970: Double(referenceOffset) + Double(nanoseconds(fromRaw: raw)) / 1e9)
    }

    public static func raw(from date: Date) -> Int64 {
        let nanoseconds = ((date.timeIntervalSince1970 - Double(referenceOffset)) * 1e9).rounded()
        return Int64(exactly: nanoseconds) ?? (nanoseconds < 0 ? .min : .max)
    }

    public static func iso(fromRaw raw: Int64) -> String {
        iso(date(fromRaw: raw))
    }

    public static func iso(_ date: Date) -> String {
        date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    }

    public static func parseISO(_ string: String) -> Date? {
        if let date = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(string) { return date }
        return try? Date.ISO8601FormatStyle().parse(string)
    }

    static func normalizedSQL(_ column: String) -> String {
        "(CASE WHEN ABS(\(column)) < \(secondsThreshold) THEN \(column) * 1000000000 ELSE \(column) END)"
    }
}
