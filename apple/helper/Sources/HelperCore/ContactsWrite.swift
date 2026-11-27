import CryptoKit
import Foundation

public struct PostalValue: Codable, Equatable {
    public var street = "", subLocality = "", city = "", subAdministrativeArea = "", state = "", postalCode = "", country = "", isoCountryCode = ""
    public init() {}
}

public struct DateValue: Codable, Equatable {
    public var year: Int?
    public var month: Int?
    public var day: Int?
    public var calendar: String?
    public var leapMonth: Bool?
    public init(year: Int? = nil, month: Int? = nil, day: Int? = nil, calendar: String? = nil, leapMonth: Bool? = nil) {
        self.year = year
        self.month = month
        self.day = day
        self.calendar = calendar
        self.leapMonth = leapMonth
    }
}

public struct SocialValue: Codable, Equatable {
    public var urlString = "", username = "", userIdentifier = "", service = ""
    public init() {}
}

public struct Labeled<T: Codable & Equatable>: Codable, Equatable {
    public var label: String
    public var value: T
    public init(label: String, value: T) {
        self.label = label
        self.value = value
    }
}

public struct FullCard: Codable, Equatable {
    public var id = ""
    public var organizationType = false
    public var namePrefix = "", givenName = "", middleName = "", familyName = "", previousFamilyName = "", nameSuffix = "", nickname = ""
    public var phoneticGivenName = "", phoneticMiddleName = "", phoneticFamilyName = "", phoneticOrganizationName = ""
    public var organization = "", department = "", jobTitle = ""
    public var emails: [Labeled<String>] = []
    public var phones: [Labeled<String>] = []
    public var urls: [Labeled<String>] = []
    public var postal: [Labeled<PostalValue>] = []
    public var dates: [Labeled<DateValue>] = []
    public var relations: [Labeled<String>] = []
    public var social: [Labeled<SocialValue>] = []
    public var instantMessages: [Labeled<SocialValue>] = []
    public var birthday: DateValue?
    public var nonGregorianBirthday: DateValue?
    public var imageData: String?
    public var groups: [String] = []
    public init() {}
}

public enum ScalarField: String, CaseIterable {
    case givenName = "given_name", familyName = "family_name", nickname, organization, jobTitle = "job_title"

    func get(_ card: FullCard) -> String {
        switch self {
        case .givenName: return card.givenName
        case .familyName: return card.familyName
        case .nickname: return card.nickname
        case .organization: return card.organization
        case .jobTitle: return card.jobTitle
        }
    }

    func set(_ card: inout FullCard, _ value: String) {
        switch self {
        case .givenName: card.givenName = value
        case .familyName: card.familyName = value
        case .nickname: card.nickname = value
        case .organization: card.organization = value
        case .jobTitle: card.jobTitle = value
        }
    }
}

public enum ListField: String {
    case emails, phones

    func values(_ card: FullCard) -> [Labeled<String>] { self == .emails ? card.emails : card.phones }

    func key(_ value: String, countryCode: String) -> String? {
        self == .emails ? (value.contains("@") ? PhoneKey.email(value) : nil) : PhoneKey.canonical(value, countryCode: countryCode)
    }

    func holds(_ card: FullCard, _ value: String, countryCode: String) -> Bool {
        guard let wanted = key(value, countryCode: countryCode) else { return false }
        return values(card).contains { key($0.value, countryCode: countryCode) == wanted || $0.value == value }
    }
}

public enum CardEdit: Equatable {
    case create(FullCard)
    case setField(id: String, field: ScalarField, value: String)
    case addValue(id: String, field: ListField, label: String, value: String)
    case removeValue(id: String, field: ListField, value: String, countryCode: String)
    case addToGroup(id: String, group: String, create: Bool)
    case removeFromGroup(id: String, group: String)
    case delete(id: String)
}

public struct WritableCard: Equatable {
    public let card: FullCard
    public let writable: Bool

    public init(card: FullCard, writable: Bool) {
        self.card = card
        self.writable = writable
    }
}

public protocol ContactsWriteStore {
    func access() -> ContactsAccess
    func card(_ id: String, image: Bool) throws -> WritableCard?
    func allCards() throws -> [FullCard]
    func groupExists(_ name: String) throws -> Bool
    func save(_ edit: CardEdit) throws -> String
}

public enum ContactsWriteScope {
    public static let enrich = "write:contacts:enrich"
}

public struct ContactsWriteLimits: Codable, Equatable {
    public var newCards: Int
    public var deletes: Int
    public var edits: Int

    enum CodingKeys: String, CodingKey {
        case newCards = "new_cards", deletes, edits
    }

    public static let standard = ContactsWriteLimits(newCards: 50, deletes: 25, edits: 200)

    public init(newCards: Int, deletes: Int, edits: Int) {
        self.newCards = newCards
        self.deletes = deletes
        self.edits = edits
    }
}

