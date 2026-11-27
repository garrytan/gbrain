import CryptoKit
import Foundation
import Testing
@testable import HelperCore

final class FakeWriteStore: ContactsWriteStore {
    var cards: [String: FullCard] = [:]
    var linked: Set<String> = []
    var groups: Set<String> = ["Friends"]
    var allowed = ContactsAccess.allowed
    var saves: [CardEdit] = []
    var failNext = false
    var saveCount = 0
    var failAtSave: Int? = nil
    var lie = false
    var exports = 0
    var next = 0

    func access() -> ContactsAccess { allowed }

    func card(_ id: String, image: Bool) throws -> WritableCard? {
        cards[id].map { WritableCard(card: $0, writable: !linked.contains(id)) }
    }

    func allCards() throws -> [FullCard] {
        exports += 1
        return cards.values.sorted { $0.id < $1.id }
    }

    func groupExists(_ name: String) throws -> Bool { groups.contains(name) }

    func save(_ edit: CardEdit) throws -> String {
        saveCount += 1
        if saveCount == failAtSave { throw Problem.internalError }
        if failNext { failNext = false; throw Problem.internalError }
        saves.append(edit)
        if lie { return { switch edit { case .create: return "made-x"; case .setField(let id, _, _), .addValue(let id, _, _, _), .removeValue(let id, _, _, _), .addToGroup(let id, _, _), .removeFromGroup(let id, _), .delete(let id): return id } }() }
        switch edit {
        case .create(var card):
            next += 1
            card.id = "made-\(next)"
            for group in card.groups { groups.insert(group) }
            cards[card.id] = card
            return card.id
        case .setField(let id, let field, let value):
            field.set(&cards[id]!, value)
            return id
        case .addValue(let id, let field, let label, let value):
            if field == .emails { cards[id]!.emails.append(Labeled(label: label, value: value)) } else { cards[id]!.phones.append(Labeled(label: label, value: value)) }
            return id
        case .removeValue(let id, let field, let value, let country):
            let key = field.key(value, countryCode: country)
            if field == .emails { cards[id]!.emails.removeAll { $0.value == value || field.key($0.value, countryCode: country) == key } } else {
                cards[id]!.phones.removeAll { $0.value == value || (key != nil && field.key($0.value, countryCode: country) == key) }
            }
            return id
        case .addToGroup(let id, let group, _):
            cards[id]!.groups.append(group)
            return id
        case .removeFromGroup(let id, let group):
            cards[id]!.groups.removeAll { $0 == group }
            return id
        case .delete(let id):
            cards[id] = nil
            return id
        }
    }
}

func card(_ id: String, _ given: String, org: String = "", title: String = "", email: String? = nil, phone: String? = nil, groups: [String] = []) -> FullCard {
    var c = FullCard()
    c.id = id
    c.givenName = given
    c.familyName = "Example"
    c.organization = org
    c.jobTitle = title
    c.emails = email.map { [Labeled(label: "work", value: $0)] } ?? []
    c.phones = phone.map { [Labeled(label: "mobile", value: $0)] } ?? []
    c.groups = groups
    c.postal = [Labeled(label: "home", value: { var p = PostalValue(); p.city = "Springfield-example"; return p }())]
    return c
}

let enrichToken = "synthetic-enrich-token"
let ownerPrivate = Curve25519.Signing.PrivateKey()

final class WriteHarness {
    let directory: URL
    let store = FakeWriteStore()
    var policy = ContactsWritePolicy(enabled: true, ownerKeys: ["owner-box": Array(ownerPrivate.publicKey.rawRepresentation)], limits: .standard)
    var clock = Date()
    lazy var writer = ContactsWriter(store: store, directory: directory.path, policy: { [unowned self] in self.policy }, now: { [unowned self] in self.clock })
    let grants = [TokenGrant(name: "enrich", verifier: Token.verifier(fromHex: Token.hexDigest(enrichToken))!, scopes: [ContactsWriteScope.enrich]),
                  TokenGrant(name: "reader", verifier: Token.verifier(fromHex: Token.hexDigest(contactsToken))!, scopes: ["read:contacts"])]

