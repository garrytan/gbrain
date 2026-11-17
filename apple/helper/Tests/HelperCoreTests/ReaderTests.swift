import Foundation
import SQLite3
import Testing
@testable import HelperCore

@Suite struct ReaderTests {
    @Test func listsNewestFirstAndMergesServices() throws {
        let fixture = Fixture.standard()
        let result = try reader(fixture).listThreads(limit: 30, includeLastMessage: true)
        #expect(result.data.map(\.threadId) == ["test@example.invalid", "chat900001", "+15550100", "12345"])
        let person = result.data[2]
        #expect(person.chatRowids == [1, 2])
        #expect(person.participants == ["+15550100"])
        #expect(person.participantCount == 2)
        #expect(person.isGroup == false)
        #expect(person.service == "iMessage,SMS")
        #expect(person.lastMessage?.text == "sms msg")
        let group = result.data[1]
        #expect(group.isGroup)
        #expect(group.displayName == "Test Group")
        #expect(group.participantCount == 3)
        #expect(group.lastMessage?.text == "group b")
        #expect(group.lastMessage?.from == "+15550111")
    }

    @Test func keepsTextPastAnEmbeddedNull() throws {
        let fixture = Fixture.standard()
        fixture.exec("UPDATE message SET text = CAST(X'6265666F7265006166746572' AS TEXT) WHERE ROWID = 1")
        let page = try #require(try reader(fixture).getThread(.identifier("+15550100"), sinceRowid: nil, since: nil, limit: 50, includeReactions: false))
        #expect(page.data.messages[0].text == "before\u{0}after")
    }

    @Test func listLimits() throws {
        let fixture = Fixture.standard()
        #expect(try reader(fixture).listThreads(limit: 2, includeLastMessage: false).data.count == 2)
        #expect(try reader(fixture).listThreads(limit: 2, includeLastMessage: false).data[0].lastMessage == nil)
    }

    @Test func getThreadMergesDecodesAndSkipsReactions() throws {
        let fixture = Fixture.standard()
        let page = try #require(try reader(fixture).getThread(.identifier("+15550100"), sinceRowid: nil, since: nil, limit: 50, includeReactions: false))
        #expect(page.data.messages.map(\.text) == ["hi one", "reply", "from body", "sms msg"])
        #expect(page.data.messages.map(\.id) == ["GUID-1", "GUID-2", "GUID-3", "GUID-5"])
        #expect(page.data.messages[1].isFromMe)
        #expect(page.data.messages[1].from == nil)
        #expect(page.data.messages[0].from == "+15550100")
        #expect(page.data.messages[0].fromIdentifier == "+15550100")
        #expect(page.data.messages[1].fromIdentifier == nil)
        #expect(page.data.messages[2].textStatus == "ok")
        #expect(page.data.messages[3].hasAttachments)
        #expect(page.data.messages[0].timestamp == "2026-01-01T00:01:00.000Z")
        #expect(page.data.contact == "+15550100")
        #expect(page.meta.hasMore == false)
        #expect(page.meta.nextSinceRowid == 5)
        let all = try #require(try reader(fixture).getThread(.identifier("+15550100"), sinceRowid: nil, since: nil, limit: 50, includeReactions: true))
        #expect(all.data.messages.count == 5)
    }

    @Test func rowidCursorPagesOldestFirst() throws {
        let fixture = Fixture.standard()
        let first = try #require(try reader(fixture).getThread(.identifier("+15550100"), sinceRowid: 1, since: nil, limit: 2, includeReactions: false))
        #expect(first.data.messages.map(\.rowid) == [2, 3])
        #expect(first.meta.hasMore)
        #expect(first.meta.nextSinceRowid == 3)
        let second = try #require(try reader(fixture).getThread(.identifier("+15550100"), sinceRowid: 3, since: nil, limit: 2, includeReactions: false))
        #expect(second.data.messages.map(\.rowid) == [5])
        #expect(second.meta.hasMore == false)
        let empty = try #require(try reader(fixture).getThread(.identifier("+15550100"), sinceRowid: 5, since: nil, limit: 2, includeReactions: false))
        #expect(empty.data.messages.isEmpty)
        #expect(empty.meta.nextSinceRowid == 5)
    }

    @Test func newestWithoutCursorAndTimeCursor() throws {
        let fixture = Fixture.standard()
        let newest = try #require(try reader(fixture).getThread(.identifier("+15550100"), sinceRowid: nil, since: nil, limit: 2, includeReactions: false))
        #expect(newest.data.messages.map(\.rowid) == [3, 5])
        #expect(newest.meta.hasMore)
        let since = AppleTime.date(fromRaw: minutes(2))
        let page = try #require(try reader(fixture).getThread(.identifier("+15550100"), sinceRowid: nil, since: since, limit: 50, includeReactions: false))
        #expect(page.data.messages.map(\.rowid) == [3, 5])
    }

    @Test func timeCursorPagesInRowOrder() throws {
        let fixture = Fixture.standard()
        let since = AppleTime.date(fromRaw: minutes(2))
        let first = try #require(try reader(fixture).getThread(.identifier("+15550100"), sinceRowid: nil, since: since, limit: 2, includeReactions: true))
        #expect(first.data.messages.map(\.rowid) == [3, 4])
        #expect(first.meta.hasMore)
        #expect(first.meta.nextSinceRowid == 4)
        let second = try #require(try reader(fixture).getThread(.identifier("+15550100"), sinceRowid: 4, since: since, limit: 2, includeReactions: true))
        #expect(second.data.messages.map(\.rowid) == [5])
        #expect(second.meta.hasMore == false)
    }

