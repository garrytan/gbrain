import Darwin
import Foundation
import SQLite3

public enum DBError: Error, Equatable {
    case missing
    case noAccess
    case busy
    case schemaMismatch(String)
    case sqlite(Int32, String)
}

public enum SQLValue {
    case int(Int64)
    case text(String)
}

public struct Row {
    let statement: OpaquePointer

    public func int(_ index: Int32) -> Int64 { sqlite3_column_int64(statement, index) }

    public func text(_ index: Int32) -> String? {
        guard sqlite3_column_type(statement, index) != SQLITE_NULL, let pointer = sqlite3_column_text(statement, index) else { return nil }
        let count = Int(sqlite3_column_bytes(statement, index))
        return String(decoding: UnsafeBufferPointer(start: pointer, count: count), as: UTF8.self)
    }

    public func blob(_ index: Int32) -> [UInt8]? {
        guard sqlite3_column_type(statement, index) != SQLITE_NULL else { return nil }
        let count = Int(sqlite3_column_bytes(statement, index))
        guard count > 0, let pointer = sqlite3_column_blob(statement, index) else { return [] }
        return Array(UnsafeRawBufferPointer(start: pointer, count: count))
    }
}

public final class ChatDB {
    static let required: [String: [String]] = [
        "message": ["ROWID", "guid", "text", "date", "is_from_me", "handle_id"],
        "chat": ["ROWID", "guid", "chat_identifier"],
        "handle": ["ROWID", "id"],
        "chat_message_join": ["chat_id", "message_id"],
        "chat_handle_join": ["chat_id", "handle_id"],
    ]
    static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    let handle: OpaquePointer
    public private(set) var columns: [String: Set<String>] = [:]

    public static func open(path: String) throws -> ChatDB {
        let fd = Darwin.open(path, O_RDONLY)
        if fd < 0 {
            switch errno {
            case ENOENT, ENOTDIR: throw DBError.missing
            case EPERM, EACCES: throw DBError.noAccess
            default: throw DBError.sqlite(SQLITE_CANTOPEN, String(cString: strerror(errno)))
            }
        }
        close(fd)
        let encoded = path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? path
        var pointer: OpaquePointer?
        let rc = sqlite3_open_v2("file:\(encoded)?mode=ro", &pointer, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI | SQLITE_OPEN_NOMUTEX, nil)
        guard rc == SQLITE_OK, let db = pointer else {
            if let pointer { sqlite3_close_v2(pointer) }
            throw rc == SQLITE_CANTOPEN || rc == SQLITE_PERM || rc == SQLITE_AUTH ? DBError.noAccess : DBError.sqlite(rc, "open failed")
        }
        let chat = ChatDB(handle: db)
        sqlite3_busy_timeout(db, 2000)
        try chat.query("PRAGMA query_only = 1", []) { _ in }
        try chat.loadColumns()
        return chat
    }

    init(handle: OpaquePointer) {
        self.handle = handle
    }

    deinit {
        sqlite3_close_v2(handle)
    }

    func loadColumns() throws {
        for table in Self.required.keys {
            var names = Set<String>()
            try query("PRAGMA table_info(\(table))", []) { row in
                if let name = row.text(1) { names.insert(name) }
            }
            columns[table] = names
        }
    }

    public func validateSchema() throws {
        for (table, needed) in Self.required.sorted(by: { $0.key < $1.key }) {
            let have = columns[table] ?? []
            if have.isEmpty { throw DBError.schemaMismatch("table \(table) is missing") }
            for column in needed where column != "ROWID" && !have.contains(column) {
                throw DBError.schemaMismatch("column \(table).\(column) is missing")
            }
        }
    }

    public func has(_ table: String, _ column: String) -> Bool {
        columns[table]?.contains(column) ?? false
    }

    func prepare(_ sql: String) throws -> OpaquePointer {
        var statement: OpaquePointer?
        let rc = sqlite3_prepare_v2(handle, sql, -1, &statement, nil)
        guard rc == SQLITE_OK, let statement else {
            if let statement { sqlite3_finalize(statement) }
            throw error(rc)
        }
        return statement
    }

    func error(_ rc: Int32) -> DBError {
        let message = String(cString: sqlite3_errmsg(handle))
        if rc == SQLITE_BUSY || rc == SQLITE_LOCKED { return .busy }
        if message.contains("no such") { return .schemaMismatch(message) }
        if rc == SQLITE_CANTOPEN || rc == SQLITE_AUTH || rc == SQLITE_PERM { return .noAccess }
        return .sqlite(rc, message)
    }

    public func check(_ sql: String) throws {
        sqlite3_finalize(try prepare(sql))
    }

    public func query(_ sql: String, _ binds: [SQLValue], _ each: (Row) throws -> Void) throws {
        let statement = try prepare(sql)
        defer { sqlite3_finalize(statement) }
        for (offset, value) in binds.enumerated() {
            let index = Int32(offset + 1)
            switch value {
            case .int(let number): sqlite3_bind_int64(statement, index, number)
            case .text(let string): sqlite3_bind_text(statement, index, string, -1, Self.transient)
            }
        }
        while true {
            let rc = sqlite3_step(statement)
            if rc == SQLITE_ROW {
                try each(Row(statement: statement))
                continue
            }
            if rc == SQLITE_DONE { return }
            throw error(rc)
        }
    }
}
