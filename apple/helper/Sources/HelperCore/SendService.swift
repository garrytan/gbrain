import Foundation
import Security

public enum SendReply {
    case ok(HTTPResponse)
    case problem(Problem)
}

struct SendResult: Encodable {
    let outcome: String
    let code: String
    let retryable: Bool
    let sideEffects: String
    let replayed: Bool
    let guid: String?
    let rowid: Int64?
    let idempotencyKey: String
}

struct SendStatus: Encodable {
    let send: String
    let keys: [String]
    let limits: SendLimits
    let automation: String?
    let banners: Bool?
}

public struct SendClock {
    public let now: () -> Date
    public let sleep: (TimeInterval) -> Void

    public init(now: @escaping () -> Date = Date.init, sleep: @escaping (TimeInterval) -> Void = { Thread.sleep(forTimeInterval: $0) }) {
        self.now = now
        self.sleep = sleep
    }
}

public final class SendService {
    public static let adminRoute = "/v1/admin/send"
    static let preDispatch: [Int: Problem] = [-1743: .automationDenied, -1744: .automationDenied, -600: .messagesUnavailable, -1728: .recipientNotIMessage]

    let store: SendStateStore
    let switchedOn: () -> Bool
    let audit: SendAudit
    let messages: MessagesPort
    let ledger: DeliveryLedger
    let banner: Banner
    let presence: OwnerPresence
    let clock: SendClock
    let confirmWindow: TimeInterval
    let pollInterval: TimeInterval
    let nonces = NonceCache()
    let queue = DispatchQueue(label: "io.gbrain.apple-helper.send")
    let lock = NSLock()
    let stateLock: NSRecursiveLock
    var adminSaves = 0
    var stops = Stops()
    var inflight = Set<String>()
    var lastRetention: Date?

    public init(store: SendStateStore, switchedOn: @escaping () -> Bool, audit: SendAudit, messages: MessagesPort, ledger: DeliveryLedger,
                banner: Banner, presence: OwnerPresence, clock: SendClock = SendClock(), confirmWindow: TimeInterval = 30, pollInterval: TimeInterval = 0.5,
                stateLock: NSRecursiveLock = NSRecursiveLock()) {
        self.store = store
        self.stateLock = stateLock
        self.switchedOn = switchedOn
        self.audit = audit
        self.messages = messages
        self.ledger = ledger
        self.banner = banner
        self.presence = presence
        self.clock = clock
        self.confirmWindow = confirmWindow
        self.pollInterval = pollInterval
    }

    public func start() {
        if var state = try? store.load() { observeKill(&state) }
        queue.sync {
            let now = clock.now()
            audit.applyRetention(now: now)
            lastRetention = now
            audit.load(now: now)
            for (key, entry) in audit.entries where entry.outcome == nil {
                _ = resolve(key: key, entry: entry)
            }
        }
    }

    func fail(_ problem: Problem) -> SendReply {
        .problem(problem.sideEffects == nil ? problem.with() : problem)
    }

    func observeKill(_ state: inout SendState) {
        guard state.enabled, !switchedOn() else { return }
        stateLock.lock()
        defer { stateLock.unlock() }
        do {
            state = try store.load() ?? state
            guard state.enabled, !switchedOn() else { return }
            state.enabled = false
            defer { bump(nil) }
            try store.save(state)
        } catch {
            Log.line("send: could not record that the config switch turned sending off")
        }
    }

