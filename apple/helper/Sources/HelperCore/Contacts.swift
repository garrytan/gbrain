import CryptoKit
import Foundation

public struct LabeledValue: Codable, Equatable {
    public let label: String
    public let value: String

    public init(label: String, value: String) {
        self.label = label
        self.value = value
    }
}

public struct ContactFields: Codable, Equatable {
    public var givenName: String
    public var familyName: String
    public var nickname: String
    public var organization: String
    public var jobTitle: String
    public var emails: [LabeledValue]
    public var phones: [LabeledValue]
    public var groups: [String]

    public init(givenName: String = "", familyName: String = "", nickname: String = "", organization: String = "", jobTitle: String = "",
                emails: [LabeledValue] = [], phones: [LabeledValue] = [], groups: [String] = []) {
        self.givenName = givenName
        self.familyName = familyName
        self.nickname = nickname
        self.organization = organization
        self.jobTitle = jobTitle
        self.emails = emails
        self.phones = phones
        self.groups = groups
    }
}

public struct ContactRecord: Equatable {
    public let id: String
    public let fields: ContactFields

    public init(id: String, fields: ContactFields) {
        self.id = id
        self.fields = fields
    }
}

public enum ContactsAccess: String {
    case allowed
    case notDetermined = "not_determined"
    case denied
    case restricted
}

public protocol ContactsStore {
    func access() -> ContactsAccess
    func requestAccess(timeout: TimeInterval) -> ContactsAccess
    func snapshot() throws -> [ContactRecord]
}

struct PendingPage: Codable, Equatable {
    var upserts: [String: String]
    var deletes: [String]
}

struct ContactsIndex: Codable, Equatable {
    var generation: String
    var entries: [String: String]
    var pending: [String: PendingPage]
}

struct ContactsCursor: Equatable {
    enum Mode: String {
        case full
        case changes
    }

    let generation: String
    let mode: Mode
    let position: String
    let key: String

    var encoded: String {
        Base64URL.encode(HTTPResponse.encode(["g": generation, "k": key, "m": mode.rawValue, "p": position]))
    }

    static func decode(_ text: String) -> ContactsCursor? {
        guard text.count <= 2048, let bytes = Base64URL.decode(text),
              let object = (try? JSONSerialization.jsonObject(with: Data(bytes))) as? [String: Any], Set(object.keys) == ["g", "k", "m", "p"],
              let generation = object["g"] as? String, !generation.isEmpty, let key = object["k"] as? String, !key.isEmpty,
              let mode = (object["m"] as? String).flatMap(Mode.init(rawValue:)), let position = object["p"] as? String else { return nil }
        return ContactsCursor(generation: generation, mode: mode, position: position, key: key)
    }
}

struct ContactChange: Encodable {
    let op: String
    let id: String
    let contact: ContactFields?
}

struct ContactsMeta: Encodable {
    let nextCursor: String
    let more: Bool
    let full: Bool
}

struct ContactsAdminStatus: Encodable {
    let contacts: String
}

public final class ContactsSource: SourceModule {
    public static let route = "/v1/contacts/changes"
    public static let adminRoute = "/v1/admin/contacts"
    public static let accessWait: TimeInterval = 300
    public static let indexFile = "contacts-index.json"

    public let id = "contacts"
    public let permission = "contacts"
    public let routes = [route]
    let store: ContactsStore
    let indexPath: String
    let lock = NSLock()

    public init(store: ContactsStore, indexPath: String) {
        self.store = store
        self.indexPath = indexPath
    }

    public func state() -> String {
        let access = store.access()
        return access == .allowed ? "ok" : access.rawValue
    }

    public func handle(path: String, query: [String: String]) throws -> (response: HTTPResponse, rows: Int) {
        let limit = Int(try IMessageSource.intParam(query, "limit", 1...500) ?? 200)
        var cursor: ContactsCursor?
        if let raw = query["cursor"] {
            guard let parsed = ContactsCursor.decode(raw) else {
                throw Problem.badParam("cursor is not one this helper issued; leave it out to read a full snapshot")
            }
            cursor = parsed
        }
        guard store.access() == .allowed else { throw Problem.contactsNotAllowed }
        lock.lock()
        defer { lock.unlock() }

        var index = ContactsIndex(generation: UUID().uuidString, entries: [:], pending: [:])
        if let cursor {
            guard let data = FileManager.default.contents(atPath: indexPath), let loaded = try? JSONDecoder().decode(ContactsIndex.self, from: data),
                  loaded.generation == cursor.generation else { throw Problem.cursorExpired }
            index = loaded
            if let applied = index.pending[cursor.key] {
                for (id, hash) in applied.upserts { index.entries[id] = hash }
                for id in applied.deletes { index.entries.removeValue(forKey: id) }
            } else {
                for page in index.pending.values {
                    for id in page.upserts.keys { index.entries[id] = "" }
                    for id in page.deletes { index.entries[id] = "" }
                }
            }
            index.pending = [:]
        }

        var current: [String: (fields: ContactFields, hash: String)] = [:]
        for record in try store.snapshot() where !record.id.isEmpty && current[record.id] == nil {
            current[record.id] = (record.fields, SHA256.hash(data: HTTPResponse.encode(record.fields)).map { String(format: "%02x", $0) }.joined())
        }

        let key = UUID().uuidString
        var page = PendingPage(upserts: [:], deletes: [])
        var items: [ContactChange] = []
        var more = false
        let next: ContactsCursor
        let full: Bool
        if let cursor, cursor.mode == .changes {
            for id in Set(current.keys).union(index.entries.keys).filter({ $0 > cursor.position }).sorted() {
                let now = current[id]
                if let now, now.hash == index.entries[id] { continue }
                if items.count == limit {
                    more = true
                    break
                }
                if let now {
                    items.append(ContactChange(op: "upsert", id: id, contact: now.fields))
                    page.upserts[id] = now.hash
                } else {
                    items.append(ContactChange(op: "delete", id: id, contact: nil))
                    page.deletes.append(id)
                }
            }
            full = false
            next = ContactsCursor(generation: index.generation, mode: .changes, position: more ? items.last!.id : "", key: key)
        } else {
            let ids = current.keys.filter { $0 > (cursor?.position ?? "") }.sorted()
            for id in ids.prefix(limit) {
                items.append(ContactChange(op: "upsert", id: id, contact: current[id]!.fields))
                page.upserts[id] = current[id]!.hash
            }
            more = ids.count > items.count
            full = !more
            next = ContactsCursor(generation: index.generation, mode: more ? .full : .changes, position: more ? items.last!.id : "", key: key)
        }
        index.pending = [key: page]
        try Config.writePrivate(Data(HTTPResponse.encode(index)), path: indexPath)
        return (response: .json(200, Envelope(data: items, meta: ContactsMeta(nextCursor: next.encoded, more: more, full: full))), rows: items.count)
    }

    public func problem(for error: Error) -> Problem {
        (error as? Problem) ?? .internalError
    }

    public func admin(_ request: HTTPRequest) -> SendReply {
        guard let fields = StrictJSON.flatObject(request.body), let action = fields["action"] else {
            return .problem(.badParam("the body must be a JSON object with an action"))
        }
        switch action {
        case "status":
            return .ok(.json(200, ContactsAdminStatus(contacts: store.access().rawValue)))
        case "setup":
            let access = store.access() == .notDetermined ? store.requestAccess(timeout: Self.accessWait) : store.access()
            return .ok(.json(200, ContactsAdminStatus(contacts: access.rawValue)))
        default:
            return .problem(.badParam("unknown action \(action)"))
        }
    }
}
