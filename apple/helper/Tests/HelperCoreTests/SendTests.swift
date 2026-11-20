import CryptoKit
import Foundation
import Testing
@testable import HelperCore

let boxSeed = Array(1...32).map { UInt8($0) }
let boxKey = try! Curve25519.Signing.PrivateKey(rawRepresentation: boxSeed)
let boxPublic = Base64URL.encode(Array(boxKey.publicKey.rawRepresentation))
let sendPeer = IPv4.parse("100.102.0.7")!

final class MemoryStore: SendStateStore {
    let lock = NSLock()
    var state: SendState?
    var saves = 0
    var failure: Problem?
    var saveFailure: Problem?
    var saving: DispatchSemaphore?
    var saveGate: DispatchSemaphore?
    init(_ state: SendState?) { self.state = state }
    func load() throws -> SendState? {
        lock.lock()
        defer { lock.unlock() }
        if let failure { throw failure }
        return state
    }
    func save(_ state: SendState) throws {
        saving?.signal()
        lock.lock()
        let gate = saveGate
        lock.unlock()
        gate?.wait()
        lock.lock()
        defer { lock.unlock() }
        if let saveFailure { throw saveFailure }
        self.state = state
        saves += 1
    }
    func release() {
        lock.lock()
        let gate = saveGate
        saveGate = nil
        lock.unlock()
        gate?.signal()
    }
}

final class WatchedLock: NSRecursiveLock, @unchecked Sendable {
    var waiting: DispatchSemaphore?
    override func lock() {
        waiting?.signal()
        super.lock()
    }
}

final class FakeMessages: MessagesPort {
    let lock = NSLock()
    var prepareResult = PrepareResult.ready
    var dispatch: DispatchResult = .submitted(guid: nil)
    var sent: [(String, String)] = []
    var askedPermission = false
    var gate: DispatchSemaphore?
    var onSend: ((String, String) -> Void)?
    var preparing: DispatchSemaphore?
    var prepareGate: DispatchSemaphore?
    var handingOver: DispatchSemaphore?
    var handOverGate: DispatchSemaphore?

    func handOver<T>(_ body: () -> T) -> T {
        handingOver?.signal()
        handOverGate?.wait()
        return body()
    }

    func prepare(askPermission: Bool) -> PrepareResult {
        if askPermission {
            askedPermission = true
        } else {
            preparing?.signal()
            prepareGate?.wait()
        }
        return prepareResult
    }

    func send(text: String, to recipient: String) -> DispatchResult {
        lock.lock()
        sent.append((text, recipient))
        lock.unlock()
        gate?.wait()
        onSend?(text, recipient)
        return dispatch
    }

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return sent.count
    }
}

final class FakeLedger: DeliveryLedger {
    var mark: Int64 = 100
    var result = Delivery.sent(guid: "GUID-101", rowid: 101)
    var history = Set<String>()
    var failing = false
    var lookups: [Int64] = []
    var bounds: [Date?] = []

    func highWater() throws -> Int64 {
        if failing { throw DBError.noAccess }
        return mark
    }

    func delivery(after highWater: Int64, to recipient: String, text: String, guid: String?, sentBy: Date?, skipping: Set<String>) throws -> Delivery {
        lookups.append(highWater)
        bounds.append(sentBy)
        return result
    }

    func hasOneToOneHistory(with recipient: String) throws -> Bool {
        if failing { throw DBError.noAccess }
        return history.contains(recipient)
    }
}

final class FakeBanner: Banner {
    var posts: [String] = []
    func post(_ text: String) { posts.append(text) }
    func requestAuthorization() -> Bool { true }
}

final class FakePresence: OwnerPresence {
    var answer = Presence.confirmed
    var reasons: [String] = []
    var gate: DispatchSemaphore?
    var entered: DispatchSemaphore?
    func confirm(reason: String) -> Presence {
        reasons.append(reason)
        entered?.signal()
        gate?.wait()
        return answer
    }
}

final class Clock {
    var now = Date(timeIntervalSince1970: 1_795_000_000)
    var clock: SendClock { SendClock(now: { self.now }, sleep: { self.now = self.now.addingTimeInterval($0) }) }
}

final class Harness {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("helper-send-\(UUID().uuidString)").path
    let store: MemoryStore
    let messages = FakeMessages()
    let ledger = FakeLedger()
    let banner = FakeBanner()
    let presence = FakePresence()
    let clock = Clock()
    var switchedOn = true
    lazy var audit = SendAudit(directory: directory)
    let lock = WatchedLock()
    lazy var service = SendService(store: store, switchedOn: { self.switchedOn }, audit: audit, messages: messages, ledger: ledger, banner: banner,
                                   presence: presence, clock: clock.clock, confirmWindow: 30, pollInterval: 0.5, stateLock: lock)

    init(limits: SendLimits = SendLimits(), enabled: Bool = true) {
        store = MemoryStore(SendState(enabled: enabled, keys: [SendKey(name: "box", publicKey: boxPublic)], limits: limits))
    }

    deinit { try? FileManager.default.removeItem(atPath: directory) }

    func body(to: String = "+15550100", text: String = "Running late", instruction: String = "tell alice-example I'm late") -> String {
        "{\"to\":\(StrictJSON.quote(to)),\"text\":\(StrictJSON.quote(text)),\"requested_by\":\"owner\",\"owner_instruction\":\(StrictJSON.quote(instruction))}"
    }

    func request(_ body: String, key: String = "owner-msg-0001", nonce: String? = nil, ts: Int? = nil, signer: Curve25519.Signing.PrivateKey = boxKey,
                 keyName: String = "box", authorization: String? = nil) -> HTTPRequest {
        let bytes = Array(body.utf8)
        let timestamp = ts ?? Int(clock.now.timeIntervalSince1970)
        let once = nonce ?? String(format: "%032llx", UInt64.random(in: 0...UInt64.max))
        let canonical = SendSignature.canonical(timestamp: timestamp, nonce: once, idempotencyKey: key, body: bytes)
        let sig = Base64URL.encode(Array(try! signer.signature(for: Data(canonical.utf8))))
        let header = authorization ?? "GBrain-Sign key=\(keyName), ts=\(timestamp), nonce=\(once), sig=\(sig)"
        return HTTPRequest(method: "POST", path: SendSignature.route, query: [:],
                           headers: ["authorization": header, "idempotency-key": key, "content-length": String(bytes.count)], body: bytes)
    }

    func send(_ request: HTTPRequest) -> (status: Int, json: [String: Any]) {
        let response: HTTPResponse
        switch service.handle(request, peer: sendPeer) {
        case .ok(let ok): response = ok
        case .problem(let problem): response = .problem(problem, requestId: "t")
        }
        return (response.status, (try? JSONSerialization.jsonObject(with: Data(response.body))) as? [String: Any] ?? [:])
    }

    func auditLines() -> [AuditRecord] {
        audit.monthFiles().flatMap { audit.read($0, repair: false) }
    }
}

@Suite struct SendSignatureTests {
    struct Vectors: Decodable {
        struct Vector: Decodable {
            let idempotencyKey: String
            let timestamp: Int
            let nonce: String
            let body: String
            let canonical: String
            let authorization: String
        }
        let seed_hex: String
        let public_key: String
        let vectors: [Vector]
    }