    public func handle(_ request: HTTPRequest, peer: UInt32) -> SendReply {
        let now = clock.now()
        let seen = currentStops()
        var state: SendState
        do {
            state = try store.load() ?? SendState()
        } catch {
            return fail((error as? Problem) ?? .sendKeysUnreadable)
        }
        observeKill(&state)
        guard state.enabled, switchedOn() else { return fail(.sendDisabled) }
        let idempotencyKey = request.headers["idempotency-key"] ?? ""
        guard SendSignature.validIdempotencyKey(idempotencyKey) else { return fail(.idempotencyKeyRequired) }
        guard let signature = SendSignature.parse(request.headers["authorization"]) else { return fail(.signatureInvalid) }
        guard let key = state.keys.first(where: { $0.name == signature.keyName }), let raw = key.rawKey else { return fail(.unknownSendKey) }
        let serverTime = Int(now.timeIntervalSince1970)
        guard abs(serverTime - signature.timestamp) <= SendSignature.maxSkew else { return fail(.timestampSkew(serverTime: serverTime)) }
        guard signature.verifies(publicKey: raw, idempotencyKey: idempotencyKey, body: request.body) else { return fail(.signatureInvalid) }
        guard nonces.claim(signature.nonce, now: now) else { return fail(.nonceReplayed) }
        let send: SendRequest
        do {
            send = try SendRequest.parse(request.body)
        } catch {
            return fail((error as? Problem) ?? .badParam("bad body"))
        }
        lock.lock()
        let busy = !inflight.insert(idempotencyKey).inserted
        lock.unlock()
        if busy { return fail(.sendInProgress) }
        defer {
            lock.lock()
            inflight.remove(idempotencyKey)
            lock.unlock()
        }
        return queue.sync { serially(send, key: idempotencyKey, signer: key, peer: peer, seen: seen) }
    }

    func serially(_ send: SendRequest, key: String, signer: SendKey, peer: UInt32, seen: Stops) -> SendReply {
        let limits: SendLimits
        let hashKey: [UInt8]
        do {
            (limits, hashKey) = try locked { () throws -> (SendLimits, [UInt8]) in
                var state = try allowed(signer, since: seen)
                return (state.limits, try recipientKey(&state))
            }
        } catch {
            return fail((error as? Problem) ?? .sendKeysUnreadable)
        }
        var now = clock.now()
        if let last = lastRetention, now.timeIntervalSince(last) > 86400 {
            audit.applyRetention(now: now)
            lastRetention = now
        }
        let hash = send.canonicalHash
        if let entry = audit.replayable(key, now: now) {
            guard entry.pending.hash == hash else {
                let first = entry.outcome?.outcome
                let effects = first == Outcome.sent ? SideEffects.sent : first == Outcome.failedAfterSubmit ? SideEffects.none : SideEffects.possible
                return fail(Problem.idempotencyConflict.with(sideEffects: effects))
            }
            return respond(resolve(key: key, entry: entry), key: key, replayed: true)
        }
        let firstContact: Bool
        let highWater: Int64
        do {
            firstContact = !(try ledger.hasOneToOneHistory(with: send.to))
            highWater = try ledger.highWater()
        } catch {
            return fail(Problem.from(error, dbPath: Config.defaultDBPath))
        }
        if let limited = rateProblem(send.to, firstContact: firstContact, limits: limits, hashKey: hashKey, now: now) { return fail(limited) }
        var pending = AuditRecord(t: SendAudit.stamp(now), kind: "pending", key: key)
        pending.hash = hash
        pending.keyName = signer.name
        pending.peer = IPv4.string(peer)
        pending.to = send.to
        pending.toHash = Recipient.hash(send.to, key: hashKey)
        pending.text = send.text
        pending.requestedBy = send.requestedBy
        pending.ownerInstruction = send.ownerInstruction
        pending.firstContact = firstContact
        pending.highWater = highWater
        do {
            try audit.append(pending, now: now)
        } catch {
            return fail(.auditUnavailable)
        }
        let dispatch: DispatchResult
        switch messages.prepare(askPermission: false) {
        case .ready:
            let handed = messages.handOver {
                locked { () -> Result<DispatchResult, Problem> in
                    do {
                        _ = try allowed(signer, since: seen)
                    } catch {
                        return .failure((error as? Problem) ?? .sendKeysUnreadable)
                    }
                    return .success(messages.send(text: send.text, to: send.to))
                }
            }
            switch handed {
            case .success(let result): dispatch = result
            case .failure(let stopped): return refuse(stopped, error: nil, pending: pending)
            }
        case .automationDenied:
            return refuse(.automationDenied, error: -1743, pending: pending)
        case .signedOut:
            return refuse(.messagesSignedOut, error: nil, pending: pending)
        case .unavailable:
            return refuse(.messagesUnavailable, error: -600, pending: pending)
        case .failed(let number):
            return refuse(Self.preDispatch[number] ?? .sendFailed(number), error: Int64(number), pending: pending)
        }
        var guid: String?
        switch dispatch {
        case .submitted(let returned):
            guid = returned
        case .error(let number):
            if let problem = Self.preDispatch[number] { return refuse(problem, error: Int64(number), pending: pending) }
            return record(.unknownOutcome(error: Int64(number)), pending: pending)
        }
        let deadline = clock.now().addingTimeInterval(confirmWindow)
        let claimed = claimedGuids(except: key)
        var delivery = Delivery.pending
        while true {
            delivery = (try? ledger.delivery(after: highWater, to: send.to, text: send.text, guid: guid, sentBy: nil, skipping: claimed)) ?? .pending
            now = clock.now()
            guard delivery == .pending, now < deadline else { break }
            clock.sleep(pollInterval)
        }
        return record(.from(delivery), pending: pending)
    }

