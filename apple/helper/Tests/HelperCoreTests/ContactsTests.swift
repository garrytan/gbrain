import Contacts
import Foundation
import Testing
@testable import HelperCore

let contactsToken = "synthetic-contacts-token"
let tailnetHost = "100.100.0.1:8792"

final class FakeContactsStore: ContactsStore {
    var current: ContactsAccess = .allowed
    var afterRequest: ContactsAccess = .allowed
    var records: [ContactRecord] = []
    var requests = 0
    var snapshots = 0

    func access() -> ContactsAccess { current }

    func requestAccess(timeout: TimeInterval) -> ContactsAccess {
        requests += 1
        current = afterRequest
        return current
    }

    func snapshot() throws -> [ContactRecord] {
        snapshots += 1
        return records
    }
}

func person(_ id: String, _ given: String, email: String? = nil, phone: String? = nil, title: String = "", groups: [String] = []) -> ContactRecord {
    ContactRecord(id: id, fields: ContactFields(givenName: given, familyName: "Example", organization: "Acme Example", jobTitle: title,
                                                emails: email.map { [LabeledValue(label: "work", value: $0)] } ?? [],
                                                phones: phone.map { [LabeledValue(label: "mobile", value: $0)] } ?? [], groups: groups))
}

struct Page {
    let status: Int
    let code: String?
    let body: [String: Any]

    var items: [[String: Any]] { body["data"] as? [[String: Any]] ?? [] }
    var meta: [String: Any] { body["meta"] as? [String: Any] ?? [:] }
    var ids: [String] { items.compactMap { $0["id"] as? String } }
    var ops: [String] { items.map { "\($0["op"] as? String ?? "?") \($0["id"] as? String ?? "?")" } }
    var cursor: String? { meta["next_cursor"] as? String }
    var more: Bool? { meta["more"] as? Bool }
    var full: Bool? { meta["full"] as? Bool }

    func contact(_ id: String) -> [String: Any]? {
        items.first { $0["id"] as? String == id }?["contact"] as? [String: Any]
    }
}

final class ContactsHarness {
    let directory: URL
    let store = FakeContactsStore()
    let source: ContactsSource
    var enabled: Set<String> = ["contacts"]

    init() {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("helper-contacts-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        source = ContactsSource(store: store, indexPath: directory.appendingPathComponent(ContactsSource.indexFile).path)
    }

    deinit {
        try? FileManager.default.removeItem(at: directory)
    }

    var indexPath: String { directory.appendingPathComponent(ContactsSource.indexFile).path }

    func router(_ listener: Listener = .loopback) -> Router {
        let all = grants() + [TokenGrant(name: "box", verifier: Token.verifier(fromHex: Token.hexDigest(contactsToken))!, scopes: [SourceCatalog.readScope("contacts")])]
        let settings = RouterSettings(listener: listener, liveGrants: { all }, liveEnabled: { [unowned self] in self.enabled },
                                      sources: [IMessageSource(dbPath: "/nonexistent/chat.db"), source], version: "test")
        return Router(settings: settings, localAddresses: { [macTailnet] })
    }

    func get(_ cursor: String? = nil, limit: Int? = nil) -> Page {
        var query: [String] = []
        if let cursor { query.append("cursor=\(cursor)") }
        if let limit { query.append("limit=\(limit)") }
        let target = ContactsSource.route + (query.isEmpty ? "" : "?" + query.joined(separator: "&"))
        return page(send(router(), request(target, auth: "Bearer \(contactsToken)")))
    }

    func page(_ routed: Routed) -> Page {
        Page(status: routed.response.status, code: code(routed), body: json(routed))
    }

    func admin(_ body: String, peer: UInt32 = loopbackPeer, method: String = "POST", headers: [String: String] = ["host": goodHost]) -> Routed {
        router().handle(HTTPRequest(method: method, path: ContactsSource.adminRoute, query: [:], headers: headers, body: Array(body.utf8)),
                        peer: peer, port: testPort, requestId: "t")
    }
}

@Suite struct ContactsChangesTests {
    @Test func fullSnapshotPagesInIdentifierOrder() {
        let h = ContactsHarness()
        h.store.records = ["e", "c", "a", "d", "b"].map { person("id-\($0)", "alice-\($0)") }
        let first = h.get(limit: 2)
        #expect(first.status == 200)
        #expect(first.ops == ["upsert id-a", "upsert id-b"])
        #expect(first.more == true)
        #expect(first.full == false)
        let second = h.get(first.cursor, limit: 2)
        #expect(second.ids == ["id-c", "id-d"])
        #expect(second.more == true)
        #expect(second.full == false)
        let third = h.get(second.cursor, limit: 2)
        #expect(third.ids == ["id-e"])
        #expect(third.more == false)
        #expect(third.full == true)
        let again = h.get(first.cursor, limit: 2)
        #expect(again.ids == ["id-c", "id-d"])
    }