public struct OwnerKey: Codable, Equatable {
    public var name: String
    public var publicKey: String

    enum CodingKeys: String, CodingKey {
        case name
        case publicKey = "public_key"
    }

    public init(name: String, publicKey: String) {
        self.name = name
        self.publicKey = publicKey
    }
}

public struct ContactsWriteSetting: Codable, Equatable {
    public var enabled: Bool
    public var ownerKeys: [OwnerKey]
    public var limits: ContactsWriteLimits?

    enum CodingKeys: String, CodingKey {
        case enabled
        case ownerKeys = "owner_keys"
        case limits
    }

    public init(enabled: Bool, ownerKeys: [OwnerKey] = [], limits: ContactsWriteLimits? = nil) {
        self.enabled = enabled
        self.ownerKeys = ownerKeys
        self.limits = limits
    }
}

public struct ContactsWritePolicy: Equatable {
    public let enabled: Bool
    public let ownerKeys: [String: [UInt8]]
    public let limits: ContactsWriteLimits

    public static let off = ContactsWritePolicy(enabled: false, ownerKeys: [:], limits: .standard)

    public init(enabled: Bool, ownerKeys: [String: [UInt8]], limits: ContactsWriteLimits) {
        self.enabled = enabled
        self.ownerKeys = ownerKeys
        self.limits = limits
    }
}

struct ChangeRequest {
    let key: String
    let op: String
    let id: String?
    let from: String?
    let field: String?
    let value: String?
    let label: String?
    let group: String?
    let fields: [String: Any]?
    let expect: [String: Any]?
}

public struct JournalRow: Codable, Equatable {
    public var batch: String
    public var key: String
    public var op: String
    public var phase: String
    public var id: String?
    public var field: String?
    public var value: String?
    public var label: String?
    public var group: String?
    public var prior: String?
    public var before: FullCard?
    public var reason: String?
    public var requestedBy: String
    public var instruction: String?
    public var at: String
    public var removed: [Labeled<String>]? = nil

    enum CodingKeys: String, CodingKey {
        case batch, key, op, phase, id, field, value, label, group, prior, before, reason, instruction, at, removed
        case requestedBy = "requested_by"
    }
}

public struct ChangeResult: Encodable, Equatable {
    public let key: String
    public let op: String
    public let status: String
    public let id: String?
    public let reason: String?
}

struct BatchReply: Encodable {
    let batch: String
    let journal: String
    let results: [ChangeResult]
    let stopped: String?
    let sideEffects: String
    let next: String?
}

struct RestoreReply: Encodable {
    let batch: String
    let dryRun: Bool
    let steps: [ChangeResult]
}

public final class ContactsWriter {
    public static let route = "/v1/contacts/batch"
    public static let adminRoute = "/v1/admin/contacts-write"
    public static let maxChanges = 200
    public static let bodyLimit = 256 * 1024
    public static let keep: TimeInterval = 7 * 86400
    public static let backupCap = 2 * 1024 * 1024 * 1024
    public static let addedGroup = "Added by GBrain"
    static let enrichOps: Set<String> = ["create", "fill", "add_value", "group_add"]
    static let ownerOps: Set<String> = enrichOps.union(["set", "remove_value", "group_remove", "delete", "merge"])

    let store: ContactsWriteStore
    let directory: String
    let policy: () -> ContactsWritePolicy
    let now: () -> Date
    let nonces = NonceCache()
    let lock = NSLock()

    public init(store: ContactsWriteStore, directory: String, policy: @escaping () -> ContactsWritePolicy, now: @escaping () -> Date = Date.init) {
        self.store = store
        self.directory = directory
        self.policy = policy
        self.now = now
    }

    var journalDir: String { directory + "/contacts-journal" }
    var backupDir: String { directory + "/contacts-backups" }
    var quotaPath: String { directory + "/contacts-write-quota.json" }

    static func problem(_ code: String, _ status: Int, _ title: String, _ detail: String, fix: String? = nil) -> Problem {
        Problem(code: code, status: status, title: title, detail: detail, fix: fix)
    }

    static let writeOff = problem("contacts_write_off", 403, "Contacts writes are off",
                                  "Contacts writes are switched off on this Mac, so nothing was changed.",
                                  fix: "On the Mac, run: \"$HOME/Applications/GBrain Helper.app/Contents/MacOS/gbrain-apple-helper\" contacts-write on")

