import Foundation
import Testing
@testable import HelperCore

let loopbackPeer = IPv4.parse("127.0.0.1")!
let tailnetPeer = IPv4.parse("100.102.0.7")!
let macTailnet = IPv4.parse("100.100.0.1")!
let strangerPeer = IPv4.parse("100.90.0.9")!
let token = "synthetic-test-token"
let statusToken = "synthetic-status-token"
let testPort: UInt16 = 8792
let goodHost = "127.0.0.1:8792"

func grants() -> [TokenGrant] {
    [TokenGrant(name: "reader", verifier: Token.verifier(fromHex: Token.hexDigest(token))!, scopes: [SourceCatalog.readScope("imessage")]),
     TokenGrant(name: "status", verifier: Token.verifier(fromHex: Token.hexDigest(statusToken))!, scopes: [])]
}

func router(dbPath: String, listener: Listener = .loopback, enabled: Set<String> = ["imessage"]) -> Router {
    let settings = RouterSettings(listener: listener, grants: grants(), sources: [IMessageSource(dbPath: dbPath)], enabled: enabled, version: "test")
    return Router(settings: settings, localAddresses: { [macTailnet] })
}

func request(_ target: String, auth: String? = "Bearer \(token)", host: String? = goodHost, origin: String? = nil, method: String = "GET") -> HTTPRequest {
    var raw = "\(method) \(target) HTTP/1.1\r\n"
    if let host { raw += "Host: \(host)\r\n" }
    if let origin { raw += "Origin: \(origin)\r\n" }
    if let auth { raw += "Authorization: \(auth)\r\n" }
    raw += "\r\n"
    guard case .request(let parsed) = HTTPParser.parse(Array(raw.utf8), maxBytes: 8192) else { fatalError("unparsed") }
    return parsed
}

func send(_ router: Router, _ request: HTTPRequest, peer: UInt32 = loopbackPeer) -> Routed {
    router.handle(request, peer: peer, port: testPort, requestId: "t")
}

func json(_ routed: Routed) -> [String: Any] {
    (try? JSONSerialization.jsonObject(with: Data(routed.response.body))) as? [String: Any] ?? [:]
}

func code(_ routed: Routed) -> String? {
    json(routed)["code"] as? String
}

func sources(_ routed: Routed) -> [[String: Any]] {
    json(routed)["data"] as? [[String: Any]] ?? []
}

@Suite struct LoopbackListenerTests {
    @Test func healthCarriesOnlyOkAndVersion() {
        let routed = send(router(dbPath: "/nonexistent/chat.db"), request("/health", auth: nil))
        #expect(routed.response.status == 200)
        #expect(Set(json(routed).keys) == ["ok", "version"])
        #expect(json(routed)["ok"] as? Bool == true)
    }

    @Test func admitsOnlyLoopbackPeers() {
        let r = router(dbPath: "/nonexistent/chat.db")
        #expect(r.admits(loopbackPeer))
        #expect(r.admits(IPv4.parse("127.0.0.2")!))
        for peer in [tailnetPeer, macTailnet, strangerPeer, IPv4.parse("192.168.1.5")!] {
            #expect(!r.admits(peer))
            #expect(code(send(r, request("/health", auth: nil), peer: peer)) == "forbidden_source")
        }
    }

    @Test func refusesEveryOtherHost() {
        let fixture = Fixture.standard()
        let r = router(dbPath: fixture.path)
        let hosts: [String?] = ["localhost:8792", "127.0.0.1", "127.0.0.1:8793", "attacker.example:8792", "[::1]:8792", "127.0.0.1:8792.attacker.example", "", nil]
        for host in hosts {
            for target in ["/health", "/v1/sources", "/v1/imessage/threads"] {
                let routed = send(r, request(target, host: host))
                #expect(routed.response.status == 403, "\(target) \(host ?? "no host")")
                #expect(code(routed) == "forbidden_host")
            }
        }
    }