    @Test func defaultLimitIs200() {
        let h = ContactsHarness()
        h.store.records = (0..<250).map { person(String(format: "id-%03d", $0), "alice-\($0)") }
        let first = h.get()
        #expect(first.items.count == 200)
        #expect(first.more == true)
        let second = h.get(first.cursor)
        #expect(second.items.count == 50)
        #expect(second.ids.first == "id-200")
        #expect(second.full == true)
    }

    @Test func emptyContactsGiveOneFullPage() {
        let h = ContactsHarness()
        let only = h.get()
        #expect(only.status == 200)
        #expect(only.items.isEmpty)
        #expect(only.more == false)
        #expect(only.full == true)
        #expect(h.get(only.cursor).items.isEmpty)
    }

    @Test func changesCarryOnlyAddsEditsDeletesAndGroupChanges() {
        let h = ContactsHarness()
        h.store.records = [person("id-a", "alice", email: "alice@example.invalid", phone: "+1 555 0100"), person("id-b", "bob", phone: "+1 555 0101"),
                           person("id-c", "carol"), person("id-d", "dave", groups: ["Friends"]), person("id-e", "erin")]
        let snapshot = h.get()
        #expect(snapshot.ids.count == 5)
        let idle = h.get(snapshot.cursor)
        #expect(idle.status == 200)
        #expect(idle.items.isEmpty)
        #expect(idle.more == false)
        #expect(idle.full == false)
        h.store.records = [person("id-a", "alice", email: "alice@example.invalid", phone: "+1 555 0100"), person("id-b", "bob", phone: "+1 555 0199"),
                           person("id-d", "dave", groups: ["Friends", "Work"]), person("id-e", "erin"), person("id-f", "frank")]
        let changes = h.get(idle.cursor)
        #expect(changes.ops == ["upsert id-b", "delete id-c", "upsert id-d", "upsert id-f"])
        #expect((changes.contact("id-b")?["phones"] as? [[String: String]])?.first?["value"] == "+1 555 0199")
        #expect(changes.contact("id-d")?["groups"] as? [String] == ["Friends", "Work"])
        #expect(changes.full == false)
        #expect(changes.more == false)
        #expect(h.get(changes.cursor).items.isEmpty)
    }

    @Test func aTitleChangeIsOneUpsertOfTheSameId() {
        let h = ContactsHarness()
        h.store.records = [person("id-a", "alice", title: "Engineer")]
        let snapshot = h.get()
        h.store.records = [person("id-a", "alice", title: "Manager")]
        let changes = h.get(snapshot.cursor)
        #expect(changes.ops == ["upsert id-a"])
        #expect(changes.contact("id-a")?["job_title"] as? String == "Manager")
    }

    @Test func pendingChangesCommitOnlyWhenTheirCursorComesBack() {
        let h = ContactsHarness()
        h.store.records = [person("id-a", "alice"), person("id-b", "bob")]
        let snapshot = h.get()
        h.store.records = [person("id-a", "alice"), person("id-b", "bob", phone: "+1 555 0102")]
        let page = h.get(snapshot.cursor)
        #expect(page.ops == ["upsert id-b"])
        let resent = h.get(snapshot.cursor)
        #expect(resent.ops == ["upsert id-b"])
        let applied = h.get(resent.cursor)
        #expect(applied.items.isEmpty)
        #expect(h.get(applied.cursor).items.isEmpty)
    }