    @Test func messageInTwoMergedChatsTakesOneSlot() throws {
        let fixture = Fixture.standard()
        fixture.exec("INSERT INTO chat_message_join (chat_id, message_id) VALUES (2, 2)")
        let page = try #require(try reader(fixture).getThread(.identifier("+15550100"), sinceRowid: 1, since: nil, limit: 2, includeReactions: false))
        #expect(page.data.messages.map(\.rowid) == [2, 3])
        #expect(page.meta.hasMore)
    }

    @Test func undecodableEditNeverFallsBackToOldText() {
        let resolved = Reader.resolveText(text: "old words", body: TypedStream.header + [0x84, 0x01, 0x40, 0xFF, 0xFF], edited: true, retracted: false)
        #expect(resolved.text == "")
        #expect(resolved.status == "undecodable")
    }

    @Test func flagsUndecodableEditedAndRetracted() throws {
        let fixture = Fixture.standard()
        let page = try #require(try reader(fixture).getThread(.identifier("test@example.invalid"), sinceRowid: nil, since: nil, limit: 50, includeReactions: false))
        let byRow = Dictionary(uniqueKeysWithValues: page.data.messages.map { ($0.rowid, $0) })
        #expect(byRow[10]?.textStatus == "undecodable")
        #expect(byRow[10]?.text == "")
        #expect(byRow[11]?.text == "new words")
        #expect(byRow[11]?.editedAt == "2026-01-01T00:12:00.000Z")
        #expect(byRow[12]?.retracted == true)
        #expect(byRow[12]?.text == "")
        #expect(byRow[12]?.textStatus == "empty")
        #expect(page.meta.undecodable == 1)
    }

    @Test func selectorsKeepShortCodesApartFromRowids() throws {
        let fixture = Fixture.standard()
        let byIdentifier = try #require(try reader(fixture).getThread(.identifier("12345"), sinceRowid: nil, since: nil, limit: 50, includeReactions: false))
        #expect(byIdentifier.data.messages.map(\.text) == ["code 1234"])
        #expect(byIdentifier.data.messages[0].timestamp == "2025-12-31T23:50:00.000Z")
        #expect(try reader(fixture).getThread(.chatRowid(12345), sinceRowid: nil, since: nil, limit: 50, includeReactions: false) == nil)
        #expect(try reader(fixture).getThread(.chatRowid(4), sinceRowid: nil, since: nil, limit: 50, includeReactions: false)?.data.threadId == "12345")
        #expect(try reader(fixture).getThread(.chatGuid("SMS;-;12345"), sinceRowid: nil, since: nil, limit: 50, includeReactions: false)?.data.threadId == "12345")
        #expect(try reader(fixture).getThread(.identifier("TEST@example.invalid"), sinceRowid: nil, since: nil, limit: 50, includeReactions: false) != nil)
        #expect(try reader(fixture).getThread(.identifier("nobody"), sinceRowid: nil, since: nil, limit: 50, includeReactions: false) == nil)
    }

    @Test func seesRowsStillInTheWriteAheadLog() throws {
        let fixture = Fixture.standard(wal: true)
        fixture.message(13, chat: 3, text: "fresh in wal", date: minutes(20), handle: 3)
        let wal = try FileManager.default.attributesOfItem(atPath: fixture.path + "-wal")[.size] as? Int ?? 0
        #expect(wal > 0)
        let page = try #require(try reader(fixture).getThread(.identifier("chat900001"), sinceRowid: 7, since: nil, limit: 50, includeReactions: false))
        #expect(page.data.messages.map(\.text) == ["fresh in wal"])
    }

    @Test func connectionCannotWrite() throws {
        let fixture = Fixture.standard()
        let db = try ChatDB.open(path: fixture.path)
        #expect(throws: DBError.self) { try db.query("INSERT INTO handle (id) VALUES ('x')", []) { _ in } }
        #expect(throws: DBError.self) { try db.query("PRAGMA query_only = 0", []) { _ in }; try db.query("DELETE FROM message", []) { _ in } }
    }

    @Test func legacySchemaStillWorks() throws {
        let fixture = Fixture(legacy: true)
        fixture.handle(1, "+15550100")
        fixture.chat(1, guid: "iMessage;-;+15550100", identifier: "+15550100", handles: [1])
        fixture.message(1, chat: 1, text: "plain", date: minutes(1), handle: 1)
        let r = try reader(fixture)
        try r.healthCheck()
        #expect(try r.listThreads(limit: 5, includeLastMessage: true).data.first?.lastMessage?.text == "plain")
    }

    @Test func reportsSchemaMismatchMissingAndNoAccess() throws {
        let broken = Fixture(skipTable: "chat_handle_join")
        #expect(throws: DBError.schemaMismatch("table chat_handle_join is missing")) { try ChatDB.open(path: broken.path).validateSchema() }
        #expect(throws: DBError.missing) { try ChatDB.open(path: "/nonexistent/chat.db") }
        let locked = Fixture.standard()
        locked.close()
        chmod(locked.path, 0)
        defer { chmod(locked.path, 0o644) }
        #expect(throws: DBError.noAccess) { try ChatDB.open(path: locked.path) }
    }

    @Test func statsCountOnly() throws {
        let fixture = Fixture.standard()
        let stats = try reader(fixture).stats()
        #expect(stats.threads == 4)
        #expect(stats.threadIdShapes == ["plus_digits": 1, "chat_digits": 1, "short_code": 1, "email": 1])
        #expect(stats.recentMessagesScanned == 10)
        #expect(stats.undecodable == 1)
        #expect(stats.decodedFromBody == 1)
        #expect(stats.edited == 1)
        #expect(stats.editedTextDiffers == 1)
        #expect(stats.retracted == 1)
    }
}