    init() {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("helper-write-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    deinit { try? FileManager.default.removeItem(at: directory) }

    func body(_ batch: String, by: String, changes: [[String: Any]], instruction: String? = "fix my contacts") -> [UInt8] {
        var object: [String: Any] = ["batch": batch, "requested_by": by, "changes": changes]
        if by == "owner", let instruction { object["owner_instruction"] = instruction }
        return Array(try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]))
    }

    func enrich(_ batch: String, _ changes: [[String: Any]], token: String = enrichToken) -> (Int, [String: Any]) {
        reply(writer.handle(HTTPRequest(method: "POST", path: ContactsWriter.route, query: [:], headers: ["authorization": "Bearer \(token)"],
                                        body: body(batch, by: "enrich", changes: changes)), grants: grants))
    }

    func owner(_ batch: String, _ changes: [[String: Any]], signer: Curve25519.Signing.PrivateKey = ownerPrivate, nonce: String? = nil, skew: Int = 0) -> (Int, [String: Any]) {
        let payload = body(batch, by: "owner", changes: changes)
        let ts = Int(clock.timeIntervalSince1970) + skew
        let n = nonce ?? UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        let message = SendSignature.canonical(timestamp: ts, nonce: n, idempotencyKey: batch, body: payload, route: ContactsWriter.route)
        let sig = Base64URL.encode(Array(try! signer.signature(for: Data(message.utf8))))
        let header = "GBrain-Sign key=owner-box,ts=\(ts),nonce=\(n),sig=\(sig)"
        return reply(writer.handle(HTTPRequest(method: "POST", path: ContactsWriter.route, query: [:], headers: ["authorization": header], body: payload), grants: grants))
    }

    func reply(_ r: SendReply) -> (Int, [String: Any]) {
        switch r {
        case .ok(let response): return (response.status, (try? JSONSerialization.jsonObject(with: Data(response.body))) as? [String: Any] ?? [:])
        case .problem(let p): return (p.status, ["code": p.code])
        }
    }
}

func statuses(_ reply: (Int, [String: Any])) -> [String] {
    ((reply.1["data"] as? [String: Any])?["results"] as? [[String: Any]] ?? []).map { row in
        let status = row["status"] as? String ?? "?"
        return ["quota", "not_run"].contains(status) ? status : status + ((row["reason"] as? String).map { ":" + $0 } ?? "")
    }
}

@Suite struct ContactsWriteTests {
    @Test func fillWritesOnlyAnEmptyFieldAndNeverOverwrites() {
        let h = WriteHarness()
        h.store.cards = ["a": card("a", "alice", title: "Engineer"), "b": card("b", "bob")]
        let r = h.enrich("batch-0001", [["key": "key-k-fill-a-org", "op": "fill", "id": "a", "field": "organization", "value": "Acme Example"],
                                        ["key": "key-k-fill-a-title", "op": "fill", "id": "a", "field": "job_title", "value": "Founder"],
                                        ["key": "key-k-fill-b-title", "op": "fill", "id": "b", "field": "job_title", "value": "Designer"]])
        #expect(r.0 == 200)
        #expect(statuses(r) == ["applied", "skipped:not_empty", "applied"])
        #expect(h.store.cards["a"]!.jobTitle == "Engineer")
        #expect(h.store.cards["a"]!.organization == "Acme Example")
    }

    @Test func addValueNeverDuplicatesACanonicalEqualPhone() {
        let h = WriteHarness()
        h.store.cards = ["a": card("a", "alice", phone: "(555) 010-0100")]
        let r = h.enrich("batch-0002", [["key": "key-k-add-1", "op": "add_value", "id": "a", "field": "phones", "value": "+1 555 010 0100"],
                                        ["key": "key-k-add-2", "op": "add_value", "id": "a", "field": "emails", "value": "alice@example.invalid", "label": "work"]])
        #expect(statuses(r) == ["skipped:already_present", "applied"])
        #expect(h.store.cards["a"]!.phones.count == 1)
    }