    @Test func aRetriedCursorStillDeletesAContactFromTheUnsavedPage() {
        let h = ContactsHarness()
        h.store.records = [person("id-a", "alice")]
        let snapshot = h.get()
        let start = h.get(snapshot.cursor)
        #expect(start.items.isEmpty)
        h.store.records = [person("id-a", "alice"), person("id-b", "bob")]
        #expect(h.get(start.cursor).ops == ["upsert id-b"])
        h.store.records = [person("id-a", "alice")]
        #expect(h.get(start.cursor).ops == ["delete id-b"])
        let retried = h.get(start.cursor)
        #expect(retried.ops == ["delete id-b"])
        #expect(h.get(retried.cursor).items.isEmpty)
    }

    @Test func aRetriedCursorResendsAContactRestoredAfterAnUnsavedDelete() {
        let h = ContactsHarness()
        h.store.records = [person("id-a", "alice"), person("id-b", "bob")]
        let snapshot = h.get()
        let start = h.get(snapshot.cursor)
        #expect(start.items.isEmpty)
        h.store.records = [person("id-a", "alice")]
        #expect(h.get(start.cursor).ops == ["delete id-b"])
        h.store.records = [person("id-a", "alice"), person("id-b", "bob")]
        let retried = h.get(start.cursor)
        #expect(retried.ops == ["upsert id-b"])
        #expect(h.get(retried.cursor).items.isEmpty)
    }

    @Test func anUnappliedSnapshotPageIsNeverCountedAsSent() {
        let h = ContactsHarness()
        h.store.records = [person("id-a", "alice"), person("id-b", "bob")]
        let first = h.get(limit: 1)
        _ = h.get(first.cursor, limit: 1)
        let changes = h.get(first.cursor, limit: 1)
        #expect(changes.ids == ["id-b"])
        #expect(h.get(changes.cursor).items.isEmpty)
    }

    @Test func changePagesHonourTheLimit() {
        let h = ContactsHarness()
        h.store.records = ["a", "b", "c", "d"].map { person("id-\($0)", "alice-\($0)") }
        let snapshot = h.get()
        h.store.records = [person("id-a", "alice-a2"), person("id-c", "alice-c2"), person("id-d", "alice-d")]
        let first = h.get(snapshot.cursor, limit: 2)
        #expect(first.ops == ["upsert id-a", "delete id-b"])
        #expect(first.more == true)
        #expect(first.full == false)
        let second = h.get(first.cursor, limit: 2)
        #expect(second.ops == ["upsert id-c"])
        #expect(second.more == false)
        #expect(h.get(second.cursor, limit: 2).items.isEmpty)
    }

    @Test func aCursorFromAnotherSnapshotIsExpired() throws {
        let h = ContactsHarness()
        h.store.records = [person("id-a", "alice")]
        let old = h.get()
        let fresh = h.get()
        let expired = h.get(old.cursor)
        #expect(expired.status == 410)
        #expect(expired.code == "cursor_expired")
        #expect(HTTPResponse.problem(.cursorExpired, requestId: "t").serialize(requestId: "t").starts(with: Array("HTTP/1.1 410 Gone".utf8)))
        #expect(h.get(fresh.cursor).status == 200)
        try Data("not json".utf8).write(to: URL(fileURLWithPath: h.indexPath))
        #expect(h.get(fresh.cursor).code == "cursor_expired")
        try FileManager.default.removeItem(atPath: h.indexPath)
        #expect(h.get(fresh.cursor).code == "cursor_expired")
    }

