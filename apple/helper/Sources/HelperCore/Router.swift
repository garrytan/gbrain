import Foundation

public enum Listener: Equatable {
    case loopback
    case tailnet(allowed: Set<UInt32>)
}

public struct RouterSettings {
    public let listener: Listener
    public let grants: () -> [TokenGrant]
    public let sources: [SourceModule]
    public let enabled: () -> Set<String>
    public let version: String
    public let send: SendService?
    public let writer: ContactsWriter?

    public init(listener: Listener, grants: [TokenGrant], sources: [SourceModule], enabled: Set<String>, version: String, send: SendService? = nil,
                writer: ContactsWriter? = nil) {
        self.init(listener: listener, liveGrants: { grants }, liveEnabled: { enabled }, sources: sources, version: version, send: send, writer: writer)
    }

    public init(listener: Listener, liveGrants: @escaping () -> [TokenGrant], sources: [SourceModule], enabled: Set<String>, version: String,
                send: SendService? = nil, writer: ContactsWriter? = nil) {
        self.init(listener: listener, liveGrants: liveGrants, liveEnabled: { enabled }, sources: sources, version: version, send: send, writer: writer)
    }

    public init(listener: Listener, liveGrants: @escaping () -> [TokenGrant], liveEnabled: @escaping () -> Set<String>, sources: [SourceModule],
                version: String, send: SendService? = nil, writer: ContactsWriter? = nil) {
        self.listener = listener
        self.grants = liveGrants
        self.sources = sources
        self.enabled = liveEnabled
        self.version = version
        self.send = send
        self.writer = writer
    }
}

struct Health: Encodable {
    let ok: Bool
    let version: String
}

struct SourcesMeta: Encodable {
    let count: Int
}

public struct Routed {
    public let response: HTTPResponse
    public let route: String
    public let rows: Int
}

public final class Router {
    static let tailnetReads: Set<String> = [ContactsSource.route]

    public let settings: RouterSettings
    let localAddresses: () -> Set<UInt32>

    public init(settings: RouterSettings, localAddresses: @escaping () -> Set<UInt32> = { Set(Interfaces.ipv4().keys) }) {
        self.settings = settings
        self.localAddresses = localAddresses
    }

    public func admits(_ peer: UInt32) -> Bool {
        switch settings.listener {
        case .loopback:
            return IPv4.isLoopback(peer)
        case .tailnet(let allowed):
            return allowed.contains(peer) && !IPv4.isLoopback(peer) && !localAddresses().contains(peer)
        }
    }

    public func bodyLimit(path: String) -> Int? {
        switch path {
        case SendSignature.route: return 32 * 1024
        case SendService.adminRoute, ContactsSource.adminRoute, ContactsWriter.adminRoute: return 8 * 1024
        case ContactsWriter.route: return ContactsWriter.bodyLimit
        default: return nil
        }
    }