    @Test func theEnrichTokenCannotDeleteMergeOrOverwrite() {
        let h = WriteHarness()
        h.store.cards = ["a": card("a", "alice", org: "Acme Example")]
        for op in ["delete", "merge", "set", "remove_value", "group_remove"] {
            let r = h.enrich("batch-enrich-\(op)", [["key": "key-k-\(op)-x", "op": op, "id": "a", "field": "organization", "value": "x"]])
            #expect(r.0 == 403 && r.1["code"] as? String == "insufficient_scope", "\(op)")
        }
        #expect(h.store.saves.isEmpty)
        #expect(h.enrich("batch-0003", [["key": "key-k-x-1", "op": "fill", "id": "a", "field": "job_title", "value": "x"]], token: contactsToken).0 == 403)
        #expect(h.enrich("batch-0004", [["key": "key-k-x-1", "op": "fill", "id": "a", "field": "job_title", "value": "x"]], token: "wrong").0 == 401)
    }

    @Test func ownerRequestsMustBeSignedFreshAndOnce() {
        let h = WriteHarness()
        h.store.cards = ["a": card("a", "alice", org: "Old Example")]
        let change: [[String: Any]] = [["key": "key-k-set-a-org", "op": "set", "id": "a", "field": "organization", "value": "New Example", "expect": ["organization": "Old Example"]]]
        #expect(h.owner("batch-sig-1", change, signer: Curve25519.Signing.PrivateKey()).0 == 401)
        #expect(h.owner("batch-sig-2", change, skew: 120).0 == 401)
        let nonce = String(repeating: "ab", count: 16)
        #expect(statuses(h.owner("batch-sig-3", change, nonce: nonce)) == ["applied"])
        #expect(h.owner("batch-sig-4", change, nonce: nonce).0 == 401)
        #expect(h.store.cards["a"]!.organization == "New Example")
        var noWords = h.body("batch-sig-5", by: "owner", changes: change, instruction: nil)
        noWords = Array(noWords)
        #expect(h.reply(h.writer.handle(HTTPRequest(method: "POST", path: ContactsWriter.route, query: [:], headers: ["authorization": "Bearer \(enrichToken)"], body: noWords),
                                        grants: h.grants)).0 == 401)
    }

    @Test func setAndDeleteRefuseACardThatChangedSinceTheBoxReadIt() {
        let h = WriteHarness()
        h.store.cards = ["a": card("a", "alice", org: "Acme Example", email: "alice@example.invalid")]
        let r = h.owner("batch-0005", [["key": "key-k-set-1", "op": "set", "id": "a", "field": "organization", "value": "x", "expect": ["organization": "Other"]],
                                       ["key": "key-k-del-1", "op": "delete", "id": "a", "expect": ["emails": ["bob@example.invalid"]]],
                                       ["key": "key-k-del-2", "op": "delete", "id": "a"]])
        #expect(statuses(r) == ["skipped:card_changed", "skipped:card_changed", "skipped:card_changed"])
        #expect(h.store.cards["a"] != nil)
    }

    @Test func deleteKeepsTheWholeCardAndRestorePutsItBack() throws {
        let h = WriteHarness()
        h.store.cards = ["a": card("a", "alice", org: "Acme Example", email: "Alice@Example.invalid", groups: ["Friends"])]
        let r = h.owner("batch-del-1", [["key": "key-k-del-a", "op": "delete", "id": "a", "expect": ["given_name": "alice", "emails": ["alice@example.invalid"]]]])
        #expect(statuses(r) == ["applied"])
        #expect(h.store.cards["a"] == nil)
        let saved = h.writer.journalRows().first { $0.op == "delete" && $0.phase == "done" }?.before
        #expect(saved?.postal.first?.value.city == "Springfield-example")
        let dry = try h.writer.restore(batch: "batch-del-1", dryRun: true)
        #expect(dry.steps.map(\.status) == ["would_undo"])
        #expect(h.store.cards.isEmpty)
        let done = try h.writer.restore(batch: "batch-del-1", dryRun: false)
        #expect(done.steps.map(\.status) == ["undone"])
        let back = h.store.cards.values.first!
        #expect(back.givenName == "alice" && back.postal.first?.value.city == "Springfield-example" && back.groups == ["Friends"])
    }

    @Test func restoreUndoesOnlyValuesThatAreStillUnchanged() throws {
        let h = WriteHarness()
        h.store.cards = ["a": card("a", "alice"), "b": card("b", "bob")]
        _ = h.enrich("batch-fill-1", [["key": "key-k-f-a", "op": "fill", "id": "a", "field": "organization", "value": "Acme Example"],
                                      ["key": "key-k-f-b", "op": "fill", "id": "b", "field": "organization", "value": "Beta Example"],
                                      ["key": "key-k-e-b", "op": "add_value", "id": "b", "field": "emails", "value": "bob@example.invalid"]])
        h.store.cards["b"]!.organization = "Typed By Owner"
        let done = try h.writer.restore(batch: "batch-fill-1", dryRun: false)
        #expect(done.steps.map(\.status) == ["undone", "skipped", "undone"])
        #expect(h.store.cards["a"]!.organization == "")
        #expect(h.store.cards["b"]!.organization == "Typed By Owner")
        #expect(h.store.cards["b"]!.emails.isEmpty)
    }

    @Test func createRefusesADuplicateAndEnrichCardsGoInTheGBrainGroup() {
        let h = WriteHarness()
        h.store.cards = ["a": card("a", "alice", phone: "555-010-0100")]
        let r = h.enrich("batch-0006", [["key": "key-k-c-1", "op": "create", "fields": ["given_name": "Al", "phones": [["label": "mobile", "value": "+1 (555) 010-0100"]]]],
                                        ["key": "key-k-c-2", "op": "create", "fields": ["given_name": "Carol"]],
                                        ["key": "key-k-c-3", "op": "create", "fields": ["given_name": "Carol", "emails": [["label": "work", "value": "carol@example.invalid"]]]]])
        #expect(statuses(r) == ["skipped:create_duplicate", "skipped:bad_change: a new card needs an email or a phone", "applied"])
        #expect(h.store.cards.values.first { $0.givenName == "Carol" }?.groups == [ContactsWriter.addedGroup])
    }

    @Test func aRetriedBatchNeverMakesASecondCard() {
        let h = WriteHarness()
        let change: [[String: Any]] = [["key": "key-k-c-dave", "op": "create", "fields": ["given_name": "Dave", "emails": [["value": "dave@example.invalid"]]]]]
        #expect(statuses(h.enrich("batch-0007", change)) == ["applied"])
        #expect(statuses(h.enrich("batch-0007b", change)) == ["replayed"])
        #expect(h.store.cards.count == 1)
    }

    @Test func aCrashBetweenSaveAndJournalIsReconciledOnRetry() throws {
        let h = WriteHarness()
        h.store.cards = ["a": card("a", "alice")]
        let change: [[String: Any]] = [["key": "key-k-crash-1", "op": "fill", "id": "a", "field": "job_title", "value": "Founder"]]
        try FileManager.default.createDirectory(atPath: h.writer.journalDir, withIntermediateDirectories: true)
        try h.writer.append(JournalRow(batch: "batch-crash", key: "key-k-crash-1", op: "fill", phase: "intent", id: "a", field: "job_title", value: "Founder",
                                       label: nil, group: nil, prior: "", before: nil, reason: nil, requestedBy: "enrich", instruction: nil, at: "x"),
                            to: h.writer.journalDir + "/batch-crash.jsonl")
        h.store.cards["a"]!.jobTitle = "Founder"
        #expect(statuses(h.enrich("batch-crash-2", change)) == ["replayed"])
        #expect(h.store.saves.isEmpty)
    }

    @Test func linkedCardsAreNeverWritten() {
        let h = WriteHarness()
        h.store.cards = ["a": card("a", "alice")]
        h.store.linked = ["a"]
        #expect(statuses(h.enrich("batch-0008", [["key": "key-k-l-1", "op": "fill", "id": "a", "field": "organization", "value": "x"]])) == ["skipped:card_linked"])
        #expect(statuses(h.owner("batch-0009", [["key": "key-k-l-2", "op": "delete", "id": "a", "expect": ["given_name": "alice"]]])) == ["skipped:card_linked"])
        #expect(h.store.saves.isEmpty)
    }

    @Test func dailyLimitsHoldAcrossBatchesAndResetTheNextDay() {
        let h = WriteHarness()
        h.policy = ContactsWritePolicy(enabled: true, ownerKeys: h.policy.ownerKeys, limits: ContactsWriteLimits(newCards: 2, deletes: 1, edits: 200))
        func make(_ n: Int) -> [String: Any] { ["key": "key-k-new-\(n)-x", "op": "create", "fields": ["given_name": "P\(n)", "emails": [["value": "p\(n)@example.invalid"]]]] }
        #expect(statuses(h.enrich("batch-q-1", [make(1)])) == ["applied"])
        #expect(statuses(h.enrich("batch-q-2", [make(2), make(3), make(4)])) == ["applied", "quota", "not_run"])
        let stopped = h.enrich("batch-q-3", [make(5)])
        #expect((stopped.1["data"] as? [String: Any])?["stopped"] as? String == "quota")
        h.clock = h.clock.addingTimeInterval(86400)
        #expect(statuses(h.enrich("batch-q-4", [make(6)])) == ["applied"])
        h.store.cards["z1"] = card("z1", "zed")
        h.store.cards["z2"] = card("z2", "zoe")
        #expect(statuses(h.owner("batch-q-5", [["key": "key-k-dz-1", "op": "delete", "id": "z1", "expect": ["given_name": "zed"]],
                                               ["key": "key-k-dz-2", "op": "delete", "id": "z2", "expect": ["given_name": "zoe"]]])) == ["applied", "quota"])
    }

    @Test func aReadBackMismatchOrASaveErrorStopsTheBatch() {
        let h = WriteHarness()
        h.store.cards = ["a": card("a", "alice"), "b": card("b", "bob")]
        h.store.lie = true
        let r = h.enrich("batch-0010", [["key": "key-k-rb-1", "op": "fill", "id": "a", "field": "organization", "value": "x"],
                                        ["key": "key-k-rb-2", "op": "fill", "id": "b", "field": "organization", "value": "y"]])
        #expect(statuses(r) == ["failed:readback_mismatch", "not_run"])
        #expect((r.1["data"] as? [String: Any])?["side_effects"] as? String == "none")
        h.store.lie = false
        h.store.failNext = true
        #expect(statuses(h.enrich("batch-0011", [["key": "key-k-rb-3", "op": "fill", "id": "b", "field": "organization", "value": "y"]])) == ["failed:save_failed"])
    }

    @Test func mergeCopiesTheOtherCardThenDeletesItAndCanBeUndone() throws {
        let h = WriteHarness()
        h.store.cards = ["a": card("a", "alice", org: "Acme Example", email: "alice@example.invalid"),
                         "b": card("b", "alice", org: "Other Example", title: "CEO", phone: "555-010-0199", groups: ["Friends"])]
        let r = h.owner("batch-merge-1", [["key": "key-k-merge-ab", "op": "merge", "id": "a", "from": "b"]])
        #expect(statuses(r) == ["applied:kept this card's organization"])
        let a = h.store.cards["a"]!
        #expect(h.store.cards["b"] == nil && a.jobTitle == "CEO" && a.phones.count == 1 && a.groups == ["Friends"] && a.organization == "Acme Example")
        _ = try h.writer.restore(batch: "batch-merge-1", dryRun: false)
        #expect(h.store.cards.count == 2)
        #expect(h.store.cards["a"]!.jobTitle == "" && h.store.cards["a"]!.phones.isEmpty)
    }

    @Test func aMergeRetriedAfterAFailedCopyStillCopiesEverythingBeforeTheDelete() throws {
        let h = WriteHarness()
        h.store.cards = ["a": card("a", "alice"), "b": card("b", "alice", title: "CEO", phone: "555-010-0199")]
        h.store.failAtSave = 2
        #expect(statuses(h.owner("batch-merge-2", [["key": "key-k-merge-retry", "op": "merge", "id": "a", "from": "b"]])) == ["failed:save_failed"])
        #expect(h.store.cards["b"] != nil && h.store.cards["a"]!.jobTitle == "CEO" && h.store.cards["a"]!.phones.isEmpty)
        #expect(statuses(h.owner("batch-merge-3", [["key": "key-k-merge-retry", "op": "merge", "id": "a", "from": "b"]])) == ["applied"])
        #expect(h.store.cards["b"] == nil && h.store.cards["a"]!.phones.count == 1)
    }

    @Test func aMergeRefusesWhenTheOtherCardHoldsFieldsItCannotCarry() throws {
        let h = WriteHarness()
        var b = card("b", "alice", phone: "555-010-0199")
        b.postal = [Labeled(label: "home", value: PostalValue())]
        b.postal[0].value.city = "Example City"
        b.urls = [Labeled(label: "home", value: "https://example.invalid")]
        h.store.cards = ["a": card("a", "alice"), "b": b]
        let before = h.store.cards
        let r = statuses(h.owner("batch-merge-4", [["key": "key-k-merge-lossy", "op": "merge", "id": "a", "from": "b"]]))
        #expect(r.count == 1 && r[0].hasPrefix("skipped:bad_change: merge can't carry the other card's urls, postal_addresses"))
        #expect(h.store.cards == before)
    }

    @Test func removeValueJournalsEveryMatchSoRestorePutsThemAllBack() throws {
        let h = WriteHarness()
        var a = card("a", "alice")
        a.phones = [Labeled(label: "mobile", value: "555-010-0100"), Labeled(label: "work", value: "+1 (555) 010-0100"), Labeled(label: "home", value: "555-010-0177")]
        h.store.cards = ["a": a]
        #expect(statuses(h.owner("batch-rv-1", [["key": "key-k-rv-a", "op": "remove_value", "id": "a", "field": "phones", "value": "+15550100100"]])) == ["applied"])
        #expect(h.store.cards["a"]!.phones.map(\.value) == ["555-010-0177"])
        let saved = h.writer.journalRows().first { $0.op == "remove_value" && $0.phase == "done" }?.removed
        #expect(saved?.map(\.label) == ["mobile", "work"])
        let done = try h.writer.restore(batch: "batch-rv-1", dryRun: false)
        #expect(done.steps.map(\.status) == ["undone"])
        #expect(Set(h.store.cards["a"]!.phones.map { $0.label + "=" + $0.value }) == ["home=555-010-0177", "mobile=555-010-0100", "work=+1 (555) 010-0100"])
    }

    @Test func aMergeRefusesWhenTheOtherCardHasANonGregorianBirthday() throws {
        let h = WriteHarness()
        var b = card("b", "alice", phone: "555-010-0199")
        b.nonGregorianBirthday = DateValue(month: 4, day: 5, calendar: "chinese", leapMonth: true)
        h.store.cards = ["a": card("a", "alice"), "b": b]
        let before = h.store.cards
        let r = statuses(h.owner("batch-merge-5", [["key": "key-k-merge-ngb", "op": "merge", "id": "a", "from": "b"]]))
        #expect(r.count == 1 && r[0].hasPrefix("skipped:bad_change: merge can't carry the other card's non_gregorian_birthday"))
        #expect(h.store.cards == before)
    }

    @Test func aNonGregorianDateKeepsItsCalendarAndLeapMonth() throws {
        var c = DateComponents()
        c.calendar = Calendar(identifier: .chinese)
        c.month = 4
        c.day = 5
        c.isLeapMonth = true
        let value = try #require(SystemContactsStore.date(c))
        #expect(value.calendar == "chinese" && value.leapMonth == true && value.month == 4 && value.day == 5)
        let back = SystemContactsStore.components(try JSONDecoder().decode(DateValue.self, from: JSONEncoder().encode(value)))
        #expect(back.calendar?.identifier == .chinese && back.isLeapMonth == true && back.month == 4 && back.day == 5)
        var g = DateComponents()
        g.calendar = Calendar(identifier: .gregorian)
        g.month = 1
        g.day = 2
        #expect(SystemContactsStore.date(g) == DateValue(month: 1, day: 2))
        #expect(try JSONDecoder().decode(DateValue.self, from: Data(#"{"month":1,"day":2}"#.utf8)) == DateValue(month: 1, day: 2))
    }

    @Test func additiveEditsCountAgainstTheDailyEditLimit() {
        let h = WriteHarness()
        h.policy = ContactsWritePolicy(enabled: true, ownerKeys: h.policy.ownerKeys, limits: ContactsWriteLimits(newCards: 50, deletes: 25, edits: 1))
        h.store.cards = ["a": card("a", "alice"), "b": card("b", "bob")]
        #expect(statuses(h.enrich("batch-qe-1", [["key": "key-k-qe-1", "op": "fill", "id": "a", "field": "job_title", "value": "x"],
                                                  ["key": "key-k-qe-2", "op": "fill", "id": "b", "field": "job_title", "value": "y"]])) == ["applied", "quota"])
        #expect(h.store.cards["b"]!.jobTitle == "")
    }

    @Test func theKillSwitchAndTheDailyExportComeFirst() throws {
        let h = WriteHarness()
        h.store.cards = ["a": card("a", "alice")]
        h.policy = ContactsWritePolicy(enabled: false, ownerKeys: [:], limits: .standard)
        #expect(h.enrich("batch-0012", [["key": "key-k-ks-1", "op": "fill", "id": "a", "field": "organization", "value": "x"]]).1["code"] as? String == "contacts_write_off")
        #expect(h.store.exports == 0)
        h.policy = ContactsWritePolicy(enabled: true, ownerKeys: [:], limits: .standard)
        _ = h.enrich("batch-0013", [["key": "key-k-ks-2", "op": "fill", "id": "a", "field": "organization", "value": "x"]])
        _ = h.enrich("batch-0014", [["key": "key-k-ks-3", "op": "fill", "id": "a", "field": "job_title", "value": "y"]])
        #expect(h.store.exports == 1)
        let files = try FileManager.default.contentsOfDirectory(atPath: h.writer.backupDir)
        try #require(files.count == 1)
        #expect(files[0].hasPrefix("full-"))
        let mode = try FileManager.default.attributesOfItem(atPath: h.writer.backupDir + "/" + files[0])[.posixPermissions] as? Int
        #expect(mode == 0o600)
    }

    @Test func theWriteRouteIsServedOnlyWithItsScopeOnBothListeners() {
        let h = WriteHarness()
        h.store.cards = ["a": card("a", "alice")]
        let body = h.body("batch-route-1", by: "enrich", changes: [["key": "key-k-r-1", "op": "fill", "id": "a", "field": "organization", "value": "x"]])
        let settings = RouterSettings(listener: .tailnet(allowed: [tailnetPeer]), liveGrants: { h.grants }, liveEnabled: { ["contacts"] }, sources: [], version: "test",
                                      writer: h.writer)
        let router = Router(settings: settings, localAddresses: { [macTailnet] })
        func post(_ auth: String, origin: String? = nil, method: String = "POST", peer: UInt32 = tailnetPeer) -> Int {
            var headers = ["authorization": auth, "host": tailnetHost]
            if let origin { headers["origin"] = origin }
            return router.handle(HTTPRequest(method: method, path: ContactsWriter.route, query: [:], headers: headers, body: body), peer: peer, port: 8792, requestId: "r").response.status
        }
        #expect(post("Bearer \(contactsToken)") == 403)
        #expect(post("Bearer \(enrichToken)", origin: "https://attacker.example") == 403)
        #expect(post("Bearer \(enrichToken)", method: "GET") == 405)
        #expect(post("Bearer \(enrichToken)", peer: strangerPeer) == 403)
        #expect(post("Bearer \(enrichToken)") == 200)
        #expect(router.bodyLimit(path: ContactsWriter.route) == ContactsWriter.bodyLimit)
        let admin = router.handle(HTTPRequest(method: "POST", path: ContactsWriter.adminRoute, query: [:], headers: ["host": tailnetHost], body: Array("{\"action\":\"restore\",\"batch\":\"batch-route-1\"}".utf8)),
                                  peer: tailnetPeer, port: 8792, requestId: "r")
        #expect(admin.response.status == 404)
    }

    @Test func swiftPhoneKeysMatchGbrainsGoldenTable() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("test/fixtures/phone-canonical-golden.json"))
        let rows = try JSONSerialization.jsonObject(with: data) as! [[String: Any]]
        #expect(rows.count > 10)
        for row in rows {
            let input = row["input"] as! String, country = row["country"] as! String
            #expect(PhoneKey.canonical(input, countryCode: country) == row["canonical"] as? String, "\(input)")
        }
    }
}