    @Test func refusesAnyOriginAndSendsNoCORSHeaders() {
        let fixture = Fixture.standard()
        let r = router(dbPath: fixture.path)
        for origin in ["http://127.0.0.1:8792", "null", "https://attacker.example", ""] {
            for target in ["/health", "/v1/imessage/threads"] {
                let routed = send(r, request(target, origin: origin))
                #expect(routed.response.status == 403, "\(target) \(origin)")
                #expect(code(routed) == "forbidden_origin")
            }
        }
        let served = send(r, request("/v1/imessage/threads"))
        #expect(served.response.status == 200)
        #expect(!String(decoding: served.response.serialize(requestId: "t"), as: UTF8.self).lowercased().contains("access-control"))
    }

    @Test func checksTokens() {
        let fixture = Fixture.standard()
        let r = router(dbPath: fixture.path)
        #expect(send(r, request("/v1/imessage/threads", auth: nil)).response.status == 401)
        #expect(send(r, request("/v1/imessage/threads", auth: "Bearer wrong")).response.status == 401)
        #expect(send(r, request("/v1/imessage/threads", auth: "Basic \(token)")).response.status == 401)
        #expect(send(r, request("/v1/imessage/threads", auth: "Bearer")).response.status == 401)
        #expect(send(r, request("/v1/sources", auth: nil)).response.status == 401)
        #expect(send(r, request("/v1/imessage/threads")).response.status == 200)
    }

    @Test func dataRoutesNeedTheSourceScope() {
        let fixture = Fixture.standard()
        let r = router(dbPath: fixture.path)
        let routed = send(r, request("/v1/imessage/threads", auth: "Bearer \(statusToken)"))
        #expect(routed.response.status == 403)
        #expect(code(routed) == "insufficient_scope")
        #expect(send(r, request("/v1/sources", auth: "Bearer \(statusToken)")).response.status == 200)
    }

    @Test func disabledSourceIsRefusedAndNeverOpened() {
        let r = router(dbPath: "/nonexistent/chat.db", enabled: [])
        for target in ["/v1/imessage/threads", "/v1/imessage/thread?thread_id=%2B15550100"] {
            let routed = send(r, request(target))
            #expect(routed.response.status == 403)
            #expect(code(routed) == "source_disabled")
        }
        let listed = sources(send(r, request("/v1/sources")))
        #expect(listed.first?["enabled"] as? Bool == false)
        #expect(listed.first?["state"] as? String == "disabled")
    }

    @Test func sourcesListModulesWithoutData() {
        let fixture = Fixture.standard()
        let routed = send(router(dbPath: fixture.path), request("/v1/sources"))
        #expect(routed.response.status == 200)
        #expect(routed.rows == 0)
        let listed = sources(routed)
        #expect(listed.count == 1)
        #expect(listed.first?["id"] as? String == "imessage")
        #expect(listed.first?["enabled"] as? Bool == true)
        #expect(listed.first?["permission"] as? String == "full_disk_access")
        #expect(listed.first?["state"] as? String == "ok")
        #expect(listed.first?["scopes"] as? [String] == ["read:imessage"])
        #expect(listed.first?["routes"] as? [String] == ["/v1/imessage/threads", "/v1/imessage/thread"])
        let text = String(decoding: routed.response.body, as: UTF8.self)
        for data in ["15550100", "example.invalid", "Test Group", "hi one"] {
            #expect(!text.contains(data))
        }
    }

    @Test func listThreadsShape() {
        let fixture = Fixture.standard()
        let routed = send(router(dbPath: fixture.path), request("/v1/imessage/threads?limit=3"))
        let body = json(routed)
        let data = body["data"] as? [[String: Any]] ?? []
        #expect(data.count == 3)
        #expect(data.first?["thread_id"] as? String == "test@example.invalid")
        #expect((data.first?["last_message"] as? [String: Any])?["is_from_me"] as? Bool == false)
        #expect((body["meta"] as? [String: Any])?["count"] as? Int == 3)
        #expect(routed.rows == 3)
        #expect(routed.route == "/v1/imessage/threads")
    }