    @Test func verifiesTheVectorsGbrainSigns() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/send-sign-vectors.json")
        let fixture = try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
        #expect(fixture.public_key == boxPublic)
        for vector in fixture.vectors {
            let body = Array(vector.body.utf8)
            #expect(SendSignature.canonical(timestamp: vector.timestamp, nonce: vector.nonce, idempotencyKey: vector.idempotencyKey, body: body) == vector.canonical)
            let signature = try #require(SendSignature.parse(vector.authorization))
            #expect(signature.keyName == "box")
            #expect(signature.verifies(publicKey: Base64URL.decode(fixture.public_key)!, idempotencyKey: vector.idempotencyKey, body: body))
            #expect(!signature.verifies(publicKey: Base64URL.decode(fixture.public_key)!, idempotencyKey: vector.idempotencyKey, body: body + [0x20]))
            #expect(!signature.verifies(publicKey: Base64URL.decode(fixture.public_key)!, idempotencyKey: vector.idempotencyKey + "x", body: body))
        }
    }

    @Test func refusesMalformedHeaders() {
        let good = "GBrain-Sign key=box, ts=1, nonce=\(String(repeating: "a", count: 32)), sig=\(Base64URL.encode(Array(repeating: 1, count: 64)))"
        #expect(SendSignature.parse(good) != nil)
        for bad in [nil, "Bearer x", good.replacingOccurrences(of: "ts=1", with: "ts=-1"), good.replacingOccurrences(of: "nonce=a", with: "nonce=A"),
                    good + ", key=other", good.replacingOccurrences(of: "sig=", with: "sig=AA"), "GBrain-Sign key=box"] {
            #expect(SendSignature.parse(bad) == nil)
        }
        #expect(SendSignature.validIdempotencyKey("abc.DEF_12-3"))
        #expect(!SendSignature.validIdempotencyKey("short"))
        #expect(!SendSignature.validIdempotencyKey("has space 12"))
        #expect(!SendSignature.validIdempotencyKey("ünïcode-key"))
    }
}

