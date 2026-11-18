import Foundation

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
    let stateLock = NSRecursiveLock()
    var inflight = Set<String>()
    var lastRetention: Date?

    public init(store: SendStateStore, switchedOn: @escaping () -> Bool, audit: SendAudit, messages: MessagesPort, ledger: DeliveryLedger,
                banner: Banner, presence: OwnerPresence, clock: SendClock = SendClock(), confirmWindow: TimeInterval = 30, pollInterval: TimeInterval = 0.5) {
        self.store = store
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
            try store.save(state)
        } catch {
            Log.line("send: could not record that the config switch turned sending off")
        }
    }

    public func handle(_ request: HTTPRequest, peer: UInt32) -> SendReply {
        let now = clock.now()
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
        return queue.sync { serially(send, key: idempotencyKey, signer: key, peer: peer) }
    }

    func serially(_ send: SendRequest, key: String, signer: SendKey, peer: UInt32) -> SendReply {
        let limits: SendLimits
        do {
            var state = try store.load() ?? SendState()
            observeKill(&state)
            guard state.enabled, switchedOn() else { return fail(.sendDisabled) }
            guard state.keys.contains(signer) else { return fail(.unknownSendKey) }
            limits = state.limits
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
        if let limited = rateProblem(send.to, firstContact: firstContact, limits: limits, now: now) { return fail(limited) }
        var pending = AuditRecord(t: SendAudit.stamp(now), kind: "pending", key: key)
        pending.hash = hash
        pending.keyName = signer.name
        pending.peer = IPv4.string(peer)
        pending.to = send.to
        pending.toHash = Recipient.hash(send.to)
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
            dispatch = messages.send(text: send.text, to: send.to)
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

    func rateProblem(_ recipient: String, firstContact: Bool, limits: SendLimits, now: Date) -> Problem? {
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
            ?? check(3600, limits.maxPerRecipientPerHour, "texts an hour to one recipient") { $0.to == recipient || $0.toHash == Recipient.hash(recipient) }
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
        stateLock.lock()
        defer { stateLock.unlock() }
        do {
            var state = try store.load() ?? SendState()
            observeKill(&state)
            var automation: String?
            var banners: Bool?
            switch action {
            case "status":
                break
            case "setup":
                switch messages.prepare(askPermission: true) {
                case .ready: automation = "allowed"
                case .automationDenied: automation = "denied"
                case .signedOut: automation = "allowed_signed_out"
                case .unavailable: automation = "messages_unavailable"
                case .failed(let number): automation = "error_\(number)"
                }
                banners = banner.requestAuthorization()
                if !state.enabled {
                    try confirm("turn on sending iMessages for your agent")
                    state.enabled = true
                    try store.save(state)
                }
            case "off":
                state.enabled = false
                try store.save(state)
            case "add_key":
                guard let name = fields["name"], !name.isEmpty, name.count <= 64,
                      name.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || "._-".contains($0)) }),
                      let encoded = fields["public_key"] else {
                    throw Problem.badParam("add_key needs name (letters, digits, dot, underscore, hyphen) and public_key")
                }
                let key = SendKey(name: name, publicKey: Base64URL.encode(Self.publicKeyBytes(encoded) ?? []))
                guard key.rawKey != nil else { throw Problem.badParam("public_key must be a 32-byte Ed25519 public key in base64 or base64url") }
                try confirm("add the send key \(name) (\(key.fingerprint)) so it can send iMessages as you")
                state.keys.removeAll { $0.name == name }
                state.keys.append(key)
                try store.save(state)
            case "remove_key":
                guard let name = fields["name"], state.keys.contains(where: { $0.name == name }) else { throw Problem.notFound }
                state.keys.removeAll { $0.name == name }
                try store.save(state)
            case "set_limits":
                var raised = false
                for (name, text) in fields where name != "action" {
                    guard let current = state.limits.value(name), let value = Int(text), (0...1000).contains(value) else {
                        throw Problem.badParam("unknown limit or bad value: \(name)")
                    }
                    raised = raised || value > current
                    state.limits.set(name, value)
                }
                if raised { try confirm("raise the limits on iMessages your agent can send") }
                try store.save(state)
            default:
                throw Problem.badParam("unknown action \(action)")
            }
            let status = SendStatus(send: state.enabled && switchedOn() ? "on" : "off", keys: state.keys.map(\.name).sorted(), limits: state.limits,
                                    automation: automation, banners: banners)
            return .ok(.json(200, status))
        } catch {
            return .problem((error as? Problem) ?? .internalError)
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
