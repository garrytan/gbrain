import Foundation

public enum SourceCatalog {
    public static let ids = ["imessage"]
    public static var scopes: Set<String> { Set(ids.map(readScope)) }

    public static func readScope(_ id: String) -> String {
        "read:\(id)"
    }
}

public struct SourceStatus: Encodable, Equatable {
    public let id: String
    public let enabled: Bool
    public let permission: String
    public let state: String
    public let scopes: [String]
    public let routes: [String]
}

public protocol SourceModule {
    var id: String { get }
    var permission: String { get }
    var routes: [String] { get }
    func state() -> String
    func handle(path: String, query: [String: String]) throws -> (response: HTTPResponse, rows: Int)
    func problem(for error: Error) -> Problem
}

public final class IMessageSource: SourceModule {
    public let id = "imessage"
    public let permission = "full_disk_access"
    public let routes = ["/v1/imessage/threads", "/v1/imessage/thread"]
    let dbPath: String

    public init(dbPath: String) {
        self.dbPath = dbPath
    }

    public func state() -> String {
        do {
            try Reader(db: try ChatDB.open(path: dbPath)).healthCheck()
            return "ok"
        } catch DBError.missing {
            return "missing"
        } catch DBError.noAccess {
            return "no_access"
        } catch DBError.schemaMismatch {
            return "schema_mismatch"
        } catch DBError.busy {
            return "busy"
        } catch {
            return "error"
        }
    }

    public func handle(path: String, query: [String: String]) throws -> (response: HTTPResponse, rows: Int) {
        let db = try ChatDB.open(path: dbPath)
        try db.validateSchema()
        let reader = Reader(db: db)
        if path == "/v1/imessage/threads" {
            let limit = try Self.intParam(query, "limit", 1...200) ?? 30
            let includeLast = try Self.boolParam(query, "include_last_message", default: true)
            let result = try reader.listThreads(limit: Int(limit), includeLastMessage: includeLast)
            return (response: .json(200, result), rows: result.data.count)
        }
        let selector = try Self.selector(query)
        let limit = try Self.intParam(query, "limit", 1...500) ?? 50
        let sinceRowid = try Self.intParam(query, "since_rowid", 0...Int64.max)
        var since: Date?
        if let raw = query["since_iso"] {
            guard let parsed = AppleTime.parseISO(raw) else { throw Problem.badParam("since_iso must be an ISO-8601 time such as 2026-01-01T00:00:00Z") }
            since = parsed
        }
        let includeReactions = try Self.boolParam(query, "include_reactions", default: false)
        guard let result = try reader.getThread(selector, sinceRowid: sinceRowid, since: since, limit: Int(limit), includeReactions: includeReactions) else {
            throw Problem.notFound
        }
        return (response: .json(200, result), rows: result.data.messages.count)
    }

    public func problem(for error: Error) -> Problem {
        Problem.from(error, dbPath: dbPath)
    }

    static func selector(_ query: [String: String]) throws -> ThreadSelector {
        let present = ["thread_id", "chat_rowid", "chat_guid"].filter { query[$0] != nil }
        guard present.count == 1 else { throw Problem.badParam("give exactly one of thread_id, chat_rowid or chat_guid") }
        switch present[0] {
        case "chat_rowid":
            return .chatRowid(try intParam(query, "chat_rowid", 1...Int64.max)!)
        case "chat_guid":
            guard let guid = query["chat_guid"], !guid.isEmpty else { throw Problem.badParam("chat_guid must not be empty") }
            return .chatGuid(guid)
        default:
            guard let id = query["thread_id"], !id.isEmpty else { throw Problem.badParam("thread_id must not be empty") }
            return .identifier(id)
        }
    }

    static func intParam(_ query: [String: String], _ name: String, _ range: ClosedRange<Int64>) throws -> Int64? {
        guard let raw = query[name] else { return nil }
        guard let value = Int64(raw), range.contains(value) else {
            throw Problem.badParam("\(name) must be an integer from \(range.lowerBound) to \(range.upperBound)")
        }
        return value
    }

    static func boolParam(_ query: [String: String], _ name: String, default fallback: Bool) throws -> Bool {
        guard let raw = query[name] else { return fallback }
        switch raw.lowercased() {
        case "1", "true", "yes": return true
        case "0", "false", "no": return false
        default: throw Problem.badParam("\(name) must be true or false")
        }
    }
}
