import Foundation
import SQLite3
@testable import HelperCore

let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
let base = AppleTime.raw(from: AppleTime.parseISO("2026-01-01T00:00:00Z")!)

func minutes(_ n: Int64) -> Int64 { base + n * 60_000_000_000 }

func archive(_ string: String, attributes: Bool = false) -> [UInt8] {
    let value: NSAttributedString = attributes
        ? NSMutableAttributedString(string: string, attributes: [NSAttributedString.Key("__kIMMessagePartAttributeName"): NSNumber(value: 0)])
        : NSAttributedString(string: string)
    return Array(NSArchiver.archivedData(withRootObject: value))
}

func hex(_ string: String) -> [UInt8] {
    var bytes: [UInt8] = []
    var index = string.startIndex
    while index < string.endIndex {
        let next = string.index(index, offsetBy: 2)
        bytes.append(UInt8(string[index..<next], radix: 16)!)
        index = next
    }
    return bytes
}

struct SplitMix: RandomNumberGenerator {
    var state: UInt64
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}

final class Fixture {
    let directory: URL
    let path: String
    var db: OpaquePointer?

    init(wal: Bool = false, legacy: Bool = false, skipTable: String? = nil) {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("helper-fixture-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        path = directory.appendingPathComponent("chat.db").path
        precondition(sqlite3_open(path, &db) == SQLITE_OK)
        if wal { exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;") }
        let messageExtra = legacy ? "" : ", attributedBody BLOB, associated_message_type INTEGER DEFAULT 0, item_type INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0, date_edited INTEGER DEFAULT 0, date_retracted INTEGER DEFAULT 0"
        let joinExtra = legacy ? "" : ", message_date INTEGER DEFAULT 0"
        let tables = [
            "handle": "CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE, id TEXT NOT NULL, service TEXT)",
            "chat": "CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER, chat_identifier TEXT, service_name TEXT, display_name TEXT)",
            "chat_handle_join": "CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER, UNIQUE(chat_id, handle_id))",
            "message": "CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, text TEXT, handle_id INTEGER DEFAULT 0, date INTEGER, is_from_me INTEGER DEFAULT 0\(messageExtra))",
            "chat_message_join": "CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER\(joinExtra), PRIMARY KEY (chat_id, message_id))",
        ]
        for (name, sql) in tables where name != skipTable { exec(sql) }
    }

    deinit {
        close()
        try? FileManager.default.removeItem(at: directory)
    }

    func close() {
        if let db { sqlite3_close(db) }
        db = nil
    }

    func exec(_ sql: String) {
        var error: UnsafeMutablePointer<CChar>?
        let rc = sqlite3_exec(db, sql, nil, nil, &error)
        precondition(rc == SQLITE_OK, error.map { String(cString: $0) } ?? "exec failed")
    }

    func handle(_ rowid: Int64, _ id: String) {
        exec("INSERT INTO handle (ROWID, id, service) VALUES (\(rowid), '\(id)', 'iMessage')")
    }

    func chat(_ rowid: Int64, guid: String, identifier: String, name: String? = nil, service: String = "iMessage", style: Int = 45, handles: [Int64]) {
        let display = name.map { "'\($0)'" } ?? "NULL"
        exec("INSERT INTO chat (ROWID, guid, style, chat_identifier, service_name, display_name) VALUES (\(rowid), '\(guid)', \(style), '\(identifier)', '\(service)', \(display))")
        for handle in handles { exec("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (\(rowid), \(handle))") }
    }

    @discardableResult
    func message(_ rowid: Int64, chat: Int64, text: String?, body: [UInt8]? = nil, date: Int64, fromMe: Bool = false, handle: Int64 = 0,
                 association: Int = 0, itemType: Int = 0, attachments: Bool = false, edited: Int64 = 0, retracted: Int64 = 0) -> Int64 {
        let legacy = !columns("message").contains("attributedBody")
        let sql = legacy
            ? "INSERT INTO message (ROWID, guid, text, handle_id, date, is_from_me) VALUES (?, ?, ?, ?, ?, ?)"
            : "INSERT INTO message (ROWID, guid, text, handle_id, date, is_from_me, attributedBody, associated_message_type, item_type, cache_has_attachments, date_edited, date_retracted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        var statement: OpaquePointer?
        precondition(sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK)
        sqlite3_bind_int64(statement, 1, rowid)
        sqlite3_bind_text(statement, 2, "GUID-\(rowid)", -1, transient)
        if let text { sqlite3_bind_text(statement, 3, text, -1, transient) } else { sqlite3_bind_null(statement, 3) }
        sqlite3_bind_int64(statement, 4, handle)
        sqlite3_bind_int64(statement, 5, date)
        sqlite3_bind_int64(statement, 6, fromMe ? 1 : 0)
        if !legacy {
            if let body { _ = body.withUnsafeBytes { sqlite3_bind_blob(statement, 7, $0.baseAddress, Int32(body.count), transient) } } else { sqlite3_bind_null(statement, 7) }
            sqlite3_bind_int64(statement, 8, Int64(association))
            sqlite3_bind_int64(statement, 9, Int64(itemType))
            sqlite3_bind_int64(statement, 10, attachments ? 1 : 0)
            sqlite3_bind_int64(statement, 11, edited)
            sqlite3_bind_int64(statement, 12, retracted)
        }
        precondition(sqlite3_step(statement) == SQLITE_DONE)
        sqlite3_finalize(statement)
        let joinDate = columns("chat_message_join").contains("message_date")
        exec(joinDate
            ? "INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (\(chat), \(rowid), \(date))"
            : "INSERT INTO chat_message_join (chat_id, message_id) VALUES (\(chat), \(rowid))")
        return rowid
    }

    func columns(_ table: String) -> Set<String> {
        var statement: OpaquePointer?
        var names = Set<String>()
        guard sqlite3_prepare_v2(db, "PRAGMA table_info(\(table))", -1, &statement, nil) == SQLITE_OK else { return names }
        while sqlite3_step(statement) == SQLITE_ROW { names.insert(String(cString: sqlite3_column_text(statement, 1))) }
        sqlite3_finalize(statement)
        return names
    }

    static func standard(wal: Bool = false) -> Fixture {
        let fixture = Fixture(wal: wal)
        fixture.populate()
        return fixture
    }

    func populate() {
        handle(1, "+15550100")
        handle(2, "test@example.invalid")
        handle(3, "+15550111")
        handle(4, "12345")
        chat(1, guid: "iMessage;-;+15550100", identifier: "+15550100", handles: [1])
        chat(2, guid: "SMS;-;+15550100", identifier: "+15550100", service: "SMS", handles: [1])
        chat(3, guid: "iMessage;+;chat900001", identifier: "chat900001", name: "Test Group", style: 43, handles: [2, 3])
        chat(4, guid: "SMS;-;12345", identifier: "12345", service: "SMS", handles: [4])
        chat(5, guid: "iMessage;-;test@example.invalid", identifier: "test@example.invalid", handles: [2])

        message(1, chat: 1, text: "hi one", date: minutes(1), handle: 1)
        message(2, chat: 1, text: "reply", date: minutes(2), fromMe: true, handle: 1)
        message(3, chat: 1, text: nil, body: archive("from body"), date: minutes(3), handle: 1)
        message(4, chat: 1, text: "Loved a message", date: minutes(5), handle: 1, association: 2000)
        message(5, chat: 2, text: "sms msg", date: minutes(4), handle: 1, attachments: true)
        message(6, chat: 3, text: "group a", date: minutes(6), handle: 2)
        message(7, chat: 3, text: "group b", date: minutes(7), handle: 3)
        message(8, chat: 3, text: nil, date: minutes(8), handle: 2, itemType: 2)
        message(9, chat: 4, text: "code 1234", date: (base / 1_000_000_000) - 600, handle: 4)
        message(10, chat: 5, text: nil, body: TypedStream.header + [0x84, 0x01, 0x40, 0xFF, 0xFF], date: minutes(9), handle: 2)
        message(11, chat: 5, text: "old words", body: archive("new words"), date: minutes(10), handle: 2, edited: minutes(12))
        message(12, chat: 5, text: "gone", date: minutes(11), handle: 2, retracted: minutes(13))
    }
}

func reader(_ fixture: Fixture) throws -> Reader {
    Reader(db: try ChatDB.open(path: fixture.path))
}
