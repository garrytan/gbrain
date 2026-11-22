import Foundation

public struct Message: Encodable, Equatable {
    public let id: String
    public let rowid: Int64
    public let timestamp: String
    public let isFromMe: Bool
    public let text: String
    public let textStatus: String
    public let from: String?
    public let fromIdentifier: String?
    public let hasAttachments: Bool
    public let editedAt: String?
    public let retracted: Bool
}

public struct ThreadSummary: Encodable {
    public let threadId: String
    public let chatRowids: [Int64]
    public let chatGuids: [String]
    public let displayName: String
    public let participantCount: Int
    public let participants: [String]
    public let isGroup: Bool
    public let service: String?
    public let lastMessageAt: String?
    public let lastMessage: Message?
}

public struct ThreadPage: Encodable {
    public let contact: String
    public let threadId: String
    public let isGroup: Bool
    public let messages: [Message]
}

public struct PageMeta: Encodable {
    public let count: Int
    public let undecodable: Int
    public let hasMore: Bool
    public let nextSinceRowid: Int64?
}

public struct ListMeta: Encodable {
    public let count: Int
    public let undecodable: Int
}

public struct Envelope<Data: Encodable, Meta: Encodable>: Encodable {
    public let data: Data
    public let meta: Meta
}

public struct Stats: Encodable {
    public let db: String
    public let threads: Int
    public let threadIdShapes: [String: Int]
    public let recentMessagesScanned: Int
    public let decodedFromBody: Int
    public let undecodable: Int
    public let edited: Int
    public let editedTextDiffers: Int
    public let retracted: Int
}

public enum ThreadSelector: Equatable {
    case identifier(String)
    case chatRowid(Int64)
    case chatGuid(String)
}

struct ChatInfo {
    let rowid: Int64
    let guid: String
    let identifier: String
    let displayName: String?
    let service: String?
    let style: Int64
}

public final class Reader {
    let db: ChatDB

    public init(db: ChatDB) {
        self.db = db
    }

    public func listThreads(limit: Int, includeLastMessage: Bool) throws -> Envelope<[ThreadSummary], ListMeta> {
        var rows: [(String, Int64)] = []
        try db.query(listSQL(), [.int(Int64(limit))]) { row in
            if let identifier = row.text(0) { rows.append((identifier, row.int(1))) }
        }
        var threads: [ThreadSummary] = []
        var undecodable = 0
        for (identifier, lastRaw) in rows {
            let chats = try chats(for: .identifier(identifier))
            guard !chats.isEmpty else { continue }
            let participants = try participants(of: chats)
            var last: Message?
            if includeLastMessage {
                last = try messages(in: chats, sinceRowid: nil, since: nil, limit: 1, includeReactions: false).messages.last
                if last?.textStatus == "undecodable" { undecodable += 1 }
            }
            threads.append(summary(identifier: identifier, chats: chats, participants: participants, last: last, lastRaw: lastRaw))
        }
        return Envelope(data: threads, meta: ListMeta(count: threads.count, undecodable: undecodable))
    }

    public func getThread(_ selector: ThreadSelector, sinceRowid: Int64?, since: Date?, limit: Int, includeReactions: Bool) throws -> Envelope<ThreadPage, PageMeta>? {
        let chats = try chats(for: selector)
        guard let first = chats.first else { return nil }
        let participants = try participants(of: chats)
        let page = try messages(in: chats, sinceRowid: sinceRowid, since: since, limit: limit, includeReactions: includeReactions)
        let named = chats.compactMap { $0.displayName }.first { !$0.isEmpty }
        let data = ThreadPage(contact: named ?? first.identifier, threadId: first.identifier, isGroup: isGroup(chats, participants), messages: page.messages)
        let meta = PageMeta(
            count: page.messages.count,
            undecodable: page.messages.filter { $0.textStatus == "undecodable" }.count,
            hasMore: page.hasMore,
            nextSinceRowid: page.messages.map(\.rowid).max() ?? sinceRowid
        )
        return Envelope(data: data, meta: meta)
    }