    @Test func plusInHandlesSurvivesRawAndEncoded() {
        let fixture = Fixture.standard()
        let r = router(dbPath: fixture.path)
        for target in ["/v1/imessage/thread?thread_id=+15550100", "/v1/imessage/thread?thread_id=%2B15550100"] {
            let routed = send(r, request(target))
            #expect(routed.response.status == 200)
            #expect(((json(routed)["data"] as? [String: Any])?["messages"] as? [Any])?.count == 4)
        }
    }

    @Test func sinceRowidPagesForward() {
        let fixture = Fixture.standard()
        let routed = send(router(dbPath: fixture.path), request("/v1/imessage/thread?thread_id=%2B15550100&since_rowid=2&limit=1"))
        let messages = (json(routed)["data"] as? [String: Any])?["messages"] as? [[String: Any]] ?? []
        #expect(messages.map { $0["rowid"] as? Int } == [3])
        #expect((json(routed)["meta"] as? [String: Any])?["next_since_rowid"] as? Int == 3)
        #expect((json(routed)["meta"] as? [String: Any])?["has_more"] as? Bool == true)
    }

    @Test func rejectsBadParameters() {
        let fixture = Fixture.standard()
        let r = router(dbPath: fixture.path)
        for target in ["/v1/imessage/thread", "/v1/imessage/thread?thread_id=a&chat_rowid=1", "/v1/imessage/thread?thread_id=",
                       "/v1/imessage/thread?thread_id=x&limit=0", "/v1/imessage/thread?thread_id=x&limit=501",
                       "/v1/imessage/thread?thread_id=x&since_iso=soon", "/v1/imessage/thread?thread_id=x&since_rowid=-1",
                       "/v1/imessage/thread?chat_rowid=abc", "/v1/imessage/threads?limit=201", "/v1/imessage/threads?include_last_message=maybe"] {
            let routed = send(r, request(target))
            #expect(routed.response.status == 400, "\(target)")
            #expect(code(routed) == "bad_param")
        }
    }

    @Test func notFoundNeverEchoesTheHandle() {
        let fixture = Fixture.standard()
        let routed = router(dbPath: fixture.path).handle(request("/v1/imessage/thread?thread_id=%2B15559999"), peer: loopbackPeer, port: testPort, requestId: "rid1")
        #expect(routed.response.status == 404)
        #expect(!String(decoding: routed.response.body, as: UTF8.self).contains("15559999"))
        #expect(json(routed)["request_id"] as? String == "rid1")
        #expect(json(routed)["type"] as? String == Problem.docBase + "not_found")
        #expect(routed.response.contentType == "application/problem+json")
    }

    @Test func otherMethodsAndRoutes() {
        let fixture = Fixture.standard()
        let r = router(dbPath: fixture.path)
        #expect(send(r, request("/v1/imessage/threads", method: "POST")).response.status == 405)
        #expect(send(r, request("/v1/imessage/send")).response.status == 404)
        #expect(send(r, request("/v1/imessage/send", auth: nil)).response.status == 401)
        #expect(send(r, request("/v1/list_threads")).response.status == 404)
        #expect(send(r, request("/v1/imessage/send")).route == "unknown")
    }