@Suite struct SendRequestTests {
    @Test func parsesOneFlatObjectStrictly() throws {
        let ok = try SendRequest.parse(Array(#"{"to":"+1 555 010 0100","text":"hi \"there\" \\ \u00e9","requested_by":"owner","owner_instruction":"say hi"}"#.utf8))
        #expect(ok.to == "+15550100100")
        #expect(ok.text == "hi \"there\" \\ é")
        let bad = [
            #"{"to":"+15550100","text":"hi","requested_by":"owner","owner_instruction":"x","extra":"y"}"#,
            #"{"to":"+15550100","to":"+15550111","text":"hi","requested_by":"owner","owner_instruction":"x"}"#,
            #"{"to":"+15550100","text":1,"requested_by":"owner","owner_instruction":"x"}"#,
            #"{"to":"+15550100","text":"hi","requested_by":"owner"}"#,
            #"{"to":"5550100","text":"hi","requested_by":"owner","owner_instruction":"x"}"#,
            #"{"to":"+15550100","text":"   ","requested_by":"owner","owner_instruction":"x"}"#,
            #"{"to":"+15550100","text":"hi","requested_by":"owner","owner_instruction":"x"} trailing"#,
            #"[{"to":"+15550100"}]"#,
        ]
        for body in bad {
            #expect(throws: Problem.self) { try SendRequest.parse(Array(body.utf8)) }
        }
        #expect(throws: Problem.requesterNotSupported) {
            try SendRequest.parse(Array(#"{"to":"+15550100","text":"hi","requested_by":"alice-example","owner_instruction":"x"}"#.utf8))
        }
    }

    @Test func countsTextLikeTheSigner() {
        #expect((try? SendRequest.checkText(String(repeating: "a", count: 2000))) != nil)
        #expect((try? SendRequest.checkText(String(repeating: "a", count: 2001))) == nil)
        #expect((try? SendRequest.checkText(String(repeating: "👋🏽", count: 1000))) != nil)
        #expect((try? SendRequest.checkText(String(repeating: "👋🏽", count: 1001))) == nil)
    }

    @Test func normalisesRecipientsLikeTheSigner() {
        #expect(Recipient.normalize("\t+15550100 ") == "+15550100")
        #expect(Recipient.normalize("+15550100\n") == nil)
        #expect(Recipient.normalize("test@example.invalid\n") == nil)
        #expect(Recipient.normalize(" Test@Example.Invalid ") == "test@example.invalid")
    }

    @Test func hashesACanonicalForm() throws {
        let a = try SendRequest.parse(Array(#"{"to":"+1 (555) 010-0100","text":"cafe\u0301","requested_by":"owner","owner_instruction":"x"}"#.utf8))
        let b = try SendRequest.parse(Array("{ \"owner_instruction\" : \"x\", \"requested_by\":\"owner\", \"text\":\"café\", \"to\":\"+15550100100\" }".utf8))
        #expect(a.canonicalHash == b.canonicalHash)
    }
}

@Suite(.serialized) struct SendServiceTests {
    @Test func sendsOnceAndReplaysARetry() {
        let h = Harness()
        let first = h.send(h.request(h.body()))
        #expect(first.status == 200)
        #expect(first.json["outcome"] as? String == "sent")
        #expect(first.json["side_effects"] as? String == "sent")
        #expect(first.json["replayed"] as? Bool == false)
        let retry = h.send(h.request(h.body()))
        #expect(retry.status == 200)
        #expect(retry.json["replayed"] as? Bool == true)
        let reordered = "{\"owner_instruction\":\"tell alice-example I'm late\", \"requested_by\":\"owner\", \"text\":\"Running late\", \"to\":\"+1 555 0100\"}"
        #expect(h.send(h.request(reordered)).json["replayed"] as? Bool == true)
        #expect(h.messages.count == 1)
        let changed = h.send(h.request(h.body(text: "Something else")))
        #expect(changed.json["code"] as? String == "idempotency_conflict")
        #expect(changed.json["side_effects"] as? String == "sent")
        #expect(h.messages.count == 1)
        #expect(h.banner.posts.count == 1)
    }

    @Test func twoRetriesAtOnceSendOnce() {
        let h = Harness()
        h.messages.gate = DispatchSemaphore(value: 0)
        let group = DispatchGroup()
        var first = 0
        let request = h.request(h.body())
        group.enter()
        DispatchQueue.global().async {
            first = h.send(request).status
            group.leave()
        }
        let deadline = Date().addingTimeInterval(10)
        while h.messages.count == 0 && Date() < deadline { Thread.sleep(forTimeInterval: 0.01) }
        var second: (status: Int, json: [String: Any]) = (0, [:])
        let secondDone = DispatchSemaphore(value: 0)
        let retry = h.request(h.body())
        DispatchQueue.global().async {
            second = h.send(retry)
            secondDone.signal()
        }
        let answeredWhileFirstRan = secondDone.wait(timeout: .now() + 5) == .success
        h.messages.gate?.signal()
        group.wait()
        if !answeredWhileFirstRan { secondDone.wait() }
        #expect(answeredWhileFirstRan)
        #expect(h.messages.count == 1)
        #expect(first == 200)
        #expect(second.status == 409)
        #expect(second.json["code"] as? String == "send_in_progress")
        #expect(h.send(h.request(h.body())).json["replayed"] as? Bool == true)
    }

    func queuedSecondSend(_ change: (Harness) -> Void) -> (first: Int, second: [String: Any], sent: Int, enabled: Bool?) {
        let h = Harness()
        h.messages.gate = DispatchSemaphore(value: 0)
        let group = DispatchGroup()
        var first = 0
        var second: (status: Int, json: [String: Any]) = (0, [:])
        let one = h.request(h.body())
        let two = h.request(h.body(text: "Second"), key: "owner-msg-0002")
        group.enter()
        DispatchQueue.global().async {
            first = h.send(one).status
            group.leave()
        }
        let deadline = Date().addingTimeInterval(10)
        while h.messages.count == 0 && Date() < deadline { Thread.sleep(forTimeInterval: 0.01) }
        group.enter()
        DispatchQueue.global().async {
            second = h.send(two)
            group.leave()
        }
        func queued() -> Bool {
            h.service.lock.lock()
            defer { h.service.lock.unlock() }
            return h.service.inflight.contains("owner-msg-0002")
        }
        while !queued() && Date() < deadline { Thread.sleep(forTimeInterval: 0.01) }
        change(h)
        h.messages.gate?.signal()
        h.messages.gate?.signal()
        group.wait()
        return (first, second.json, h.messages.count, h.store.state?.enabled)
    }

    @Test func queuedSendsStopWhenSendingIsTurnedOff() {
        let off = queuedSecondSend { $0.switchedOn = false }
        #expect(off.first == 200)
        #expect(off.second["code"] as? String == "send_disabled")
        #expect(off.sent == 1)
        #expect(off.enabled == false)
        let other = Base64URL.encode(Array(Curve25519.Signing.PrivateKey().publicKey.rawRepresentation))
        let replaced = queuedSecondSend { $0.store.state?.keys = [SendKey(name: "box", publicKey: other)] }
        #expect(replaced.second["code"] as? String == "unknown_send_key")
        #expect(replaced.sent == 1)
    }

    @Test func parallelSendsCannotPassTheLimit() {
        var limits = SendLimits()
        limits.maxPerMinute = 3
        let h = Harness(limits: limits)
        h.ledger.history = ["+15550100"]
        let group = DispatchGroup()
        var statuses: [Int] = []
        let lock = NSLock()
        for index in 0..<8 {
            let request = h.request(h.body(text: "note \(index)"), key: "owner-msg-p\(index)00")
            group.enter()
            DispatchQueue.global().async {
                let status = h.send(request).status
                lock.lock()
                statuses.append(status)
                lock.unlock()
                group.leave()
            }
        }
        group.wait()
        #expect(h.messages.count == 3)
        #expect(statuses.filter { $0 == 429 }.count == 5)
    }

    @Test func capsFirstContactsAndPerRecipient() {
        let h = Harness()
        for index in 0..<3 {
            #expect(h.send(h.request(h.body(to: "+1555010010\(index)"), key: "owner-new-\(index)00")).status == 200)
            h.clock.now = h.clock.now.addingTimeInterval(61)
        }
        let fourth = h.send(h.request(h.body(to: "+15550100109"), key: "owner-new-900"))
        #expect(fourth.status == 429)
        #expect((fourth.json["detail"] as? String)?.contains("never texted") == true)
        h.ledger.history = ["+15550100109"]
        #expect(h.send(h.request(h.body(to: "+15550100109"), key: "owner-new-901")).status == 200)
    }

    @Test func messageTextReachesMessagesAsData() {
        let h = Harness()
        let payload = "\" & do shell script \"touch /tmp/gbrain-pwned\" & \" \\ \u{0}end"
        #expect(h.send(h.request(h.body(text: payload))).status == 200)
        #expect(h.messages.sent.first?.0 == payload)
        #expect(!MessagesApp.source.contains("\\("))
        #expect(MessagesApp.source.contains("on gbrain_send(theText, theHandle)"))
    }

    @Test func reportsDeliveryTruthfully() {
        let failed = Harness()
        failed.ledger.result = .failed(error: 22, guid: "GUID-101", rowid: 101)
        let answer = failed.send(failed.request(failed.body()))
        #expect(answer.status == 502)
        #expect(answer.json["code"] as? String == "failed_after_submit")
        #expect(failed.send(failed.request(failed.body())).json["replayed"] as? Bool == true)
        #expect(failed.messages.count == 1)

        let pending = Harness()
        pending.ledger.result = .pending
        let started = pending.clock.now
        let unknown = pending.send(pending.request(pending.body()))
        #expect(unknown.status == 202)
        #expect(unknown.json["outcome"] as? String == "unknown")
        #expect(unknown.json["side_effects"] as? String == "possible")
        #expect(pending.clock.now.timeIntervalSince(started) >= 30)
        pending.ledger.result = .sent(guid: "GUID-101", rowid: 101)
        let later = pending.send(pending.request(pending.body()))
        #expect(later.status == 200)
        #expect(later.json["replayed"] as? Bool == true)
        #expect(pending.messages.count == 1)
    }

    @Test func classifiesAppleEventErrors() {
        let timeout = Harness()
        timeout.messages.dispatch = .error(-1712)
        #expect(timeout.send(timeout.request(timeout.body())).status == 202)
        let lost = Harness()
        lost.messages.dispatch = .error(-609)
        #expect(lost.send(lost.request(lost.body())).json["outcome"] as? String == "unknown")

        let denied = Harness()
        denied.messages.prepareResult = .automationDenied
        let refused = denied.send(denied.request(denied.body()))
        #expect(refused.status == 503)
        #expect(refused.json["code"] as? String == "automation_denied")
        #expect(refused.json["side_effects"] as? String == "none")
        #expect(denied.messages.count == 0)
        denied.messages.prepareResult = .ready
        #expect(denied.send(denied.request(denied.body())).status == 200)
        #expect(denied.messages.count == 1)

        let unknownRecipient = Harness()
        unknownRecipient.messages.dispatch = .error(-1728)
        #expect(unknownRecipient.send(unknownRecipient.request(unknownRecipient.body())).json["code"] as? String == "recipient_not_imessage")
        let signedOut = Harness()
        signedOut.messages.prepareResult = .signedOut
        #expect(signedOut.send(signedOut.request(signedOut.body())).json["code"] as? String == "messages_signed_out")
    }

    @Test func refusesBadSignaturesAndStaleOrReplayedRequests() {
        let h = Harness()
        let other = Curve25519.Signing.PrivateKey()
        #expect(h.send(h.request(h.body(), signer: other)).json["code"] as? String == "signature_invalid")
        #expect(h.send(h.request(h.body(), keyName: "stranger")).json["code"] as? String == "unknown_send_key")
        let stale = h.send(h.request(h.body(), ts: Int(h.clock.now.timeIntervalSince1970) - 61))
        #expect(stale.json["code"] as? String == "timestamp_skew")
        #expect(stale.json["server_time"] as? Int == Int(h.clock.now.timeIntervalSince1970))
        #expect(h.send(h.request(h.body(), authorization: "Bearer \(token)")).json["code"] as? String == "signature_invalid")
        var tampered = h.request(h.body())
        tampered.body = Array(h.body(text: "changed").utf8)
        #expect(h.send(tampered).json["code"] as? String == "signature_invalid")
        let nonce = String(repeating: "b", count: 32)
        #expect(h.send(h.request(h.body(), nonce: nonce)).status == 200)
        #expect(h.send(h.request(h.body(), nonce: nonce)).json["code"] as? String == "nonce_replayed")
        var missing = h.request(h.body(), key: "owner-msg-0009")
        missing = HTTPRequest(method: "POST", path: missing.path, query: [:], headers: missing.headers.filter { $0.key != "idempotency-key" }, body: missing.body)
        #expect(h.send(missing).json["code"] as? String == "idempotency_key_required")
        #expect(h.messages.count == 1)
    }

    @Test func killSwitchAndKeychainStopEverySend() {
        let off = Harness()
        off.switchedOn = false
        #expect(off.send(off.request(off.body())).json["code"] as? String == "send_disabled")
        let disabled = Harness(enabled: false)
        #expect(disabled.send(disabled.request(disabled.body())).json["code"] as? String == "send_disabled")
        let tampered = Harness()
        tampered.store.failure = .sendKeysTampered
        #expect(tampered.send(tampered.request(tampered.body())).json["code"] as? String == "send_keys_tampered")
        for h in [off, disabled, tampered] { #expect(h.messages.count == 0) }
    }

    @Test func refusesBeforeSendingWhenTheLogCannotBeWritten() throws {
        let h = Harness()
        FileManager.default.createFile(atPath: h.directory, contents: Data())
        let answer = h.send(h.request(h.body()))
        #expect(answer.json["code"] as? String == "audit_unavailable")
        #expect(h.messages.count == 0)
    }

    @Test func retryAfterTheLogFailedSendsOnce() throws {
        let h = Harness()
        FileManager.default.createFile(atPath: h.directory, contents: Data())
        #expect(h.send(h.request(h.body())).json["code"] as? String == "audit_unavailable")
        try FileManager.default.removeItem(atPath: h.directory)
        let retry = h.send(h.request(h.body()))
        #expect(retry.status == 200)
        #expect(retry.json["replayed"] as? Bool == false)
        #expect(h.messages.count == 1)
    }

    @Test func refusesWithoutFullDiskAccess() {
        let h = Harness()
        h.ledger.failing = true
        #expect(h.send(h.request(h.body())).json["code"] as? String == "no_access")
        #expect(h.messages.count == 0)
    }

    @Test func logsEveryAttemptAndOutcome() {
        let h = Harness()
        _ = h.send(h.request(h.body()))
        let lines = h.auditLines()
        #expect(lines.map(\.kind) == ["pending", "outcome"])
        #expect(lines[0].text == "Running late")
        #expect(lines[0].ownerInstruction == "tell alice-example I'm late")
        #expect(lines[0].to == "+15550100")
        #expect(lines[0].peer == "100.102.0.7")
        #expect(lines[0].highWater == 100)
        #expect(lines[1].outcome == "sent")
        let mode = try? FileManager.default.attributesOfItem(atPath: h.audit.monthFiles()[0])[.posixPermissions] as? Int
        #expect(mode == 0o600)
    }

    @Test func reconcilesAPendingSendAtStartup() throws {
        let h = Harness()
        var pending = AuditRecord(t: SendAudit.stamp(h.clock.now), kind: "pending", key: "owner-msg-0001")
        pending.hash = try SendRequest.parse(Array(h.body().utf8)).canonicalHash
        pending.to = "+15550100"
        pending.text = "Running late"
        pending.highWater = 100
        try h.audit.append(pending, now: h.clock.now)
        h.service.start()
        #expect(h.auditLines().last?.outcome == "sent")
        #expect(h.ledger.bounds == [h.clock.now.addingTimeInterval(90)])
        let replay = h.send(h.request(h.body()))
        #expect(replay.json["replayed"] as? Bool == true)
        #expect(replay.json["outcome"] as? String == "sent")
        #expect(h.messages.count == 0)
    }

    @Test func movesATornLastLineAside() throws {
        let h = Harness()
        _ = h.send(h.request(h.body()))
        let path = h.audit.monthFiles()[0]
        let handle = try #require(FileHandle(forWritingAtPath: path))
        handle.seekToEndOfFile()
        handle.write(Data("{\"v\":1,\"t\":\"2026".utf8))
        try handle.close()
        let fresh = SendAudit(directory: h.directory)
        fresh.load(now: h.clock.now)
        #expect(fresh.entries["owner-msg-0001"]?.outcome?.outcome == "sent")
        let names = try FileManager.default.contentsOfDirectory(atPath: h.directory)
        #expect(names.contains { $0.hasPrefix("torn-") })
        #expect(fresh.read(path, repair: false).count == 2)
    }

    @Test func redactsOldLinesAfterNinetyDays() throws {
        let h = Harness()
        _ = h.send(h.request(h.body()))
        let later = h.clock.now.addingTimeInterval(91 * 86400)
        h.audit.applyRetention(now: later)
        let lines = h.auditLines()
        #expect(lines.count == 2)
        #expect(lines.allSatisfy { $0.text == nil && $0.to == nil && $0.ownerInstruction == nil })
        #expect(lines[1].outcome == "sent")
        let key = try #require(h.store.state?.recipientKey)
        #expect(lines[0].toHash == Recipient.hash("+15550100", key: key))
    }

    @Test func recipientHashIsKeyedPerInstall() throws {
        let plain = String(SHA256.hash(data: Data("+15550100".utf8)).map { String(format: "%02x", $0) }.joined().prefix(12))
        let first = Harness()
        #expect(first.store.state?.recipientHashKey == nil)
        #expect(first.send(first.request(first.body())).status == 200)
        let key = try #require(first.store.state?.recipientKey)
        #expect(first.send(first.request(first.body(text: "Second"), key: "owner-msg-0002")).status == 200)
        #expect(first.store.state?.recipientKey == key)
        let hashes = first.auditLines().compactMap(\.toHash)
        #expect(hashes.count == 4)
        #expect(Set(hashes) == [Recipient.hash("+15550100", key: key)])
        #expect(!hashes.contains(plain))
        let second = Harness()
        #expect(second.send(second.request(second.body())).status == 200)
        let other = try #require(second.auditLines().first?.toHash)
        #expect(other != hashes[0] && other != plain)
    }

    @Test func malformedRecipientHashKeyRefuses() {
        let h = Harness()
        h.store.state?.recipientHashKey = "short"
        #expect(h.send(h.request(h.body())).json["code"] as? String == "send_keys_tampered")
        #expect(h.messages.sent.isEmpty)
        #expect(h.store.state?.recipientHashKey == "short")
    }
}

@Suite struct SendAdminTests {
    func admin(_ h: Harness, _ fields: [String: String]) -> (Int, [String: Any]) {
        let body = "{" + fields.map { "\(StrictJSON.quote($0.key)):\(StrictJSON.quote($0.value))" }.joined(separator: ",") + "}"
        let request = HTTPRequest(method: "POST", path: SendService.adminRoute, query: [:], headers: [:], body: Array(body.utf8))
        let response: HTTPResponse
        switch h.service.admin(request) {
        case .ok(let ok): response = ok
        case .problem(let problem): response = .problem(problem, requestId: "t")
        }
        return (response.status, (try? JSONSerialization.jsonObject(with: Data(response.body))) as? [String: Any] ?? [:])
    }

    @Test func wideningNeedsTheOwnerAtTheMac() {
        let h = Harness(enabled: false)
        h.presence.answer = .unavailable
        #expect(admin(h, ["action": "setup"]).1["code"] as? String == "owner_presence_unavailable")
        #expect(h.messages.askedPermission)
        #expect(h.store.state?.enabled == false)
        #expect(admin(h, ["action": "add_key", "name": "second", "public_key": boxPublic]).1["code"] as? String == "owner_presence_unavailable")
        #expect(admin(h, ["action": "set_limits", "max_per_hour": "40"]).1["code"] as? String == "owner_presence_unavailable")
        #expect(admin(h, ["action": "set_limits", "max_per_hour": "10"]).0 == 200)
        #expect(h.store.state?.limits.maxPerHour == 10)
        #expect(admin(h, ["action": "remove_key", "name": "box"]).0 == 200)
        #expect(h.store.state?.keys.isEmpty == true)
        h.presence.answer = .confirmed
        #expect(admin(h, ["action": "add_key", "name": "box", "public_key": boxPublic]).0 == 200)
        #expect(admin(h, ["action": "setup"]).1["send"] as? String == "on")
        #expect(admin(h, ["action": "off"]).1["send"] as? String == "off")
        #expect(h.presence.reasons.count == 5)
        #expect(admin(h, ["action": "add_key", "name": "bad", "public_key": "abc"]).1["code"] as? String == "bad_param")
    }

    @Test func removingAKeyThatIsNotThereLeavesNoStopBehind() {
        let h = Harness()
        #expect(admin(h, ["action": "remove_key", "name": "no-key-has-this-name"]).1["code"] as? String == "not_found")
        #expect(h.service.currentStops().keys.isEmpty)
        #expect(admin(h, ["action": "remove_key", "name": "box"]).0 == 200)
        #expect(h.service.currentStops().keys == ["box": 1])
    }

    @Test func aSendSeeingTheSwitchOffDuringTouchIDRefusesTheChange() {
        let h = Harness()
        h.presence.gate = DispatchSemaphore(value: 0)
        h.presence.entered = DispatchSemaphore(value: 0)
        let group = DispatchGroup()
        var reply: (Int, [String: Any]) = (0, [:])
        group.enter()
        Thread {
            reply = self.admin(h, ["action": "add_key", "name": "second", "public_key": boxPublic])
            group.leave()
        }.start()
        #expect(h.presence.entered?.wait(timeout: .now() + 10) == .success)
        h.switchedOn = false
        #expect(h.send(h.request(h.body())).json["code"] as? String == "send_disabled")
        h.presence.gate?.signal()
        #expect(group.wait(timeout: .now() + 10) == .success)
        #expect(reply.1["code"] as? String == "send_disabled")
        #expect(h.store.state?.keys.map(\.name) == ["box"])
        #expect(h.store.state?.enabled == false)
        #expect(h.messages.count == 0)
    }

    @Test func aSendWaitingOnAKeyReplacementChecksTheNewKey() {
        let h = Harness()
        let other = Base64URL.encode(Array(Curve25519.Signing.PrivateKey().publicKey.rawRepresentation))
        h.store.saving = DispatchSemaphore(value: 0)
        h.store.saveGate = DispatchSemaphore(value: 0)
        let group = DispatchGroup()
        group.enter()
        Thread {
            _ = self.admin(h, ["action": "add_key", "name": "box", "public_key": other])
            group.leave()
        }.start()
        #expect(h.store.saving?.wait(timeout: .now() + 10) == .success)
        h.lock.waiting = DispatchSemaphore(value: 0)
        var code: String?
        group.enter()
        Thread {
            code = h.send(h.request(h.body())).json["code"] as? String
            group.leave()
        }.start()
        #expect(h.lock.waiting?.wait(timeout: .now() + 10) == .success)
        h.store.release()
        #expect(group.wait(timeout: .now() + 10) == .success)
        #expect(h.store.state?.keys == [SendKey(name: "box", publicKey: other)])
        #expect(code == "unknown_send_key")
        #expect(h.messages.count == 0)
    }

    @Test func aSendDuringAPendingTouchIDDoesNotWaitForIt() {
        let h = Harness()
        #expect(h.send(h.request(h.body(), key: "owner-msg-0000")).status == 200)
        let other = Base64URL.encode(Array(Curve25519.Signing.PrivateKey().publicKey.rawRepresentation))
        h.presence.gate = DispatchSemaphore(value: 0)
        h.presence.entered = DispatchSemaphore(value: 0)
        let group = DispatchGroup()
        group.enter()
        Thread {
            _ = self.admin(h, ["action": "add_key", "name": "box", "public_key": other])
            group.leave()
        }.start()
        #expect(h.presence.entered?.wait(timeout: .now() + 10) == .success)
        #expect(h.send(h.request(h.body())).status == 200)
        #expect(h.messages.count == 2)
        h.presence.gate?.signal()
        #expect(group.wait(timeout: .now() + 10) == .success)
        #expect(h.store.state?.keys == [SendKey(name: "box", publicKey: other)])
    }

    @Test func aSendDuringAKeyReplacementDialogGoesOutUnderTheCurrentKeyOnly() {
        let h = Harness()
        #expect(h.send(h.request(h.body(), key: "owner-msg-0000")).status == 200)
        let replacement = Curve25519.Signing.PrivateKey()
        let other = Base64URL.encode(Array(replacement.publicKey.rawRepresentation))
        h.presence.gate = DispatchSemaphore(value: 0)
        h.presence.entered = DispatchSemaphore(value: 0)
        let group = DispatchGroup()
        var reply: (Int, [String: Any]) = (0, [:])
        group.enter()
        Thread {
            reply = self.admin(h, ["action": "add_key", "name": "box", "public_key": other])
            group.leave()
        }.start()
        #expect(h.presence.entered?.wait(timeout: .now() + 10) == .success)
        #expect(h.send(h.request(h.body(), key: "owner-msg-0002", signer: replacement)).status != 200)
        #expect(h.messages.count == 1)
        #expect(h.send(h.request(h.body(), key: "owner-msg-0001")).status == 200)
        #expect(h.messages.count == 2)
        h.presence.gate?.signal()
        #expect(group.wait(timeout: .now() + 10) == .success)
        #expect(reply.0 == 200)
        #expect(h.store.state?.keys == [SendKey(name: "box", publicKey: other)])
        #expect(h.send(h.request(h.body(), key: "owner-msg-0003")).status != 200)
        #expect(h.messages.count == 2)
    }

    @Test func anAdminChangeLandingDuringTouchIDIsRefused() {
        let h = Harness()
        let other = Base64URL.encode(Array(Curve25519.Signing.PrivateKey().publicKey.rawRepresentation))
        h.presence.gate = DispatchSemaphore(value: 0)
        h.presence.entered = DispatchSemaphore(value: 0)
        let group = DispatchGroup()
        var reply: (Int, [String: Any]) = (0, [:])
        group.enter()
        Thread {
            reply = self.admin(h, ["action": "add_key", "name": "second", "public_key": other])
            group.leave()
        }.start()
        #expect(h.presence.entered?.wait(timeout: .now() + 10) == .success)
        #expect(admin(h, ["action": "remove_key", "name": "box"]).0 == 200)
        h.presence.gate?.signal()
        #expect(group.wait(timeout: .now() + 10) == .success)
        #expect(reply.1["code"] as? String == "overloaded")
        #expect(h.presence.reasons.count == 1)
        #expect(h.store.state?.keys.isEmpty == true)
    }

    @Test func anOffDuringAPendingSetupIsNotUndoneByTheSetup() {
        let h = Harness()
        #expect(admin(h, ["action": "off"]).0 == 200)
        h.presence.gate = DispatchSemaphore(value: 0)
        h.presence.entered = DispatchSemaphore(value: 0)
        let group = DispatchGroup()
        var reply: (Int, [String: Any]) = (0, [:])
        group.enter()
        Thread {
            reply = self.admin(h, ["action": "setup"])
            group.leave()
        }.start()
        #expect(h.presence.entered?.wait(timeout: .now() + 10) == .success)
        #expect(admin(h, ["action": "off"]).0 == 200)
        h.presence.gate?.signal()
        #expect(group.wait(timeout: .now() + 10) == .success)
        #expect(reply.1["code"] as? String == "overloaded")
        #expect(h.store.state?.enabled == false)
    }

    @Test(arguments: [["action": "off"], ["action": "remove_key", "name": "box"]])
    func aSendHeldBeforeMessagesIsStoppedByAChangeThatAlreadyReturned(fields: [String: String]) {
        let h = Harness()
        h.messages.preparing = DispatchSemaphore(value: 0)
        h.messages.prepareGate = DispatchSemaphore(value: 0)
        let group = DispatchGroup()
        var reply: (status: Int, json: [String: Any]) = (0, [:])
        group.enter()
        Thread {
            reply = h.send(h.request(h.body()))
            group.leave()
        }.start()
        #expect(h.messages.preparing?.wait(timeout: .now() + 10) == .success)
        #expect(admin(h, fields).0 == 200)
        h.messages.prepareGate?.signal()
        #expect(group.wait(timeout: .now() + 10) == .success)
        #expect(reply.json["code"] as? String == (fields["action"] == "off" ? "send_disabled" : "unknown_send_key"))
        #expect(h.messages.count == 0)
    }

    @Test(arguments: [[["action": "off"], ["action": "setup"]],
                      [["action": "remove_key", "name": "box"], ["action": "add_key", "name": "box", "public_key": boxPublic]]])
    func aStopCancelsASendHeldBeforeMessagesEvenWhenItIsUndoneAtOnce(changes: [[String: String]]) {
        let h = Harness()
        h.messages.preparing = DispatchSemaphore(value: 0)
        h.messages.prepareGate = DispatchSemaphore(value: 0)
        let group = DispatchGroup()
        var reply: (status: Int, json: [String: Any]) = (0, [:])
        group.enter()
        Thread {
            reply = h.send(h.request(h.body()))
            group.leave()
        }.start()
        #expect(h.messages.preparing?.wait(timeout: .now() + 10) == .success)
        for change in changes { #expect(admin(h, change).0 == 200) }
        #expect(h.store.state?.enabled == true)
        #expect(h.store.state?.keys == [SendKey(name: "box", publicKey: boxPublic)])
        h.messages.prepareGate?.signal()
        #expect(group.wait(timeout: .now() + 10) == .success)
        #expect(reply.json["code"] as? String == (changes[0]["action"] == "off" ? "send_disabled" : "unknown_send_key"))
        #expect(h.messages.count == 0)
        h.messages.preparing = nil
        h.messages.prepareGate = nil
        #expect(h.send(h.request(h.body(), key: "owner-msg-0002")).status == 200)
        #expect(h.messages.count == 1)
    }

    @Test func removingAnotherKeyLeavesAHeldSendAlone() {
        let h = Harness()
        #expect(admin(h, ["action": "add_key", "name": "second", "public_key": boxPublic]).0 == 200)
        h.messages.preparing = DispatchSemaphore(value: 0)
        h.messages.prepareGate = DispatchSemaphore(value: 0)
        let group = DispatchGroup()
        var reply: (status: Int, json: [String: Any]) = (0, [:])
        group.enter()
        Thread {
            reply = h.send(h.request(h.body()))
            group.leave()
        }.start()
        #expect(h.messages.preparing?.wait(timeout: .now() + 10) == .success)
        #expect(admin(h, ["action": "remove_key", "name": "second"]).0 == 200)
        h.messages.prepareGate?.signal()
        #expect(group.wait(timeout: .now() + 10) == .success)
        #expect(reply.status == 200)
        #expect(h.messages.count == 1)
    }

    @Test func offDoesNotWaitWhileASendWaitsForItsTurnWithMessages() {
        let h = Harness()
        h.messages.handingOver = DispatchSemaphore(value: 0)
        h.messages.handOverGate = DispatchSemaphore(value: 0)
        let group = DispatchGroup()
        var reply: (status: Int, json: [String: Any]) = (0, [:])
        group.enter()
        Thread {
            reply = h.send(h.request(h.body()))
            group.leave()
        }.start()
        #expect(h.messages.handingOver?.wait(timeout: .now() + 10) == .success)
        let off = DispatchGroup()
        var offStatus = 0
        off.enter()
        Thread {
            offStatus = self.admin(h, ["action": "off"]).0
            off.leave()
        }.start()
        #expect(off.wait(timeout: .now() + 10) == .success)
        #expect(offStatus == 200)
        h.messages.handOverGate?.signal()
        #expect(group.wait(timeout: .now() + 10) == .success)
        #expect(reply.json["code"] as? String == "send_disabled")
        #expect(h.messages.count == 0)
    }

    @Test(arguments: [true, false])
    func aSetupApprovedAfterTheConfigSwitchWentOffIsRefused(helperHeardOff: Bool) {
        let h = Harness()
        #expect(admin(h, ["action": "off"]).0 == 200)
        h.presence.gate = DispatchSemaphore(value: 0)
        h.presence.entered = DispatchSemaphore(value: 0)
        let group = DispatchGroup()
        var reply: (Int, [String: Any]) = (0, [:])
        group.enter()
        Thread {
            reply = self.admin(h, ["action": "setup"])
            group.leave()
        }.start()
        #expect(h.presence.entered?.wait(timeout: .now() + 10) == .success)
        h.switchedOn = false
        if helperHeardOff { #expect(admin(h, ["action": "off"]).0 == 200) }
        h.presence.gate?.signal()
        #expect(group.wait(timeout: .now() + 10) == .success)
        #expect(reply.1["code"] as? String == "send_disabled")
        #expect(h.store.state?.enabled == false)
    }

    @Test(arguments: [["action": "off"], ["action": "remove_key", "name": "box"], ["action": "set_limits", "max_per_day": "50"]])
    func aChangeThatCannotBeSavedIsReported(fields: [String: String]) {
        let h = Harness()
        h.store.saveFailure = .sendKeysUnreadable
        #expect(admin(h, fields).1["code"] as? String == "send_keys_unreadable")
        #expect(h.presence.reasons.isEmpty)
    }

    @Test func offIsSavedEvenWhenTheSwitchAlreadyLooksOff() {
        let h = Harness()
        h.switchedOn = false
        h.store.saveFailure = .sendKeysUnreadable
        #expect(admin(h, ["action": "off"]).1["code"] as? String == "send_keys_unreadable")
        #expect(h.store.state?.enabled == true)
    }

    @Test func turningSendingBackOnAfterTheConfigSwitchNeedsTheOwner() {
        let h = Harness()
        h.switchedOn = false
        #expect(h.send(h.request(h.body())).json["code"] as? String == "send_disabled")
        #expect(h.store.state?.enabled == false)
        h.switchedOn = true
        h.presence.answer = .unavailable
        #expect(admin(h, ["action": "setup"]).1["code"] as? String == "owner_presence_unavailable")
        #expect(h.send(h.request(h.body())).json["code"] as? String == "send_disabled")
        h.presence.answer = .confirmed
        #expect(admin(h, ["action": "setup"]).1["send"] as? String == "on")
        #expect(h.send(h.request(h.body())).status == 200)
        let down = Harness()
        down.switchedOn = false
        down.service.start()
        #expect(down.store.state?.enabled == false)
    }
}

@Suite struct SendKeychainPolicyTests {
    let helper = "/Applications/GBrain Helper.app/Contents/MacOS/gbrain-apple-helper"

    @Test func trustsOnlyAnItemLimitedToTheHelper() {
        let own = [ACLEntry(authorizations: ["ACLAuthorizationDecrypt", "ACLAuthorizationEncrypt"], applications: [helper]),
                   ACLEntry(authorizations: ["ACLAuthorizationChangeACL"], applications: [helper]),
                   ACLEntry(authorizations: ["ACLAuthorizationPartitionID"], applications: nil)]
        #expect(SendKeychainPolicy.trusted(own, helperPath: helper))
        let anyApp = own + [ACLEntry(authorizations: ["ACLAuthorizationDecrypt"], applications: nil)]
        #expect(!SendKeychainPolicy.trusted(anyApp, helperPath: helper))
        let attacker = [ACLEntry(authorizations: ["ACLAuthorizationAny"], applications: [helper, "/tmp/attacker"])]
        #expect(!SendKeychainPolicy.trusted(attacker, helperPath: helper))
        #expect(!SendKeychainPolicy.trusted([], helperPath: helper))
        let macDefault = [ACLEntry(authorizations: ["ACLAuthorizationEncrypt"], applications: nil),
                          ACLEntry(authorizations: ["ACLAuthorizationDecrypt", "ACLAuthorizationDerive", "ACLAuthorizationExportClear", "ACLAuthorizationExportWrapped",
                                                    "ACLAuthorizationMAC", "ACLAuthorizationSign"], applications: [helper]),
                          ACLEntry(authorizations: ["ACLAuthorizationChangeACL"], applications: [])]
        #expect(SendKeychainPolicy.trusted(macDefault, helperPath: helper))
    }

    @Test func trustsTheAppBundleMacOSRecordsForTheHelper() {
        let decrypt: Set<String> = ["ACLAuthorizationDecrypt", "ACLAuthorizationDerive", "ACLAuthorizationExportClear", "ACLAuthorizationExportWrapped",
                                    "ACLAuthorizationMAC", "ACLAuthorizationSign"]
        func item(_ app: String) -> [ACLEntry] {
            [ACLEntry(authorizations: ["ACLAuthorizationEncrypt"], applications: nil),
             ACLEntry(authorizations: decrypt, applications: [app]),
             ACLEntry(authorizations: ["ACLAuthorizationChangeACL"], applications: [])]
        }
        #expect(SendKeychainPolicy.trusted(item("/Applications/GBrain Helper.app"), helperPath: helper))
        #expect(!SendKeychainPolicy.trusted(item("/Applications/Other.app"), helperPath: helper))
        #expect(!SendKeychainPolicy.trusted(item("/Applications/GBrain Helper.app/Contents"), helperPath: helper))
        #expect(!SendKeychainPolicy.trusted(item("/Applications"), helperPath: helper))
        #expect(!SendKeychainPolicy.trusted(item("/Applications/GBrain Helper.app.evil.app"), helperPath: helper))
        #expect(!SendKeychainPolicy.trusted(item("/Applications/GBrain Helper .app"), helperPath: helper))
        #expect(!SendKeychainPolicy.trusted(item("/tmp/Applications/GBrain Helper.app"), helperPath: helper))
        #expect(!SendKeychainPolicy.trusted(item("/Applications/GBrain Helper"), helperPath: helper))
        #expect(!SendKeychainPolicy.trusted(item("/Applications/GBrain Helper.app"), helperPath: "/usr/local/bin/gbrain-apple-helper"))
    }
}

@Suite struct SendRoutingTests {
    func routers(_ h: Harness) -> (loopback: Router, tailnet: Router) {
        let loopback = RouterSettings(listener: .loopback, grants: grants(), sources: [], enabled: [], version: "t", send: h.service)
        let tailnet = RouterSettings(listener: .tailnet(allowed: [sendPeer]), grants: grants(), sources: [], enabled: [], version: "t", send: h.service)
        return (Router(settings: loopback, localAddresses: { [macTailnet] }), Router(settings: tailnet, localAddresses: { [macTailnet] }))
    }

    @Test func sendIsServedOnlyOnTheTailnetToListedPeers() {
        let h = Harness()
        let (loopback, tailnet) = routers(h)
        var onLoopback = h.request(h.body())
        onLoopback = HTTPRequest(method: "POST", path: onLoopback.path, query: [:], headers: onLoopback.headers.merging(["host": goodHost]) { $1 }, body: onLoopback.body)
        #expect(code(loopback.handle(onLoopback, peer: loopbackPeer, port: testPort, requestId: "t")) == "forbidden_source")
        #expect(code(tailnet.handle(h.request(h.body()), peer: strangerPeer, port: testPort, requestId: "t")) == "forbidden_source")
        #expect(tailnet.handle(h.request(h.body()), peer: sendPeer, port: testPort, requestId: "t").response.status == 200)
        let get = HTTPRequest(method: "GET", path: SendSignature.route, query: [:], headers: [:])
        #expect(code(tailnet.handle(get, peer: sendPeer, port: testPort, requestId: "t")) == "method_not_allowed")
        #expect(loopback.bodyLimit(path: SendSignature.route) == 32768)
        #expect(loopback.bodyLimit(path: "/v1/imessage/threads") == nil)
        #expect(h.messages.count == 1)
    }

    @Test func adminIsServedOnlyOnLoopbackToLoopbackPeers() {
        let h = Harness()
        let (loopback, tailnet) = routers(h)
        let admin = HTTPRequest(method: "POST", path: SendService.adminRoute, query: [:], headers: ["host": goodHost], body: Array(#"{"action":"status"}"#.utf8))
        #expect(loopback.handle(admin, peer: loopbackPeer, port: testPort, requestId: "t").response.status == 200)
        #expect(code(loopback.handle(admin, peer: strangerPeer, port: testPort, requestId: "t")) == "forbidden_source")
        #expect(code(loopback.handle(admin, peer: sendPeer, port: testPort, requestId: "t")) == "forbidden_source")
        #expect(code(tailnet.handle(admin, peer: sendPeer, port: testPort, requestId: "t")) == "not_found")
    }

    @Test func aReadTokenCanNeverCarryTheSendScope() {
        let config = Config(port: 8792, tokens: [TokenEntry(name: "gbrain", verifier: Token.hexDigest(token), scopes: ["send:imessage"])])
        #expect(throws: ConfigError.self) { try config.validated() }
    }

    @Test func validatesTheTailnetListener() throws {
        let ok = Config(port: 8792, listen: ListenSetting(tailnet: TailnetSetting(allowedPeers: ["100.102.0.7"])), send: SendSetting(enabled: true))
        #expect(try ok.validated().tailnet == TailnetListen(host: nil, peers: [sendPeer]))
        for bad in [TailnetSetting(allowedPeers: []), TailnetSetting(allowedPeers: ["192.168.1.5"]), TailnetSetting(host: "127.0.0.1", allowedPeers: ["100.102.0.7"])] {
            #expect(throws: ConfigError.self) { try Config(port: 8792, listen: ListenSetting(tailnet: bad)).validated() }
        }
        #expect(Interfaces.tailnetAddress([IPv4.parse("100.100.0.1")!: "utun3", IPv4.parse("192.168.1.5")!: "en0"]) == IPv4.parse("100.100.0.1"))
        #expect(Interfaces.tailnetAddress([IPv4.parse("100.100.0.1")!: "en0"]) == nil)
    }
}

@Suite struct SendFixTextTests {
    @Test func everyFixNamesACommandThatExists() {
        let commands = ["send-setup", "contacts-setup", "send-key", "send-limits", "send-audit", "init", "token", "validate-config", "check", "serve"]
        let problems: [Problem] = [.automationDenied, .messagesSignedOut, .messagesUnavailable, .sendDisabled, .signatureInvalid, .timestampSkew(serverTime: 0),
                                   .unknownSendKey, .sendKeysUnreadable, .sendKeysTampered, .ownerPresenceUnavailable, .auditUnavailable,
                                   .sourceDisabled("imessage"), .noAccess, .unauthorized, .forbiddenHost, .contactsNotAllowed, .cursorExpired]
        for problem in problems {
            let fix = problem.fix ?? ""
            #expect(!fix.contains("gbrain apple "), "\(problem.code) names a gbrain command that doesn't exist")
            for range in fix.ranges(of: "gbrain-apple-helper ") {
                let next = String(fix[range.upperBound...].prefix { $0.isLetter || $0 == "-" })
                #expect(commands.contains(next), "\(problem.code) names gbrain-apple-helper \(next)")
            }
        }
    }
}

@Suite struct DeliveryLedgerTests {
    @Test func confirmsOnlyANewRowAndReadsItsState() throws {
        let fixture = Fixture.standard()
        let ledger = ChatDeliveryLedger(dbPath: fixture.path)
        let mark = try ledger.highWater()
        #expect(mark == 12)
        #expect(try ledger.delivery(after: mark, to: "+15550100", text: "reply", guid: nil, sentBy: nil, skipping: []) == .pending)
        fixture.message(13, chat: 1, text: "reply", date: minutes(20), fromMe: true, handle: 1)
        #expect(try ledger.delivery(after: mark, to: "+15550100", text: "reply", guid: nil, sentBy: nil, skipping: []) == .pending)
        fixture.exec("UPDATE message SET is_sent = 1 WHERE ROWID = 13")
        #expect(try ledger.delivery(after: mark, to: "+15550100", text: "reply", guid: nil, sentBy: nil, skipping: []) == .sent(guid: "GUID-13", rowid: 13))
        #expect(try ledger.delivery(after: mark, to: "+15550111", text: "reply", guid: nil, sentBy: nil, skipping: []) == .pending)
        fixture.message(14, chat: 1, text: "second", date: minutes(21), fromMe: true, handle: 1)
        fixture.exec("UPDATE message SET error = 22 WHERE ROWID = 14")
        #expect(try ledger.delivery(after: mark, to: "+15550100", text: "second", guid: nil, sentBy: nil, skipping: []) == .failed(error: 22, guid: "GUID-14", rowid: 14))
        #expect(try ledger.delivery(after: mark, to: "+15550100", text: "anything", guid: "GUID-14", sentBy: nil, skipping: []) == .failed(error: 22, guid: "GUID-14", rowid: 14))
        fixture.message(15, chat: 1, text: "reply", date: minutes(90), fromMe: true, handle: 1)
        fixture.exec("UPDATE message SET is_sent = 1 WHERE ROWID = 15")
        let soon = AppleTime.date(fromRaw: minutes(30))
        #expect(try ledger.delivery(after: mark, to: "+15550100", text: "reply", guid: nil, sentBy: soon, skipping: []) == .sent(guid: "GUID-13", rowid: 13))
        #expect(try ledger.delivery(after: mark, to: "+15550100", text: "reply", guid: nil, sentBy: soon, skipping: ["GUID-13"]) == .pending)
        #expect(try ledger.delivery(after: mark, to: "+15550100", text: "reply", guid: nil, sentBy: nil, skipping: ["GUID-13"]) == .sent(guid: "GUID-15", rowid: 15))
    }

    @Test func knowsWhoWasTextedOneToOne() throws {
        let fixture = Fixture.standard()
        let ledger = ChatDeliveryLedger(dbPath: fixture.path)
        #expect(try ledger.hasOneToOneHistory(with: "+15550100"))
        #expect(try ledger.hasOneToOneHistory(with: "test@example.invalid"))
        #expect(try !ledger.hasOneToOneHistory(with: "+15550111"))
    }
}

@Suite struct SendBodyServerTests {
    @Test func readsAPostBodyInTwoPhases() throws {
        let h = Harness()
        let settings = RouterSettings(listener: .loopback, grants: [], sources: [], enabled: [], version: "t", send: h.service)
        let server = Server(host: loopbackPeer, port: 0, router: Router(settings: settings), maxConcurrent: 4, ioTimeout: 2)
        try server.start()
        Thread.detachNewThread { server.serveForever() }
        defer { server.stop() }
        let port = server.boundPort
        func post(_ head: String, _ body: String) -> String {
            let fd = connect(port)
            sendText(fd, "POST \(SendService.adminRoute) HTTP/1.1\r\nHost: 127.0.0.1:\(port)\r\n\(head)\r\n")
            Thread.sleep(forTimeInterval: 0.1)
            sendText(fd, body)
            return readAll(fd)
        }
        let body = "{\"action\":\"status\"}"
        #expect(status(post("Content-Length: \(body.utf8.count)\r\n", body)) == 200)
        #expect(status(post("", body)) == 411)
        #expect(status(post("Transfer-Encoding: chunked\r\n", body)) == 411)
        #expect(status(post("Content-Length: \(body.utf8.count)\r\nExpect: 100-continue\r\n", body)) == 411)
        #expect(status(post("Content-Length: 9000\r\n", body)) == 413)
        #expect(status(post("Content-Length: 3\r\n", body)) == 400)
    }
}