    public func stats(recent: Int = 500) throws -> Stats {
        var shapes: [String: Int] = [:]
        try db.query("SELECT MIN(COALESCE(chat_identifier, guid)) FROM chat GROUP BY lower(COALESCE(chat_identifier, guid))", []) { row in
            shapes[Self.shape(of: row.text(0) ?? ""), default: 0] += 1
        }
        let threads = shapes.values.reduce(0, +)
        var scanned = 0, decoded = 0, undecodable = 0, edited = 0, differs = 0, retracted = 0
        try db.query(statsSQL(), [.int(Int64(recent))]) { row in
            scanned += 1
            let text = row.text(0)
            let body = row.blob(1)
            let isEdited = row.int(2) != 0
            let isRetracted = row.int(3) != 0
            if isRetracted { retracted += 1 }
            if isEdited {
                edited += 1
                if let body, case .text(let fromBody) = TypedStream.decodeText(body), Self.clean(fromBody) != Self.clean(text ?? "") { differs += 1 }
            }
            let resolved = Self.resolveText(text: text, body: body, edited: isEdited, retracted: isRetracted)
            if resolved.status == "undecodable" { undecodable += 1 }
            if resolved.status == "ok", Self.clean(text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { decoded += 1 }
        }
        return Stats(db: "ok", threads: threads, threadIdShapes: shapes, recentMessagesScanned: scanned, decodedFromBody: decoded, undecodable: undecodable, edited: edited, editedTextDiffers: differs, retracted: retracted)
    }

    public func healthCheck() throws {
        try db.validateSchema()
        try db.check(listSQL())
        try db.check(chatSQL(.identifier("")))
        try db.check(chatSQL(.chatRowid(0)))
        try db.check(chatSQL(.chatGuid("")))
        try db.check(participantsSQL(count: 1))
        try db.check(statsSQL())
        for (rowid, date) in [(false, false), (true, false), (false, true), (true, true)] {
            try db.check(messageSQL(chatCount: 1, sinceRowid: rowid, sinceDate: date, includeReactions: false))
            try db.check(messageSQL(chatCount: 1, sinceRowid: rowid, sinceDate: date, includeReactions: true))
        }
        try db.query("SELECT 1 FROM message LIMIT 1", []) { _ in }
    }

    static func shape(of identifier: String) -> String {
        let digits = CharacterSet.decimalDigits
        func allDigits(_ text: Substring) -> Bool { !text.isEmpty && text.unicodeScalars.allSatisfy { digits.contains($0) } }
        if identifier.hasPrefix("+"), allDigits(identifier.dropFirst()) { return "plus_digits" }
        if identifier.contains("@") { return "email" }
        if identifier.hasPrefix("chat"), allDigits(identifier.dropFirst(4)) { return "chat_digits" }
        if allDigits(Substring(identifier)) { return identifier.count <= 6 ? "short_code" : "long_digits" }
        if identifier.hasPrefix("urn:biz:") { return "business" }
        return identifier.count >= 30 ? "other_30_plus" : "other_under_30"
    }

    static func resolveText(text: String?, body: [UInt8]?, edited: Bool, retracted: Bool) -> (text: String, status: String) {
        if retracted { return ("", "empty") }
        if edited, let body, !body.isEmpty {
            switch TypedStream.decodeText(body) {
            case .text(let fromBody) where !isBlank(clean(fromBody)): return (clean(fromBody), "ok")
            case .undecodable: return ("", "undecodable")
            default: break
            }
        }
        if let text, !isBlank(clean(text)) { return (clean(text), "ok") }
        guard let body, !body.isEmpty else { return ("", "empty") }
        switch TypedStream.decodeText(body) {
        case .text(let fromBody):
            let cleaned = clean(fromBody)
            return isBlank(cleaned) ? ("", "empty") : (cleaned, "ok")
        case .undecodable:
            return ("", "undecodable")
        }
    }

    static func clean(_ text: String) -> String {
        text.replacingOccurrences(of: "\u{FFFC}", with: "")
    }

    static func isBlank(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    func summary(identifier: String, chats: [ChatInfo], participants: [String], last: Message?, lastRaw: Int64) -> ThreadSummary {
        let named = chats.compactMap { $0.displayName }.first { !$0.isEmpty }
        let services = chats.compactMap { $0.service }.reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
        return ThreadSummary(
            threadId: identifier,
            chatRowids: chats.map(\.rowid),
            chatGuids: chats.map(\.guid),
            displayName: named ?? identifier,
            participantCount: participants.count + 1,
            participants: participants,
            isGroup: isGroup(chats, participants),
            service: services.isEmpty ? nil : services.joined(separator: ","),
            lastMessageAt: last?.timestamp ?? (lastRaw != 0 ? AppleTime.iso(fromRaw: lastRaw) : nil),
            lastMessage: last
        )
    }

    func isGroup(_ chats: [ChatInfo], _ participants: [String]) -> Bool {
        chats.contains { $0.style == 43 } || participants.count > 1
    }

    func chats(for selector: ThreadSelector) throws -> [ChatInfo] {
        var result: [ChatInfo] = []
        let bind: SQLValue
        switch selector {
        case .identifier(let value): bind = .text(value)
        case .chatRowid(let value): bind = .int(value)
        case .chatGuid(let value): bind = .text(value)
        }
        try db.query(chatSQL(selector), [bind]) { row in
            result.append(ChatInfo(rowid: row.int(0), guid: row.text(1) ?? "", identifier: row.text(2) ?? "", displayName: row.text(3), service: row.text(4), style: row.int(5)))
        }
        return result
    }

    func participants(of chats: [ChatInfo]) throws -> [String] {
        var handles: [String] = []
        try db.query(participantsSQL(count: chats.count), chats.map { .int($0.rowid) }) { row in
            if let id = row.text(0) { handles.append(id) }
        }
        return handles
    }

    func messages(in chats: [ChatInfo], sinceRowid: Int64?, since: Date?, limit: Int, includeReactions: Bool) throws -> (messages: [Message], hasMore: Bool) {
        let cursor = sinceRowid != nil || since != nil
        var binds: [SQLValue] = chats.map { .int($0.rowid) }
        if let sinceRowid { binds.append(.int(sinceRowid)) }
        if let since { binds.append(.int(AppleTime.raw(from: since))) }
        binds.append(.int(Int64(limit + 1)))
        var messages: [Message] = []
        let sql = messageSQL(chatCount: chats.count, sinceRowid: sinceRowid != nil, sinceDate: since != nil, includeReactions: includeReactions)
        try db.query(sql, binds) { row in
            messages.append(Self.message(from: row))
        }
        let hasMore = messages.count > limit
        if hasMore { messages.removeLast(messages.count - limit) }
        if !cursor { messages.reverse() }
        return (messages, hasMore)
    }

    static func message(from row: Row) -> Message {
        let fromMe = row.int(5) != 0
        let editedRaw = row.int(8)
        let resolved = resolveText(text: row.text(2), body: row.blob(3), edited: editedRaw != 0, retracted: row.int(9) != 0)
        return Message(
            id: row.text(1) ?? "",
            rowid: row.int(0),
            timestamp: AppleTime.iso(fromRaw: row.int(4)),
            isFromMe: fromMe,
            text: resolved.text,
            textStatus: resolved.status,
            from: fromMe ? nil : row.text(6),
            fromIdentifier: fromMe ? nil : row.text(6),
            hasAttachments: row.int(7) != 0,
            editedAt: editedRaw != 0 ? AppleTime.iso(fromRaw: editedRaw) : nil,
            retracted: row.int(9) != 0
        )
    }

    func column(_ table: String, _ name: String, _ alias: String, fallback: String) -> String {
        db.has(table, name) ? "\(alias).\(name)" : fallback
    }

    func listSQL() -> String {
        let joinHasDate = db.has("chat_message_join", "message_date")
        let date = AppleTime.normalizedSQL(joinHasDate ? "cmj.message_date" : "m.date")
        let join = joinHasDate ? "" : " JOIN message m ON m.ROWID = cmj.message_id"
        return """
        SELECT MIN(COALESCE(c.chat_identifier, c.guid)) AS ident, MAX(\(date)) AS last
        FROM chat c JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID\(join)
        GROUP BY lower(COALESCE(c.chat_identifier, c.guid))
        ORDER BY last DESC
        LIMIT ?
        """
    }

    func chatSQL(_ selector: ThreadSelector) -> String {
        let condition: String
        switch selector {
        case .identifier: condition = "lower(COALESCE(c.chat_identifier, c.guid)) = lower(?)"
        case .chatRowid: condition = "c.ROWID = ?"
        case .chatGuid: condition = "c.guid = ?"
        }
        return """
        SELECT c.ROWID, c.guid, COALESCE(c.chat_identifier, c.guid), \(column("chat", "display_name", "c", fallback: "NULL")),
               \(column("chat", "service_name", "c", fallback: "NULL")), \(column("chat", "style", "c", fallback: "0"))
        FROM chat c WHERE \(condition) ORDER BY c.ROWID
        """
    }

    func participantsSQL(count: Int) -> String {
        """
        SELECT DISTINCT h.id FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id
        WHERE chj.chat_id IN (\(placeholders(count))) ORDER BY h.id
        """
    }

    func messageSQL(chatCount: Int, sinceRowid: Bool, sinceDate: Bool, includeReactions: Bool) -> String {
        let date = AppleTime.normalizedSQL("m.date")
        var sql = """
        SELECT m.ROWID, m.guid, m.text, \(column("message", "attributedBody", "m", fallback: "NULL")), m.date, m.is_from_me, h.id,
               \(column("message", "cache_has_attachments", "m", fallback: "0")), \(column("message", "date_edited", "m", fallback: "0")),
               \(column("message", "date_retracted", "m", fallback: "0"))
        FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id
        WHERE m.ROWID IN (SELECT cmj.message_id FROM chat_message_join cmj WHERE cmj.chat_id IN (\(placeholders(chatCount))))
        """
        if !includeReactions { sql += reactionFilter() }
        if sinceRowid { sql += " AND m.ROWID > ?" }
        if sinceDate { sql += " AND \(date) > ?" }
        if sinceRowid || sinceDate {
            sql += " ORDER BY m.ROWID ASC"
        } else {
            sql += " ORDER BY \(date) DESC, m.ROWID DESC"
        }
        return sql + " LIMIT ?"
    }

    func statsSQL() -> String {
        """
        SELECT m.text, \(column("message", "attributedBody", "m", fallback: "NULL")), \(column("message", "date_edited", "m", fallback: "0")),
               \(column("message", "date_retracted", "m", fallback: "0"))
        FROM message m WHERE 1 = 1\(reactionFilter())
        ORDER BY m.ROWID DESC LIMIT ?
        """
    }

    func reactionFilter() -> String {
        var sql = ""
        if db.has("message", "associated_message_type") { sql += " AND COALESCE(m.associated_message_type, 0) NOT BETWEEN 2000 AND 3999" }
        if db.has("message", "item_type") { sql += " AND COALESCE(m.item_type, 0) = 0" }
        return sql
    }

    func placeholders(_ count: Int) -> String {
        Array(repeating: "?", count: max(count, 1)).joined(separator: ", ")
    }
}