    public func handle(_ request: HTTPRequest, peer: UInt32, port: UInt16, requestId: String) -> Routed {
        let source = settings.sources.first { $0.routes.contains(request.path) }
        let posts = [SendSignature.route, SendService.adminRoute, ContactsSource.adminRoute, ContactsWriter.route, ContactsWriter.adminRoute]
        let known = request.path == "/health" || request.path == "/v1/sources" || source != nil || posts.contains(request.path)
        let route = known ? request.path : "unknown"
        func fail(_ problem: Problem) -> Routed {
            Routed(response: .problem(problem, requestId: requestId), route: route, rows: 0)
        }
        func reply(_ reply: SendReply) -> Routed {
            switch reply {
            case .ok(let response): return Routed(response: response, route: route, rows: 0)
            case .problem(let problem): return fail(problem)
            }
        }
        guard admits(peer) else { return fail(.forbiddenSource) }
        if case .tailnet = settings.listener {
            if request.path == SendSignature.route, let send = settings.send {
                guard request.method == "POST" else { return fail(.methodNotAllowed) }
                return reply(send.handle(request, peer: peer))
            }
            if request.path == ContactsWriter.route, let writer = settings.writer {
                guard request.headers["origin"] == nil else { return fail(.forbiddenOrigin) }
                guard request.method == "POST" else { return fail(.methodNotAllowed) }
                return reply(writer.handle(request, grants: settings.grants()))
            }
            guard let source, Self.tailnetReads.contains(request.path) else { return fail(.notFound) }
            guard request.headers["origin"] == nil else { return fail(.forbiddenOrigin) }
            guard request.method == "GET" else { return fail(.methodNotAllowed) }
            guard let grant = Token.grant(authorization: request.headers["authorization"], grants: settings.grants()) else { return fail(.unauthorized) }
            return read(request, from: source, grant: grant, route: route, requestId: requestId)
        }
        guard request.headers["origin"] == nil else { return fail(.forbiddenOrigin) }
        guard request.headers["host"] == "127.0.0.1:\(port)" else { return fail(.forbiddenHost) }
        if request.path == SendSignature.route { return fail(.forbiddenSource) }
        if request.path == SendService.adminRoute {
            guard let send = settings.send else { return fail(.notFound) }
            guard request.method == "POST" else { return fail(.methodNotAllowed) }
            return reply(send.admin(request))
        }
        if request.path == ContactsWriter.route || request.path == ContactsWriter.adminRoute {
            guard let writer = settings.writer else { return fail(.notFound) }
            guard request.method == "POST" else { return fail(.methodNotAllowed) }
            return reply(request.path == ContactsWriter.route ? writer.handle(request, grants: settings.grants()) : writer.admin(request))
        }
        if request.path == ContactsSource.adminRoute {
            guard let contacts = settings.sources.lazy.compactMap({ $0 as? ContactsSource }).first else { return fail(.notFound) }
            guard request.method == "POST" else { return fail(.methodNotAllowed) }
            return reply(contacts.admin(request))
        }
        guard request.method == "GET" else { return fail(.methodNotAllowed) }
        if request.path == "/health" {
            return Routed(response: .json(200, Health(ok: true, version: settings.version)), route: route, rows: 0)
        }
        guard let grant = Token.grant(authorization: request.headers["authorization"], grants: settings.grants()) else { return fail(.unauthorized) }
        if request.path == "/v1/sources" {
            let statuses = settings.sources.map { status($0) }
            return Routed(response: .json(200, Envelope(data: statuses, meta: SourcesMeta(count: statuses.count))), route: route, rows: 0)
        }
        guard let source else { return fail(.notFound) }
        return read(request, from: source, grant: grant, route: route, requestId: requestId)
    }

    func read(_ request: HTTPRequest, from source: SourceModule, grant: TokenGrant, route: String, requestId: String) -> Routed {
        func fail(_ problem: Problem) -> Routed {
            Routed(response: .problem(problem, requestId: requestId), route: route, rows: 0)
        }
        guard settings.enabled().contains(source.id) else { return fail(.sourceDisabled(source.id)) }
        let scope = SourceCatalog.readScope(source.id)
        guard grant.scopes.contains(scope) else { return fail(.insufficientScope(scope)) }
        do {
            let result = try source.handle(path: request.path, query: request.query)
            return Routed(response: result.response, route: route, rows: result.rows)
        } catch {
            let problem = (error as? Problem) ?? source.problem(for: error)
            if problem.code == Problem.internalError.code { Log.line("route=\(route) error=\(Self.kind(error)) rid=\(requestId)") }
            return fail(problem)
        }
    }

    func status(_ source: SourceModule) -> SourceStatus {
        let enabled = settings.enabled().contains(source.id)
        return SourceStatus(id: source.id, enabled: enabled, permission: source.permission, state: enabled ? source.state() : "disabled",
                            scopes: [SourceCatalog.readScope(source.id)], routes: source.routes)
    }

    static func kind(_ error: Error) -> String {
        if case DBError.sqlite(let code, _) = error { return "sqlite_\(code)" }
        return String(describing: type(of: error))
    }
}