    public func handle(_ request: HTTPRequest, grants: [TokenGrant]) -> SendReply {
        let policy = policy()
        guard policy.enabled else { return .problem(Self.writeOff) }
        guard store.access() == .allowed else { return .problem(.contactsNotAllowed) }
        guard let object = (try? JSONSerialization.jsonObject(with: Data(request.body))) as? [String: Any] else {
            return .problem(.badParam("the body must be one JSON object"))
        }
        for key in object.keys where !["batch", "requested_by", "owner_instruction", "country_code", "changes"].contains(key) {
            return .problem(.badParam("unknown field \(key)"))
        }
        guard let batch = object["batch"] as? String, SendSignature.validIdempotencyKey(batch) else {
            return .problem(.badParam("batch must be 8 to 128 letters, digits, dot, dash or underscore"))
        }
        guard let requestedBy = object["requested_by"] as? String, ["owner", "enrich"].contains(requestedBy) else {
            return .problem(.badParam("requested_by must be owner or enrich"))
        }
        let instruction = object["owner_instruction"] as? String
        if requestedBy == "owner" {
            guard let signature = SendSignature.parse(request.headers["authorization"]), let key = policy.ownerKeys[signature.keyName],
                  abs(signature.timestamp - Int(now().timeIntervalSince1970)) <= SendSignature.maxSkew,
                  signature.verifies(publicKey: key, idempotencyKey: batch, body: request.body, route: Self.route),
                  nonces.claim(signature.nonce, now: now()) else { return .problem(.unauthorized) }
            guard let instruction, !instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, instruction.count <= 1000 else {
                return .problem(.badParam("owner_instruction must hold the owner's words, 1 to 1000 characters"))
            }
        } else {
            guard let grant = Token.grant(authorization: request.headers["authorization"], grants: grants) else { return .problem(.unauthorized) }
            guard grant.scopes.contains(ContactsWriteScope.enrich) else { return .problem(.insufficientScope(ContactsWriteScope.enrich)) }
        }
        let country = object["country_code"] as? String ?? "1"
        guard PhoneKey.validCountryCode(country) else { return .problem(.badParam("country_code must be 1 to 3 digits")) }
        guard let raw = object["changes"] as? [[String: Any]], !raw.isEmpty, raw.count <= Self.maxChanges else {
            return .problem(.badParam("changes must be a list of 1 to \(Self.maxChanges) objects"))
        }
        var changes: [ChangeRequest] = []
        let allowed = requestedBy == "owner" ? Self.ownerOps : Self.enrichOps
        for item in raw {
            guard let key = item["key"] as? String, SendSignature.validIdempotencyKey(key), let op = item["op"] as? String else {
                return .problem(.badParam("every change needs a key (8 to 128 safe characters) and an op"))
            }
            guard allowed.contains(op) else {
                return .problem(requestedBy == "owner" ? .badParam("unknown op \(op)") : .insufficientScope("an owner-signed request for \(op)"))
            }
            changes.append(ChangeRequest(key: key, op: op, id: item["id"] as? String, from: item["from"] as? String, field: item["field"] as? String,
                                         value: item["value"] as? String, label: item["label"] as? String, group: item["group"] as? String,
                                         fields: item["fields"] as? [String: Any], expect: item["expect"] as? [String: Any]))
        }
        guard Set(changes.map(\.key)).count == changes.count else { return .problem(.badParam("change keys must be unique in a batch")) }
        lock.lock()
        defer { lock.unlock() }
        do {
            try prepareDirectories()
            try ensureDailyExport()
        } catch {
            return .problem(Self.problem("backup_failed", 503, "Backup failed",
                                         "The helper could not save its daily copy of your contacts, so it changed nothing.",
                                         fix: "Check free disk space on the Mac, then send the batch again."))
        }
        let run = Run(writer: self, batch: batch, requestedBy: requestedBy, instruction: requestedBy == "owner" ? instruction : nil,
                      country: country, limits: policy.limits)
        let results = run.apply(changes)
        let applied = results.contains { $0.status == "applied" }
        let reply = BatchReply(batch: batch, journal: run.journalPath, results: results, stopped: run.stopped, sideEffects: applied ? (run.stopped == nil ? "all" : "partial") : "none",
                               next: run.stopped.map { Self.nextStep($0, batch: batch) })
        return .ok(.json(200, Envelope(data: reply, meta: SourcesMeta(count: results.count))))
    }

    static func nextStep(_ stop: String, batch: String) -> String {
        switch stop {
        case "quota": return "The daily limit on this Mac was reached; the rest of the batch waits until tomorrow (UTC). Raise it only on the Mac: gbrain-apple-helper contacts-write limits set <name>=<n>"
        case "readback_mismatch", "save_failed": return "Read the card again (gbrain apple-contacts status --json), and undo this batch if needed on the Mac: gbrain-apple-helper contacts-restore --batch \(batch) --dry-run"
        default: return "Fix the cause, then send the remaining changes again; finished keys are answered from the journal."
        }
    }

    func prepareDirectories() throws {
        for path in [journalDir, backupDir] {
            try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            var url = URL(fileURLWithPath: path)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try? url.setResourceValues(values)
        }
    }