    @Test func explainsMissingFullDiskAccess() {
        let fixture = Fixture.standard()
        fixture.close()
        chmod(fixture.path, 0)
        defer { chmod(fixture.path, 0o644) }
        let r = router(dbPath: fixture.path)
        let routed = send(r, request("/v1/imessage/threads"))
        #expect(routed.response.status == 503)
        let body = json(routed)
        #expect(body["code"] as? String == "no_access")
        #expect(body["retryable"] as? Bool == false)
        #expect((body["fix"] as? String)?.contains("Full Disk Access") == true)
        #expect((body["fix"] as? String)?.contains(HelperIdentity.bundleId) == true)
        #expect(sources(send(r, request("/v1/sources"))).first?["state"] as? String == "no_access")
        #expect(send(r, request("/health", auth: nil)).response.status == 200)
        let busy = HTTPResponse.problem(.dbBusy, requestId: "t")
        #expect(busy.extraHeaders.contains { $0.0 == "Retry-After" && $0.1 == "2" })
    }
}

@Suite struct TailnetListenerTests {
    @Test func admitsOnlyListedPeersThatAreNotThisMac() {
        let r = router(dbPath: "/nonexistent/chat.db", listener: .tailnet(allowed: [tailnetPeer, macTailnet, loopbackPeer]))
        #expect(r.admits(tailnetPeer))
        #expect(!r.admits(macTailnet))
        #expect(!r.admits(loopbackPeer))
        #expect(!r.admits(strangerPeer))
    }

    @Test func servesListedPeersWithAToken() {
        let fixture = Fixture.standard()
        let r = router(dbPath: fixture.path, listener: .tailnet(allowed: [tailnetPeer]))
        let host = "100.100.0.1:8792"
        #expect(send(r, request("/health", auth: nil, host: host), peer: tailnetPeer).response.status == 200)
        #expect(send(r, request("/v1/imessage/threads", host: host), peer: tailnetPeer).response.status == 200)
        #expect(send(r, request("/v1/imessage/threads", auth: nil, host: host), peer: tailnetPeer).response.status == 401)
        for peer in [macTailnet, loopbackPeer, strangerPeer] {
            #expect(code(send(r, request("/health", auth: nil), peer: peer)) == "forbidden_source")
        }
    }

    @Test func bindPolicyNeedsATailnetUtunAddress() {
        let host = IPv4.parse("100.100.0.1")!
        #expect(BindPolicy.problem(host: host, interfaces: [host: "utun4"]) == nil)
        #expect(BindPolicy.problem(host: host, interfaces: [host: "en0"]) != nil)
        #expect(BindPolicy.problem(host: host, interfaces: [:]) != nil)
        #expect(BindPolicy.problem(host: IPv4.parse("0.0.0.0")!, interfaces: [:]) != nil)
        #expect(BindPolicy.problem(host: IPv4.parse("192.168.1.5")!, interfaces: [IPv4.parse("192.168.1.5")!: "utun1"]) != nil)
    }
}

@Suite struct TokenTests {
    @Test func picksTheMatchingGrant() {
        let all = grants()
        #expect(Token.grant(authorization: "Bearer \(token)", grants: all)?.name == "reader")
        #expect(Token.grant(authorization: "bearer \(statusToken)", grants: all)?.name == "status")
        #expect(Token.grant(authorization: "Bearer \(token)x", grants: all) == nil)
        #expect(Token.grant(authorization: nil, grants: all) == nil)
        #expect(Token.grant(authorization: "Bearer \(token)", grants: []) == nil)
        #expect(Token.verifier(fromHex: "zz" + String(repeating: "0", count: 62)) == nil)
        #expect(Token.verifier(fromHex: Token.hexDigest(token).uppercased()) == Token.verifier(fromHex: Token.hexDigest(token)))
    }
}

@Suite struct LiveGrantTests {
    @Test func aRemovedTokenStopsWorkingOnTheNextRequest() {
        let fixture = Fixture.standard()
        var current = grants()
        let settings = RouterSettings(listener: .loopback, liveGrants: { current }, sources: [IMessageSource(dbPath: fixture.path)], enabled: ["imessage"], version: "test")
        let r = Router(settings: settings, localAddresses: { [macTailnet] })
        #expect(send(r, request("/v1/sources")).response.status == 200)
        current = []
        #expect(code(send(r, request("/v1/sources"))) == "unauthorized")
    }
}