    func allowed(_ signer: SendKey, since seen: Stops) throws -> SendState {
        var state = try store.load() ?? SendState()
        observeKill(&state)
        let now = currentStops()
        guard state.enabled, switchedOn(), now.all == seen.all else { throw Problem.sendDisabled }
        guard state.keys.contains(signer), now.keys[signer.name] == seen.keys[signer.name] else { throw Problem.unknownSendKey }
        return state
    }

    func currentStops() -> Stops {
        lock.lock()
        defer { lock.unlock() }
        return stops
    }

    func bump(_ keyName: String?) {
        lock.lock()
        defer { lock.unlock() }
        if let keyName { stops.keys[keyName, default: 0] += 1 } else { stops.all += 1 }
    }

    func recipientKey(_ state: inout SendState) throws -> [UInt8] {
        stateLock.lock()
        defer { stateLock.unlock() }
        if state.recipientHashKey == nil { state = try store.load() ?? state }
        if state.recipientHashKey != nil {
            guard let key = state.recipientKey else { throw Problem.sendKeysTampered }
            return key
        }
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw Problem.sendKeysUnreadable }
        state.recipientHashKey = Base64URL.encode(bytes)
        try store.save(state)
        return bytes
    }

    func rateProblem(_ recipient: String, firstContact: Bool, limits: SendLimits, hashKey: [UInt8], now: Date) -> Problem? {
        let day = audit.attempts(since: now.addingTimeInterval(-86400))
        func check(_ window: TimeInterval, _ cap: Int, _ what: String, _ filter: (AuditRecord) -> Bool) -> Problem? {
            let inWindow = day.filter { ($0.date ?? .distantPast) > now.addingTimeInterval(-window) && filter($0) }
            guard inWindow.count >= cap else { return nil }
            let oldest = inWindow.compactMap(\.date).min() ?? now
            let wait = max(1, Int((oldest.addingTimeInterval(window).timeIntervalSince(now)).rounded(.up)))
            return .sendRateLimited("The limit of \(cap) \(what) is reached.", retryAfter: wait)
        }
        return check(60, limits.maxPerMinute, "texts a minute") { _ in true }
            ?? check(3600, limits.maxPerHour, "texts an hour") { _ in true }
            ?? check(86400, limits.maxPerDay, "texts a day") { _ in true }
            ?? check(3600, limits.maxPerRecipientPerHour, "texts an hour to one recipient") { $0.to == recipient || $0.toHash == Recipient.hash(recipient, key: hashKey) }
            ?? (firstContact ? check(86400, limits.maxFirstContactPerDay, "texts a day to people never texted one-to-one before") { $0.firstContact == true } : nil)
    }

    enum Final {
        case sent(guid: String, rowid: Int64)
        case failedAfterSubmit(error: Int64, guid: String, rowid: Int64)
        case unknownOutcome(error: Int64?)

        static func from(_ delivery: Delivery) -> Final {
            switch delivery {
            case .sent(let guid, let rowid): return .sent(guid: guid, rowid: rowid)
            case .failed(let error, let guid, let rowid): return .failedAfterSubmit(error: error, guid: guid, rowid: rowid)
            case .pending: return .unknownOutcome(error: nil)
            }
        }

        static func from(_ record: AuditRecord) -> Final {
            switch record.outcome {
            case Outcome.sent: return .sent(guid: record.guid ?? "", rowid: record.rowid ?? 0)
            case Outcome.failedAfterSubmit: return .failedAfterSubmit(error: record.error ?? 0, guid: record.guid ?? "", rowid: record.rowid ?? 0)
            default: return .unknownOutcome(error: record.error)
            }
        }
    }

    func refuse(_ problem: Problem, error: Int64?, pending: AuditRecord) -> SendReply {
        var outcome = AuditRecord(t: SendAudit.stamp(clock.now()), kind: "outcome", key: pending.key)
        outcome.outcome = Outcome.failed
        outcome.code = problem.code
        outcome.error = error
        outcome.toHash = pending.toHash
        write(outcome)
        banner.post("\(HelperIdentity.appName) could not send a text to \(pending.to ?? "a recipient").")
        return fail(problem)
    }

    func record(_ final: Final, pending: AuditRecord) -> SendReply {
        write(outcomeRecord(final, pending: pending))
        switch final {
        case .sent: banner.post("\(HelperIdentity.appName) sent a text to \(pending.to ?? "a recipient").")
        case .failedAfterSubmit: banner.post("\(HelperIdentity.appName) could not send a text to \(pending.to ?? "a recipient").")
        case .unknownOutcome: banner.post("\(HelperIdentity.appName) may have sent a text to \(pending.to ?? "a recipient"); it could not confirm.")
        }
        return respond(final, key: pending.key, replayed: false)
    }

    func outcomeRecord(_ final: Final, pending: AuditRecord) -> AuditRecord {
        var outcome = AuditRecord(t: SendAudit.stamp(clock.now()), kind: "outcome", key: pending.key)
        outcome.toHash = pending.toHash
        switch final {
        case .sent(let guid, let rowid):
            outcome.outcome = Outcome.sent
            outcome.guid = guid
            outcome.rowid = rowid
        case .failedAfterSubmit(let error, let guid, let rowid):
            outcome.outcome = Outcome.failedAfterSubmit
            outcome.code = "failed_after_submit"
            outcome.error = error
            outcome.guid = guid
            outcome.rowid = rowid
        case .unknownOutcome(let error):
            outcome.outcome = Outcome.unknown
            outcome.error = error
        }
        return outcome
    }

    func write(_ record: AuditRecord) {
        do {
            try audit.append(record, now: clock.now())
        } catch {
            Log.line("send audit: outcome held in memory until the log is writable")
        }
    }

    func resolve(key: String, entry: AuditEntry) -> Final {
        if let outcome = entry.outcome, outcome.outcome != Outcome.unknown { return Final.from(outcome) }
        let pending = entry.pending
        guard let to = pending.to, let text = pending.text, let highWater = pending.highWater,
              let delivery = try? ledger.delivery(after: highWater, to: to, text: text, guid: nil, sentBy: pending.date?.addingTimeInterval(confirmWindow + 60),
                                                  skipping: claimedGuids(except: key)), delivery != .pending else {
            if entry.outcome == nil { write(outcomeRecord(.unknownOutcome(error: nil), pending: pending)) }
            return entry.outcome.map(Final.from) ?? .unknownOutcome(error: nil)
        }
        let final = Final.from(delivery)
        write(outcomeRecord(final, pending: pending))
        return final
    }

    func claimedGuids(except key: String) -> Set<String> {
        Set(audit.entries.compactMap { $0.key == key ? nil : $0.value.outcome?.guid }.filter { !$0.isEmpty })
    }

    func respond(_ final: Final, key: String, replayed: Bool) -> SendReply {
        switch final {
        case .sent(let guid, let rowid):
            return .ok(.json(200, SendResult(outcome: Outcome.sent, code: Outcome.sent, retryable: false, sideEffects: SideEffects.sent, replayed: replayed,
                                                  guid: guid, rowid: rowid, idempotencyKey: key)))
        case .failedAfterSubmit(let error, _, _):
            return fail(Problem.failedAfterSubmit(error).with(outcome: Outcome.failedAfterSubmit, replayed: replayed))
        case .unknownOutcome:
            return .ok(.json(202, SendResult(outcome: Outcome.unknown, code: Outcome.unknown, retryable: true, sideEffects: SideEffects.possible,
                                                  replayed: replayed, guid: nil, rowid: nil, idempotencyKey: key)))
        }
    }

    public func admin(_ request: HTTPRequest) -> SendReply {
        guard let fields = StrictJSON.flatObject(request.body), let action = fields["action"] else {
            return .problem(.badParam("the body must be a JSON object with an action"))
        }
        var automation: String?
        var banners: Bool?
        if action == "setup" {
            switch messages.prepare(askPermission: true) {
            case .ready: automation = "allowed"
            case .automationDenied: automation = "denied"
            case .signedOut: automation = "allowed_signed_out"
            case .unavailable: automation = "messages_unavailable"
            case .failed(let number): automation = "error_\(number)"
            }
            banners = banner.requestAuthorization()
        }
        do {
            let first = try locked { () throws -> (change: (state: SendState, reason: String?, save: Bool), seen: SendState, saves: Int) in
                var current = try store.load() ?? SendState()
                observeKill(&current)
                defer { if action == "off" { bump(nil) } }
                let change = try Self.change(action, fields, current)
                defer { if action == "remove_key", let name = fields["name"] { bump(name) } }
                if change.reason == nil, change.save {
                    try store.save(change.state)
                    adminSaves += 1
                }
                return (change, current, adminSaves)
            }
            var state = first.change.state
            if let reason = first.change.reason {
                try confirm(reason)
                state = try locked { () throws -> SendState in
                    var current = try store.load() ?? SendState()
                    observeKill(&current)
                    guard current.enabled || !first.change.state.enabled || switchedOn() else { throw Problem.sendDisabled }
                    guard current == first.seen, adminSaves == first.saves else { throw Problem.overloaded }
                    if first.change.save {
                        try store.save(first.change.state)
                        adminSaves += 1
                    }
                    return first.change.state
                }
            }
            let status = SendStatus(send: state.enabled && switchedOn() ? "on" : "off", keys: state.keys.map(\.name).sorted(), limits: state.limits,
                                    automation: automation, banners: banners)
            return .ok(.json(200, status))
        } catch {
            return .problem((error as? Problem) ?? .internalError)
        }
    }

    struct Stops: Equatable {
        var all = 0
        var keys: [String: Int] = [:]
    }

    func locked<T>(_ body: () throws -> T) rethrows -> T {
        stateLock.lock()
        defer { stateLock.unlock() }
        return try body()
    }

    static func change(_ action: String, _ fields: [String: String], _ state: SendState) throws -> (state: SendState, reason: String?, save: Bool) {
        var next = state
        switch action {
        case "status":
            return (next, nil, false)
        case "setup":
            guard !state.enabled else { return (next, nil, false) }
            next.enabled = true
            return (next, "turn on sending iMessages for your agent", true)
        case "off":
            next.enabled = false
            return (next, nil, true)
        case "add_key":
            guard let name = fields["name"], !name.isEmpty, name.count <= 64,
                  name.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || "._-".contains($0)) }),
                  let encoded = fields["public_key"] else {
                throw Problem.badParam("add_key needs name (letters, digits, dot, underscore, hyphen) and public_key")
            }
            let key = SendKey(name: name, publicKey: Base64URL.encode(publicKeyBytes(encoded) ?? []))
            guard key.rawKey != nil else { throw Problem.badParam("public_key must be a 32-byte Ed25519 public key in base64 or base64url") }
            next.keys.removeAll { $0.name == name }
            next.keys.append(key)
            return (next, "add the send key \(name) (\(key.fingerprint)) so it can send iMessages as you", true)
        case "remove_key":
            guard let name = fields["name"], state.keys.contains(where: { $0.name == name }) else { throw Problem.notFound }
            next.keys.removeAll { $0.name == name }
            return (next, nil, true)
        case "set_limits":
            var raised = false
            for (name, text) in fields where name != "action" {
                guard let current = state.limits.value(name), let value = Int(text), (0...1000).contains(value) else {
                    throw Problem.badParam("unknown limit or bad value: \(name)")
                }
                raised = raised || value > current
                next.limits.set(name, value)
            }
            return (next, raised ? "raise the limits on iMessages your agent can send" : nil, true)
        default:
            throw Problem.badParam("unknown action \(action)")
        }
    }

    func confirm(_ reason: String) throws {
        guard presence.confirm(reason: reason) == .confirmed else { throw Problem.ownerPresenceUnavailable }
    }

    static func publicKeyBytes(_ encoded: String) -> [UInt8]? {
        let trimmed = encoded.trimmingCharacters(in: .whitespacesAndNewlines)
        if let bytes = Base64URL.decode(trimmed.replacingOccurrences(of: "=", with: "")) { return bytes }
        return Data(base64Encoded: trimmed).map(Array.init)
    }
}