    static func day(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    static func stamp(_ date: Date) -> String {
        ISO8601DateFormatter().string(from: date)
    }

    func ensureDailyExport() throws {
        let path = backupDir + "/full-\(Self.day(now())).jsonl"
        if FileManager.default.fileExists(atPath: path) { return }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        var data = Data()
        for card in try store.allCards() {
            data.append(try encoder.encode(card))
            data.append(0x0A)
        }
        try Config.writePrivate(data, path: path)
        prune(backupDir, cap: Self.backupCap)
    }

    func prune(_ path: String, cap: Int?) {
        let files = ((try? FileManager.default.contentsOfDirectory(atPath: path)) ?? []).map { path + "/" + $0 }
        var dated = files.compactMap { file -> (String, Date, Int)? in
            guard let attributes = try? FileManager.default.attributesOfItem(atPath: file), let date = attributes[.modificationDate] as? Date else { return nil }
            return (file, date, (attributes[.size] as? Int) ?? 0)
        }.sorted { $0.1 < $1.1 }
        for entry in dated where now().timeIntervalSince(entry.1) > Self.keep { try? FileManager.default.removeItem(atPath: entry.0) }
        dated.removeAll { now().timeIntervalSince($0.1) > Self.keep }
        guard let cap else { return }
        var total = dated.reduce(0) { $0 + $1.2 }
        while total > cap, dated.count > 1 {
            let oldest = dated.removeFirst()
            try? FileManager.default.removeItem(atPath: oldest.0)
            total -= oldest.2
        }
    }

    public func journalRows() -> [JournalRow] {
        prune(journalDir, cap: nil)
        let files = ((try? FileManager.default.contentsOfDirectory(atPath: journalDir)) ?? []).filter { $0.hasSuffix(".jsonl") }.sorted()
        var rows: [JournalRow] = []
        for file in files {
            guard let data = FileManager.default.contents(atPath: journalDir + "/" + file) else { continue }
            for line in data.split(separator: 0x0A) {
                if let row = try? JSONDecoder().decode(JournalRow.self, from: Data(line)) { rows.append(row) }
            }
        }
        return rows
    }

    func append(_ row: JournalRow, to path: String) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        var line = try encoder.encode(row)
        line.append(0x0A)
        if !FileManager.default.fileExists(atPath: path) { try Config.writePrivate(Data(), path: path) }
        let handle = try FileHandle(forWritingTo: URL(fileURLWithPath: path))
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: line)
        try handle.synchronize()
    }

    struct Quota: Codable {
        var day: String
        var newCards: Int
        var deletes: Int
        var edits: Int
    }

    func loadQuota() -> Quota {
        let today = Self.day(now())
        guard let data = FileManager.default.contents(atPath: quotaPath), let quota = try? JSONDecoder().decode(Quota.self, from: data), quota.day == today else {
            return Quota(day: today, newCards: 0, deletes: 0, edits: 0)
        }
        return quota
    }

    func saveQuota(_ quota: Quota) throws {
        try Config.writePrivate(try JSONEncoder().encode(quota), path: quotaPath)
    }

    public func admin(_ request: HTTPRequest) -> SendReply {
        guard let fields = StrictJSON.flatObject(request.body), let action = fields["action"] else {
            return .problem(.badParam("the body must be a JSON object with an action"))
        }
        switch action {
        case "restore":
            guard let batch = fields["batch"], SendSignature.validIdempotencyKey(batch) else { return .problem(.badParam("restore needs a batch id")) }
            lock.lock()
            defer { lock.unlock() }
            do {
                try prepareDirectories()
                return .ok(.json(200, Envelope(data: try restore(batch: batch, dryRun: fields["dry_run"] != "false"), meta: SourcesMeta(count: 1))))
            } catch let problem as Problem {
                return .problem(problem)
            } catch {
                return .problem(.internalError)
            }
        default:
            return .problem(.badParam("unknown action \(action)"))
        }
    }

    func restore(batch: String, dryRun: Bool) throws -> RestoreReply {
        let rows = journalRows()
        let done = rows.filter { $0.batch == batch && $0.phase == "done" }
        guard !done.isEmpty else { throw Problem.badParam("no finished changes are journaled for batch \(batch) in the last 7 days") }
        let undo = "restore-\(batch)-\(Int(now().timeIntervalSince1970))"
        let path = journalDir + "/\(undo).jsonl"
        var steps: [ChangeResult] = []
        for row in done.reversed() {
            let step = try undoStep(row)
            guard !step.edits.isEmpty else {
                steps.append(ChangeResult(key: row.key, op: row.op, status: "skipped", id: row.id, reason: step.why))
                continue
            }
            if dryRun {
                steps.append(ChangeResult(key: row.key, op: row.op, status: "would_undo", id: row.id, reason: step.why))
                continue
            }
            var record = JournalRow(batch: undo, key: row.key + ".undo", op: "undo_" + row.op, phase: "intent", id: row.id, field: row.field, value: row.value,
                                    label: row.label, group: row.group, prior: nil, before: step.before, reason: nil, requestedBy: "owner_mac",
                                    instruction: nil, at: Self.stamp(now()))
            try append(record, to: path)
            var id = row.id ?? ""
            for edit in step.edits { id = try store.save(edit) }
            record.phase = "done"
            record.id = id
            try append(record, to: path)
            steps.append(ChangeResult(key: row.key, op: row.op, status: "undone", id: id, reason: step.why))
        }
        return RestoreReply(batch: batch, dryRun: dryRun, steps: steps)
    }

    func undoStep(_ row: JournalRow) throws -> (edits: [CardEdit], why: String?, before: FullCard?) {
        func live() throws -> FullCard? { try row.id.flatMap { try store.card($0, image: true)?.card } }
        switch row.op {
        case "fill", "set":
            guard let id = row.id, let field = row.field.flatMap(ScalarField.init(rawValue:)), let current = try live() else { return ([], "card is gone", nil) }
            guard field.get(current) == row.value else { return ([], "the field changed since; left as it is", nil) }
            return ([.setField(id: id, field: field, value: row.prior ?? "")], nil, current)
        case "add_value":
            guard let id = row.id, let field = row.field.flatMap(ListField.init(rawValue:)), let value = row.value, let current = try live() else { return ([], "card is gone", nil) }
            guard field.values(current).contains(where: { $0.value == value }) else { return ([], "the value is no longer on the card", nil) }
            return ([.removeValue(id: id, field: field, value: value, countryCode: "0")], nil, current)
        case "remove_value":
            guard let id = row.id, let field = row.field.flatMap(ListField.init(rawValue:)), let value = row.value, try live() != nil else { return ([], "card is gone", nil) }
            let entries = row.removed ?? [Labeled(label: row.label ?? "", value: value)]
            return (entries.map { .addValue(id: id, field: field, label: $0.label, value: $0.value) }, nil, nil)
        case "group_add":
            guard let id = row.id, let group = row.group, try live() != nil else { return ([], "card is gone", nil) }
            return ([.removeFromGroup(id: id, group: group)], nil, nil)
        case "group_remove":
            guard let id = row.id, let group = row.group, try live() != nil else { return ([], "card is gone", nil) }
            return ([.addToGroup(id: id, group: group, create: false)], nil, nil)
        case "create":
            guard let id = row.id, let current = try live() else { return ([], "card is already gone", nil) }
            return ([.delete(id: id)], "removes the card this batch made", current)
        case "delete":
            guard let before = row.before else { return ([], "no saved copy", nil) }
            if let id = row.id, try store.card(id, image: false) != nil { return ([], "card still exists", nil) }
            return ([.create(before)], "puts the card back as a new card; its note, if it had one, was not readable", nil)
        default:
            return ([], "nothing to undo", nil)
        }
    }

    final class Run {
        let writer: ContactsWriter
        let batch: String
        let requestedBy: String
        let instruction: String?
        let country: String
        let limits: ContactsWriteLimits
        let journalPath: String
        var stopped: String?
        var index: [String: JournalRow] = [:]
        var holders: [String: String]?

        init(writer: ContactsWriter, batch: String, requestedBy: String, instruction: String?, country: String, limits: ContactsWriteLimits) {
            self.writer = writer
            self.batch = batch
            self.requestedBy = requestedBy
            self.instruction = instruction
            self.country = country
            self.limits = limits
            journalPath = writer.journalDir + "/\(batch).jsonl"
            for row in writer.journalRows() where index[row.key]?.phase != "done" { index[row.key] = row }
        }

        func row(_ change: ChangeRequest, phase: String, id: String?, field: String? = nil, value: String? = nil, label: String? = nil, group: String? = nil,
                 prior: String? = nil, before: FullCard? = nil, reason: String? = nil, removed: [Labeled<String>]? = nil) -> JournalRow {
            JournalRow(batch: batch, key: change.key, op: change.op, phase: phase, id: id, field: field ?? change.field, value: value ?? change.value,
                       label: label ?? change.label, group: group ?? change.group, prior: prior, before: before, reason: reason, requestedBy: requestedBy,
                       instruction: instruction, at: ContactsWriter.stamp(writer.now()), removed: removed)
        }

        func apply(_ changes: [ChangeRequest]) -> [ChangeResult] {
            var results: [ChangeResult] = []
            var quota = writer.loadQuota()
            for change in changes {
                if stopped != nil {
                    results.append(ChangeResult(key: change.key, op: change.op, status: "not_run", id: change.id, reason: "the batch stopped earlier"))
                    continue
                }
                if let previous = index[change.key], previous.phase == "done" {
                    results.append(ChangeResult(key: change.key, op: change.op, status: "replayed", id: previous.id, reason: nil))
                    continue
                }
                let kind = change.op == "create" ? 0 : ["delete", "merge"].contains(change.op) ? 1 : ["fill", "set", "add_value", "remove_value", "group_add", "group_remove"].contains(change.op) ? 2 : -1
                let over = (kind == 0 && quota.newCards >= limits.newCards) || (kind == 1 && quota.deletes >= limits.deletes) || (kind == 2 && quota.edits >= limits.edits)
                if over {
                    stopped = "quota"
                    results.append(ChangeResult(key: change.key, op: change.op, status: "quota", id: change.id, reason: "today's limit on this Mac is reached"))
                    continue
                }
                let result: ChangeResult
                do {
                    result = try run(change)
                } catch let failure as Failure {
                    stopped = failure.code
                    try? writer.append(row(change, phase: "failed", id: change.id, reason: failure.code), to: journalPath)
                    result = ChangeResult(key: change.key, op: change.op, status: "failed", id: change.id, reason: failure.code)
                } catch {
                    stopped = "save_failed"
                    try? writer.append(row(change, phase: "failed", id: change.id, reason: "save_failed"), to: journalPath)
                    result = ChangeResult(key: change.key, op: change.op, status: "failed", id: change.id, reason: "save_failed")
                }
                if result.status == "applied" {
                    if kind == 0 { quota.newCards += 1 } else if kind == 1 { quota.deletes += 1 } else if kind == 2 { quota.edits += 1 }
                    try? writer.saveQuota(quota)
                }
                results.append(result)
            }
            return results
        }

        struct Failure: Error {
            let code: String
        }

        func skip(_ change: ChangeRequest, _ reason: String, id: String? = nil) -> ChangeResult {
            ChangeResult(key: change.key, op: change.op, status: "skipped", id: id ?? change.id, reason: reason)
        }

        func target(_ id: String?, image: Bool = false) throws -> WritableCard? {
            guard let id, !id.isEmpty else { return nil }
            return try writer.store.card(id, image: image)
        }

        func commit(_ change: ChangeRequest, _ edit: CardEdit, intent: JournalRow, check: (FullCard?) -> Bool) throws -> ChangeResult {
            try writer.append(intent, to: journalPath)
            let id = try writer.store.save(edit)
            guard check(try writer.store.card(id, image: false)?.card) else { throw Failure(code: "readback_mismatch") }
            var done = intent
            done.phase = "done"
            done.id = id
            try writer.append(done, to: journalPath)
            index[change.key] = done
            holders = nil
            return ChangeResult(key: change.key, op: change.op, status: "applied", id: id, reason: nil)
        }

        func holder(of field: ListField, _ value: String) throws -> String? {
            if holders == nil {
                var map: [String: String] = [:]
                for card in try writer.store.allCards() {
                    for email in card.emails { if let key = ListField.emails.key(email.value, countryCode: country) { map["e" + key] = card.id } }
                    for phone in card.phones { if let key = ListField.phones.key(phone.value, countryCode: country) { map["p" + key] = card.id } }
                }
                holders = map
            }
            guard let key = field.key(value, countryCode: country) else { return nil }
            return holders?[(field == .emails ? "e" : "p") + key]
        }

        func matches(_ card: FullCard, _ expect: [String: Any]) -> Bool {
            for (name, wanted) in expect {
                if let field = ScalarField(rawValue: name) {
                    guard let text = wanted as? String, field.get(card) == text else { return false }
                } else if let field = ListField(rawValue: name) {
                    guard let list = wanted as? [String] else { return false }
                    let have = Set(field.values(card).map { field.key($0.value, countryCode: country) ?? $0.value })
                    guard have == Set(list.map { field.key($0, countryCode: country) ?? $0 }) else { return false }
                } else {
                    return false
                }
            }
            return true
        }

        func run(_ change: ChangeRequest) throws -> ChangeResult {
            let reconcile = index[change.key]?.phase == "intent"
            switch change.op {
            case "fill", "set":
                guard let field = change.field.flatMap(ScalarField.init(rawValue:)), let value = change.value?.trimmingCharacters(in: .whitespacesAndNewlines),
                      !value.isEmpty, value.count <= 300 else { return skip(change, "bad_change: field must be one of given_name, family_name, nickname, organization, job_title with a value of 1 to 300 characters") }
                guard let card = try target(change.id) else { return skip(change, "card_missing") }
                guard card.writable else { return skip(change, "card_linked") }
                let current = field.get(card.card)
                if current == value { return reconcile ? ChangeResult(key: change.key, op: change.op, status: "replayed", id: change.id, reason: nil) : skip(change, "already_set") }
                if change.op == "fill" {
                    guard current.isEmpty else { return skip(change, "not_empty") }
                } else {
                    guard let expected = change.expect?[field.rawValue] as? String, expected == current else { return skip(change, "card_changed") }
                }
                return try commit(change, .setField(id: card.card.id, field: field, value: value),
                                  intent: row(change, phase: "intent", id: card.card.id, value: value, prior: current)) { field.get($0 ?? FullCard()) == value }
            case "add_value", "remove_value":
                guard let field = change.field.flatMap(ListField.init(rawValue:)), let value = change.value?.trimmingCharacters(in: .whitespacesAndNewlines),
                      field.key(value, countryCode: country) != nil else { return skip(change, "bad_change: field must be emails or phones, with a valid email or phone number") }
                guard let card = try target(change.id) else { return skip(change, "card_missing") }
                guard card.writable else { return skip(change, "card_linked") }
                let held = field.holds(card.card, value, countryCode: country)
                if change.op == "add_value" {
                    if held { return reconcile ? ChangeResult(key: change.key, op: change.op, status: "replayed", id: change.id, reason: nil) : skip(change, "already_present") }
                    return try commit(change, .addValue(id: card.card.id, field: field, label: change.label ?? "", value: value),
                                      intent: row(change, phase: "intent", id: card.card.id, value: value)) { field.holds($0 ?? FullCard(), value, countryCode: self.country) }
                }
                guard held else { return reconcile ? ChangeResult(key: change.key, op: change.op, status: "replayed", id: change.id, reason: nil) : skip(change, "not_present") }
                let wanted = field.key(value, countryCode: country)
                let matched = field.values(card.card).filter { $0.value == value || field.key($0.value, countryCode: country) == wanted }
                return try commit(change, .removeValue(id: card.card.id, field: field, value: value, countryCode: country),
                                  intent: row(change, phase: "intent", id: card.card.id, value: matched.first?.value ?? value, label: matched.first?.label, removed: matched)) {
                    !field.holds($0 ?? FullCard(), value, countryCode: self.country)
                }
            case "group_add", "group_remove":
                guard let group = change.group?.trimmingCharacters(in: .whitespacesAndNewlines), !group.isEmpty, group.count <= 200 else { return skip(change, "bad_change: group must be a group name") }
                guard let card = try target(change.id) else { return skip(change, "card_missing") }
                guard card.writable else { return skip(change, "card_linked") }
                let member = card.card.groups.contains(group)
                if change.op == "group_add" {
                    if member { return reconcile ? ChangeResult(key: change.key, op: change.op, status: "replayed", id: change.id, reason: nil) : skip(change, "already_member") }
                    guard try writer.store.groupExists(group) else { return skip(change, "group_missing") }
                    return try commit(change, .addToGroup(id: card.card.id, group: group, create: false),
                                      intent: row(change, phase: "intent", id: card.card.id, group: group)) { $0?.groups.contains(group) == true }
                }
                guard member else { return reconcile ? ChangeResult(key: change.key, op: change.op, status: "replayed", id: change.id, reason: nil) : skip(change, "not_member") }
                return try commit(change, .removeFromGroup(id: card.card.id, group: group),
                                  intent: row(change, phase: "intent", id: card.card.id, group: group)) { $0?.groups.contains(group) == false }
            case "create":
                var card = FullCard()
                let fields = change.fields ?? [:]
                for (name, value) in fields {
                    if let field = ScalarField(rawValue: name), let text = value as? String, text.count <= 300 {
                        field.set(&card, text.trimmingCharacters(in: .whitespacesAndNewlines))
                    } else if let field = ListField(rawValue: name), let list = value as? [[String: String]] {
                        for entry in list {
                            guard let text = entry["value"]?.trimmingCharacters(in: .whitespacesAndNewlines), field.key(text, countryCode: country) != nil else {
                                return skip(change, "bad_change: \(name) holds a value that is not a valid email or phone number")
                            }
                            let labeled = Labeled(label: entry["label"] ?? "", value: text)
                            if field == .emails { card.emails.append(labeled) } else { card.phones.append(labeled) }
                        }
                    } else {
                        return skip(change, "bad_change: unknown or malformed field \(name)")
                    }
                }
                guard !(card.givenName + card.familyName + card.organization).isEmpty else { return skip(change, "bad_change: a new card needs a name or a company") }
                if requestedBy == "enrich" { guard !(card.emails.isEmpty && card.phones.isEmpty) else { return skip(change, "bad_change: a new card needs an email or a phone") } }
                for email in card.emails { if let id = try holder(of: .emails, email.value) { return reconcile ? ChangeResult(key: change.key, op: change.op, status: "replayed", id: id, reason: nil) : skip(change, "create_duplicate", id: id) } }
                for phone in card.phones { if let id = try holder(of: .phones, phone.value) { return reconcile ? ChangeResult(key: change.key, op: change.op, status: "replayed", id: id, reason: nil) : skip(change, "create_duplicate", id: id) } }
                if requestedBy == "enrich" { card.groups = [ContactsWriter.addedGroup] }
                let made = card
                return try commit(change, .create(made), intent: row(change, phase: "intent", id: nil, before: made)) { saved in
                    guard let saved else { return false }
                    return saved.givenName == made.givenName && saved.familyName == made.familyName && saved.organization == made.organization && saved.emails.count == made.emails.count
                        && saved.phones.count == made.phones.count && Set(made.groups).isSubset(of: Set(saved.groups))
                }
            case "delete":
                guard let card = try target(change.id, image: true) else {
                    return reconcile ? ChangeResult(key: change.key, op: change.op, status: "replayed", id: change.id, reason: nil) : skip(change, "card_missing")
                }
                guard card.writable else { return skip(change, "card_linked") }
                guard let expect = change.expect, !expect.isEmpty, matches(card.card, expect) else { return skip(change, "card_changed") }
                return try commit(change, .delete(id: card.card.id), intent: row(change, phase: "intent", id: card.card.id, before: card.card)) { $0 == nil }
            case "merge":
                guard let keep = try target(change.id), let gone = try target(change.from, image: true), keep.card.id != gone.card.id else { return skip(change, "card_missing") }
                guard keep.writable, gone.writable else { return skip(change, "card_linked") }
                var uncarried: [String] = []
                func carry<T: Equatable>(_ name: String, _ path: KeyPath<FullCard, T>, _ empty: T) {
                    if gone.card[keyPath: path] != empty && gone.card[keyPath: path] != keep.card[keyPath: path] { uncarried.append(name) }
                }
                carry("name_prefix", \.namePrefix, ""); carry("middle_name", \.middleName, ""); carry("previous_family_name", \.previousFamilyName, "")
                carry("name_suffix", \.nameSuffix, ""); carry("phonetic_given_name", \.phoneticGivenName, ""); carry("phonetic_middle_name", \.phoneticMiddleName, "")
                carry("phonetic_family_name", \.phoneticFamilyName, ""); carry("phonetic_organization_name", \.phoneticOrganizationName, ""); carry("department", \.department, "")
                carry("urls", \.urls, []); carry("postal_addresses", \.postal, []); carry("dates", \.dates, []); carry("relations", \.relations, [])
                carry("social_profiles", \.social, []); carry("instant_messages", \.instantMessages, []); carry("birthday", \.birthday, nil); carry("non_gregorian_birthday", \.nonGregorianBirthday, nil); carry("photo", \.imageData, nil)
                guard uncarried.isEmpty else {
                    return skip(change, "bad_change: merge can't carry the other card's " + uncarried.joined(separator: ", ") + "; nothing was changed (this helper can't read notes, so a note on that card isn't checked)")
                }
                func sub(_ op: String, _ edit: CardEdit, field: String? = nil, value: String? = nil, label: String? = nil, group: String? = nil, prior: String? = nil,
                         before: FullCard? = nil, check: @escaping (FullCard?) -> Bool) throws {
                    let what = [op, field ?? "", value ?? "", group ?? ""].joined(separator: "\u{0}")
                    let step = SHA256.hash(data: Data(what.utf8)).map { String(format: "%02x", $0) }.joined().prefix(16)
                    let part = ChangeRequest(key: change.key + "." + String(step), op: op, id: nil, from: nil, field: field, value: value, label: label, group: group,
                                             fields: nil, expect: nil)
                    if index[part.key]?.phase == "done" { return }
                    let target = op == "delete" ? gone.card.id : keep.card.id
                    let result = try commit(part, edit, intent: row(part, phase: "intent", id: target, prior: prior, before: before), check: check)
                    guard result.status == "applied" else { throw Failure(code: "readback_mismatch") }
                }
                var conflicts: [String] = []
                for field in ScalarField.allCases {
                    let mine = field.get(keep.card), theirs = field.get(gone.card)
                    guard !theirs.isEmpty, mine != theirs else { continue }
                    if mine.isEmpty {
                        try sub("fill", .setField(id: keep.card.id, field: field, value: theirs), field: field.rawValue, value: theirs, prior: "") { field.get($0 ?? FullCard()) == theirs }
                    } else {
                        conflicts.append(field.rawValue)
                    }
                }
                for field in [ListField.emails, .phones] {
                    for entry in field.values(gone.card) where !field.holds(keep.card, entry.value, countryCode: country) {
                        try sub("add_value", .addValue(id: keep.card.id, field: field, label: entry.label, value: entry.value), field: field.rawValue, value: entry.value,
                                label: entry.label) { field.holds($0 ?? FullCard(), entry.value, countryCode: self.country) }
                    }
                }
                for group in gone.card.groups where !keep.card.groups.contains(group) {
                    try sub("group_add", .addToGroup(id: keep.card.id, group: group, create: false), group: group) { $0?.groups.contains(group) == true }
                }
                try sub("delete", .delete(id: gone.card.id), before: gone.card) { $0 == nil }
                var done = row(change, phase: "done", id: keep.card.id, reason: conflicts.isEmpty ? nil : "kept this card's " + conflicts.joined(separator: ", "))
                done.before = nil
                try writer.append(done, to: journalPath)
                index[change.key] = done
                return ChangeResult(key: change.key, op: change.op, status: "applied", id: keep.card.id, reason: done.reason)
            default:
                return skip(change, "bad_change: unknown op")
            }
        }
    }
}