    @Test func malformedCursorsAndLimitsAreBadParams() {
        let h = ContactsHarness()
        h.store.records = [person("id-a", "alice")]
        let encode = { (text: String) in Base64URL.encode(Array(text.utf8)) }
        let cursors = ["not-base64!", "", encode("{}"), encode("[]"), encode(#"{"g":"x","k":"y","m":"full","p":""#),
                       encode(#"{"g":"x","k":"y","m":"full","p":"","z":1}"#), encode(#"{"g":"x","k":"y","m":"later","p":""}"#),
                       encode(#"{"g":1,"k":"y","m":"full","p":""}"#), encode(#"{"g":"","k":"y","m":"full","p":""}"#),
                       String(repeating: "A", count: 3000)]
        for cursor in cursors {
            let page = h.get(cursor)
            #expect(page.status == 400, "\(cursor)")
            #expect(page.code == "bad_param")
        }
        for limit in ["0", "501", "-1", "abc", "2.5"] {
            let routed = send(h.router(), request(ContactsSource.route + "?limit=\(limit)", auth: "Bearer \(contactsToken)"))
            #expect(routed.response.status == 400, "\(limit)")
        }
        #expect(h.get(limit: 500).status == 200)
        #expect(h.get(limit: 1).status == 200)
    }

    @Test func noGrantMeansNoReadAndNoDialog() {
        for access in [ContactsAccess.notDetermined, .denied, .restricted] {
            let h = ContactsHarness()
            h.store.current = access
            h.store.records = [person("id-a", "alice")]
            let page = h.get()
            #expect(page.status == 403)
            #expect(page.code == "contacts_not_allowed")
            #expect((page.body["fix"] as? String)?.contains("contacts-setup") == true)
            #expect(h.store.snapshots == 0)
            #expect(h.store.requests == 0)
            let listed = sources(send(h.router(), request("/v1/sources"))).first { $0["id"] as? String == "contacts" }
            #expect(listed?["state"] as? String == access.rawValue)
            #expect(h.store.requests == 0)
        }
    }

    @Test func itemsCarryOnlyTheAgreedFields() {
        let h = ContactsHarness()
        h.store.records = [ContactRecord(id: "id-a", fields: ContactFields(givenName: "alice", familyName: "Example", nickname: "al", organization: "Acme Example",
                                                                           jobTitle: "Engineer", emails: [LabeledValue(label: "home", value: "alice@example.invalid")],
                                                                           phones: [LabeledValue(label: "", value: "+1 555 0100")], groups: ["Friends"])),
                           person("id-b", "bob")]
        let snapshot = h.get()
        #expect(snapshot.meta.keys.sorted() == ["full", "more", "next_cursor"])
        #expect(snapshot.body.keys.sorted() == ["data", "meta"])
        #expect(snapshot.items.first?.keys.sorted() == ["contact", "id", "op"])
        let contact = snapshot.contact("id-a") ?? [:]
        #expect(contact.keys.sorted() == ["emails", "family_name", "given_name", "groups", "job_title", "nickname", "organization", "phones"])
        #expect(contact["emails"] as? [[String: String]] == [["label": "home", "value": "alice@example.invalid"]])
        #expect(contact["phones"] as? [[String: String]] == [["label": "", "value": "+1 555 0100"]])
        #expect(contact["nickname"] as? String == "al")
        h.store.records = [h.store.records[0]]
        let changes = h.get(snapshot.cursor)
        #expect(changes.items.first?.keys.sorted() == ["id", "op"])
        #expect(changes.ops == ["delete id-b"])
    }

    @Test func theIndexHoldsHashesOnly() throws {
        let h = ContactsHarness()
        h.store.records = [person("id-a", "alice", email: "alice@example.invalid", phone: "+1 555 0100", title: "Engineer", groups: ["Friends"])]
        _ = h.get()
        let data = try Data(contentsOf: URL(fileURLWithPath: h.indexPath))
        let index = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(index.keys) == ["generation", "entries", "pending"])
        let entries = try #require(index["entries"] as? [String: String])
        let pending = try #require(index["pending"] as? [String: [String: Any]])
        var ids = Set(entries.keys)
        var hashes = Array(entries.values)
        for page in pending.values {
            let upserts = try #require(page["upserts"] as? [String: String])
            let deletes = try #require(page["deletes"] as? [String])
            ids.formUnion(upserts.keys)
            ids.formUnion(deletes)
            hashes += upserts.values
        }
        #expect(ids == ["id-a"])
        #expect(!hashes.isEmpty)
        for hash in hashes {
            #expect(hash.isEmpty || (hash.count == 64 && hash.allSatisfy { "0123456789abcdef".contains($0) }), "\(hash)")
        }
        let generation = try #require(index["generation"] as? String)
        #expect(UUID(uuidString: generation) != nil)
        let text = String(decoding: data, as: UTF8.self)
        for value in ["alice", "Example", "example.invalid", "+1 555 0100", "Engineer", "Friends", "Acme", "work", "mobile"] {
            #expect(!text.contains(value), "\(value)")
        }
        let mode = try FileManager.default.attributesOfItem(atPath: h.indexPath)[.posixPermissions] as? Int
        #expect(mode == 0o600)
    }

    @Test func theSystemStoreFetchesOnlyTheAgreedKeys() {
        #expect(SystemContactsStore.keys == [CNContactGivenNameKey, CNContactFamilyNameKey, CNContactNicknameKey, CNContactOrganizationNameKey,
                                             CNContactJobTitleKey, CNContactEmailAddressesKey, CNContactPhoneNumbersKey])
        #expect(!SystemContactsStore.keys.contains(CNContactNoteKey))
    }

