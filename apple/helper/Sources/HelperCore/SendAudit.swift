import Darwin
import Foundation

public struct AuditRecord: Codable, Equatable {
    public var v = 1
    public var t: String
    public var kind: String
    public var key: String
    public var hash: String?
    public var keyName: String?
    public var peer: String?
    public var to: String?
    public var toHash: String?
    public var text: String?
    public var requestedBy: String?
    public var ownerInstruction: String?
    public var firstContact: Bool?
    public var highWater: Int64?
    public var outcome: String?
    public var code: String?
    public var guid: String?
    public var rowid: Int64?
    public var error: Int64?

    public init(t: String, kind: String, key: String) {
        self.t = t
        self.kind = kind
        self.key = key
    }

    public var date: Date? { AppleTime.parseISO(t) }

    public var redacted: AuditRecord {
        var copy = AuditRecord(t: t, kind: kind, key: key)
        copy.toHash = toHash
        copy.outcome = outcome
        copy.code = code
        copy.error = error
        copy.firstContact = firstContact
        return copy
    }
}

public struct AuditEntry {
    public let pending: AuditRecord
    public var outcome: AuditRecord?

    public var binds: Bool { outcome.map { $0.outcome != Outcome.failed } ?? true }
}

public enum Outcome {
    public static let sent = "sent"
    public static let failedAfterSubmit = "failed_after_submit"
    public static let unknown = "unknown"
    public static let failed = "failed"
}

public final class SendAudit {
    public static let indexDays = 8.0
    public static let replayDays = 7.0
    public static let retentionDays = 90.0

    let directory: String
    public private(set) var entries: [String: AuditEntry] = [:]
    var unwritten: [AuditRecord] = []

    public init(directory: String) {
        self.directory = directory
    }

    public static var defaultDirectory: String { Config.defaultDirectory + "/send-audit" }

    static func stamp(_ date: Date) -> String {
        date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    }

    static func month(_ date: Date) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let parts = calendar.dateComponents([.year, .month], from: date)
        return String(format: "%04d-%02d", parts.year!, parts.month!)
    }

    func file(_ month: String) -> String { directory + "/\(month).jsonl" }

    public func monthFiles() -> [String] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory)) ?? []
        return names.filter { $0.count == 13 && $0.hasSuffix(".jsonl") && !$0.hasPrefix("torn-") }.sorted().map { directory + "/" + $0 }
    }

    static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }

    static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }

    public func read(_ path: String, repair: Bool) -> [AuditRecord] {
        guard let data = FileManager.default.contents(atPath: path) else { return [] }
        let bytes = Array(data)
        var records: [AuditRecord] = []
        var start = 0
        var goodEnd = 0
        let decoder = Self.decoder()
        while start < bytes.count {
            let end = bytes[start...].firstIndex(of: 0x0A)
            let line = bytes[start..<(end ?? bytes.count)]
            if let end, let record = try? decoder.decode(AuditRecord.self, from: Data(line)) {
                records.append(record)
                goodEnd = end + 1
            } else if end == nil {
                if repair { moveTorn(path: path, bytes: Array(line), keep: goodEnd) }
                break
            } else {
                Log.line("send audit: skipped an unreadable line in \((path as NSString).lastPathComponent)")
                goodEnd = end! + 1
            }
            start = (end ?? bytes.count) + 1
        }
        return records
    }

    func moveTorn(path: String, bytes: [UInt8], keep: Int) {
        let torn = directory + "/torn-\(Int(Date().timeIntervalSince1970)).jsonl"
        FileManager.default.createFile(atPath: torn, contents: Data(bytes), attributes: [.posixPermissions: 0o600])
        truncate(path, off_t(keep))
        Log.line("send audit: moved a torn last line aside")
    }

    public func load(now: Date) {
        entries = [:]
        let cutoff = now.addingTimeInterval(-Self.indexDays * 86400)
        for path in monthFiles().suffix(2) {
            for record in read(path, repair: true) {
                guard let date = record.date, date >= cutoff else { continue }
                apply(record)
            }
        }
    }

    func apply(_ record: AuditRecord) {
        if record.kind == "pending" {
            entries[record.key] = AuditEntry(pending: record, outcome: nil)
        } else if entries[record.key] != nil {
            entries[record.key]?.outcome = record
        }
    }

    public func append(_ record: AuditRecord, now: Date) throws {
        unwritten.append(record)
        do {
            try flush(now: now)
        } catch {
            if record.kind == "pending" { unwritten.removeLast() } else { apply(record) }
            throw error
        }
        apply(record)
    }

    public func flush(now: Date) throws {
        guard !unwritten.isEmpty else { return }
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var data = Data()
        for record in unwritten {
            data.append(try Self.encoder().encode(record))
            data.append(0x0A)
        }
        let path = file(Self.month(now))
        let fd = Darwin.open(path, O_WRONLY | O_CREAT | O_APPEND, 0o600)
        guard fd >= 0 else { throw Problem.auditUnavailable }
        defer { close(fd) }
        let start = lseek(fd, 0, SEEK_END)
        let written = data.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
        guard written == data.count, fsync(fd) == 0 else {
            if start >= 0 { _ = ftruncate(fd, start) }
            throw Problem.auditUnavailable
        }
        unwritten.removeAll()
    }

    public func attempts(since: Date) -> [AuditRecord] {
        entries.values.filter { $0.binds }.map(\.pending).filter { ($0.date ?? .distantPast) > since }
    }

    public func replayable(_ key: String, now: Date) -> AuditEntry? {
        guard let entry = entries[key], entry.binds, let date = entry.pending.date,
              now.timeIntervalSince(date) < Self.replayDays * 86400 else { return nil }
        return entry
    }

    public func applyRetention(now: Date) {
        let cutoff = now.addingTimeInterval(-Self.retentionDays * 86400)
        let current = file(Self.month(now))
        for path in monthFiles() where path != current {
            let records = read(path, repair: false)
            guard records.contains(where: { ($0.date ?? now) < cutoff && ($0.text != nil || $0.to != nil || $0.ownerInstruction != nil) }) else { continue }
            let kept = records.map { ($0.date ?? now) < cutoff ? $0.redacted : $0 }
            var data = Data()
            for record in kept {
                guard let line = try? Self.encoder().encode(record) else { continue }
                data.append(line)
                data.append(0x0A)
            }
            let temp = path + ".tmp-\(getpid())"
            let fd = Darwin.open(temp, O_WRONLY | O_CREAT | O_TRUNC, 0o600)
            guard fd >= 0 else { continue }
            let written = data.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
            let synced = fsync(fd) == 0
            close(fd)
            if written == data.count, synced, rename(temp, path) == 0 { continue }
            unlink(temp)
            Log.line("send audit: could not apply retention to \((path as NSString).lastPathComponent)")
        }
    }
}
