import Foundation

public enum Delivery: Equatable {
    case sent(guid: String, rowid: Int64)
    case failed(error: Int64, guid: String, rowid: Int64)
    case pending
}

public protocol DeliveryLedger {
    func highWater() throws -> Int64
    func delivery(after highWater: Int64, to recipient: String, text: String, guid: String?, sentBy: Date?, skipping: Set<String>) throws -> Delivery
    func hasOneToOneHistory(with recipient: String) throws -> Bool
}

public final class ChatDeliveryLedger: DeliveryLedger {
    let dbPath: String

    public init(dbPath: String) {
        self.dbPath = dbPath
    }

    func open() throws -> ChatDB {
        let db = try ChatDB.open(path: dbPath)
        try db.validateSchema()
        return db
    }

    public func highWater() throws -> Int64 {
        var value: Int64 = 0
        try open().query("SELECT COALESCE(MAX(ROWID), 0) FROM message", []) { value = $0.int(0) }
        return value
    }

    public func delivery(after highWater: Int64, to recipient: String, text: String, guid: String?, sentBy: Date?, skipping: Set<String>) throws -> Delivery {
        let db = try open()
        let body = db.has("message", "attributedBody") ? "m.attributedBody" : "NULL"
        let sent = db.has("message", "is_sent") ? "m.is_sent" : "0"
        let error = db.has("message", "error") ? "m.error" : "0"
        let sql = "SELECT m.ROWID, m.guid, m.text, \(body), \(sent), \(error), h.id FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id "
            + "WHERE m.ROWID > ? AND m.is_from_me = 1 AND \(AppleTime.normalizedSQL("m.date")) <= ? ORDER BY m.ROWID LIMIT 500"
        let wanted = text.precomposedStringWithCanonicalMapping
        var result = Delivery.pending
        try db.query(sql, [.int(highWater), .int(sentBy.map(AppleTime.raw(from:)) ?? .max)]) { row in
            guard result == .pending else { return }
            let rowGuid = row.text(1) ?? ""
            guard !skipping.contains(rowGuid) else { return }
            if let guid, !guid.isEmpty {
                guard rowGuid == guid else { return }
            } else {
                guard let handle = row.text(6), Recipient.normalize(handle) == recipient || handle.lowercased() == recipient else { return }
                let resolved = Reader.resolveText(text: row.text(2), body: row.blob(3), edited: false, retracted: false).text
                guard resolved.precomposedStringWithCanonicalMapping == wanted else { return }
            }
            let failure = row.int(5)
            if failure != 0 {
                result = .failed(error: failure, guid: rowGuid, rowid: row.int(0))
            } else if row.int(4) != 0 {
                result = .sent(guid: rowGuid, rowid: row.int(0))
            }
        }
        return result
    }

    public func hasOneToOneHistory(with recipient: String) throws -> Bool {
        let sql = "SELECT h.id FROM chat c JOIN chat_handle_join j ON j.chat_id = c.ROWID JOIN handle h ON h.ROWID = j.handle_id "
            + "WHERE (SELECT COUNT(*) FROM chat_handle_join x WHERE x.chat_id = c.ROWID) = 1 "
            + "AND EXISTS (SELECT 1 FROM chat_message_join cm WHERE cm.chat_id = c.ROWID)"
        var found = false
        try open().query(sql, []) { row in
            guard !found, let handle = row.text(0) else { return }
            if Recipient.normalize(handle) == recipient || handle.lowercased() == recipient { found = true }
        }
        return found
    }
}