    @Test func contactsWritesLiveOnlyInTheSystemStore() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Sources")
        let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)?.compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" } ?? []
        #expect(files.contains { $0.lastPathComponent == "SystemContactsStore.swift" })
        for file in files where file.lastPathComponent != "SystemContactsStore.swift" {
            let text = try String(contentsOf: file, encoding: .utf8)
            for banned in ["CNSaveRequest", "CNMutableContact", "CNMutableGroup", ".execute("] {
                #expect(!text.contains(banned), "\(file.lastPathComponent) contains \(banned)")
            }
        }
        let reader = try String(contentsOf: root.appendingPathComponent("HelperCore/Contacts.swift"), encoding: .utf8)
        #expect(!reader.contains("ContactsWriteStore") && !reader.contains(".save("))
    }
}

@Suite struct ContactsRoutingTests {
    @Test func loopbackServesTheRouteBehindItsScope() {
        let h = ContactsHarness()
        h.store.records = [person("id-a", "alice")]
        h.enabled = ["contacts", "imessage"]
        let r = h.router()
        #expect(send(r, request(ContactsSource.route, auth: "Bearer \(contactsToken)")).response.status == 200)
        #expect(code(send(r, request(ContactsSource.route, auth: nil))) == "unauthorized")
        #expect(code(send(r, request(ContactsSource.route))) == "insufficient_scope")
        #expect(code(send(r, request(ContactsSource.route, auth: "Bearer \(contactsToken)", host: tailnetHost))) == "forbidden_host")
        #expect(code(send(r, request("/v1/imessage/threads", auth: "Bearer \(contactsToken)"))) == "insufficient_scope")
        let listed = sources(send(r, request("/v1/sources"))).first { $0["id"] as? String == "contacts" }
        #expect(listed?["permission"] as? String == "contacts")
        #expect(listed?["state"] as? String == "ok")
        #expect(listed?["scopes"] as? [String] == ["read:contacts"])
        #expect(listed?["routes"] as? [String] == [ContactsSource.route])
        #expect(h.store.snapshots == 1)
    }

    @Test func turningTheSourceOffAppliesOnTheNextRequest() {
        let h = ContactsHarness()
        let r = h.router()
        h.enabled = []
        #expect(code(send(r, request(ContactsSource.route, auth: "Bearer \(contactsToken)"))) == "source_disabled")
        #expect(h.store.snapshots == 0)
        h.enabled = ["contacts"]
        #expect(send(r, request(ContactsSource.route, auth: "Bearer \(contactsToken)")).response.status == 200)
    }

    @Test func tailnetServesContactsChangesToListedPeersWithTheScope() {
        let h = ContactsHarness()
        h.store.records = [person("id-a", "alice")]
        let r = h.router(.tailnet(allowed: [tailnetPeer]))
        func call(_ target: String, auth: String? = "Bearer \(contactsToken)", origin: String? = nil, method: String = "GET", peer: UInt32 = tailnetPeer) -> Routed {
            send(r, request(target, auth: auth, host: tailnetHost, origin: origin, method: method), peer: peer)
        }
        let served = call(ContactsSource.route + "?limit=10")
        #expect(served.response.status == 200)
        #expect(h.page(served).ids == ["id-a"])
        #expect(served.rows == 1)
        #expect(call(ContactsSource.route, auth: nil).response.status == 401)
        #expect(code(call(ContactsSource.route, auth: "Bearer wrong")) == "unauthorized")
        #expect(code(call(ContactsSource.route, auth: "Bearer \(token)")) == "insufficient_scope")
        #expect(code(call(ContactsSource.route, auth: "Bearer \(statusToken)")) == "insufficient_scope")
        #expect(call(ContactsSource.route, method: "POST").response.status == 405)
        #expect(code(call(ContactsSource.route, origin: "https://attacker.example")) == "forbidden_origin")
        for peer in [strangerPeer, macTailnet, loopbackPeer] {
            #expect(code(call(ContactsSource.route, peer: peer)) == "forbidden_source")
        }
        for target in ["/health", "/v1/sources", "/v1/imessage/threads", "/v1/imessage/thread?thread_id=x", "/v1/contacts", ContactsSource.adminRoute,
                       SendService.adminRoute, SendSignature.route] {
            #expect(code(call(target)) == "not_found", "\(target)")
            #expect(code(call(target, auth: "Bearer \(token)")) == "not_found", "\(target)")
        }
        #expect(code(call(ContactsSource.adminRoute, method: "POST")) == "not_found")
        h.enabled = []
        #expect(code(call(ContactsSource.route)) == "source_disabled")
        #expect(h.store.snapshots == 1)
    }

    @Test func setupAsksOnceAndOnlyWhenUndecided() {
        let h = ContactsHarness()
        h.store.current = .notDetermined
        h.store.afterRequest = .allowed
        let status = h.admin(#"{"action":"status"}"#)
        #expect(status.response.status == 200)
        #expect(json(status)["contacts"] as? String == "not_determined")
        #expect(h.store.requests == 0)
        let setup = h.admin(#"{"action":"setup"}"#)
        #expect(json(setup)["contacts"] as? String == "allowed")
        #expect(h.store.requests == 1)
        #expect(json(h.admin(#"{"action":"setup"}"#))["contacts"] as? String == "allowed")
        #expect(h.store.requests == 1)
        h.store.current = .denied
        #expect(json(h.admin(#"{"action":"setup"}"#))["contacts"] as? String == "denied")
        #expect(h.store.requests == 1)
        #expect(h.store.snapshots == 0)
    }

    @Test func setupIsServedOnlyToThisMac() {
        let h = ContactsHarness()
        h.store.current = .notDetermined
        #expect(code(h.admin(#"{"action":"later"}"#)) == "bad_param")
        #expect(code(h.admin("not json")) == "bad_param")
        #expect(code(h.admin(#"{"action":"setup"}"#, method: "GET")) == "method_not_allowed")
        #expect(code(h.admin(#"{"action":"setup"}"#, peer: strangerPeer)) == "forbidden_source")
        #expect(code(h.admin(#"{"action":"setup"}"#, headers: ["host": tailnetHost])) == "forbidden_host")
        #expect(code(h.admin(#"{"action":"setup"}"#, headers: ["host": goodHost, "origin": "null"])) == "forbidden_origin")
        #expect(h.store.requests == 0)
        #expect(h.router().bodyLimit(path: ContactsSource.adminRoute) == 8192)
    }

    @Test func configAcceptsTheContactsSourceAndScopeAndReloadsThem() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("helper-config-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent("config.json").path
        var config = Config(port: 8792, tokens: [TokenEntry(name: "box", verifier: Token.hexDigest(contactsToken), scopes: ["read:contacts"])],
                            sources: ["contacts": SourceSetting(enabled: true), "imessage": SourceSetting(enabled: false)])
        #expect(try config.validated().enabled == ["contacts"])
        try config.write(path: path)
        let live = LiveGrants(path: path)
        #expect(live.enabledSources() == ["contacts"])
        #expect(live.current().first?.scopes == ["read:contacts"])
        config.sources["contacts"] = SourceSetting(enabled: false)
        try config.write(path: path)
        #expect(live.enabledSources() == [])
    }
}
