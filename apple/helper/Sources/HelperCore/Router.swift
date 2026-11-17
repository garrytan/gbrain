import Foundation

public enum Listener: Equatable {
    case loopback
    case tailnet(allowed: Set<UInt32>)
}

public struct RouterSettings {
    public let listener: Listener
    public let grants: () -> [TokenGrant]
    public let sources: [SourceModule]
    public let enabled: Set<String>
    public let version: String

    public init(listener: Listener, grants: [TokenGrant], sources: [SourceModule], enabled: Set<String>, version: String) {
        self.init(listener: listener, liveGrants: { grants }, sources: sources, enabled: enabled, version: version)
    }

    public init(listener: Listener, liveGrants: @escaping () -> [TokenGrant], sources: [SourceModule], enabled: Set<String>, version: String) {
        self.listener = listener
        self.grants = liveGrants
        self.sources = sources
        self.enabled = enabled
        self.version = version
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

    public func handle(_ request: HTTPRequest, peer: UInt32, port: UInt16, requestId: String) -> Routed {
        let source = settings.sources.first { $0.routes.contains(request.path) }
        let known = request.path == "/health" || request.path == "/v1/sources" || source != nil
        let route = known ? request.path : "unknown"
        func fail(_ problem: Problem) -> Routed {
            Routed(response: .problem(problem, requestId: requestId), route: route, rows: 0)
        }
        guard admits(peer) else { return fail(.forbiddenSource) }
        if settings.listener == .loopback {
            guard request.headers["origin"] == nil else { return fail(.forbiddenOrigin) }
            guard request.headers["host"] == "127.0.0.1:\(port)" else { return fail(.forbiddenHost) }
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
        guard settings.enabled.contains(source.id) else { return fail(.sourceDisabled(source.id)) }
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
        let enabled = settings.enabled.contains(source.id)
        return SourceStatus(id: source.id, enabled: enabled, permission: source.permission, state: enabled ? source.state() : "disabled",
                            scopes: [SourceCatalog.readScope(source.id)], routes: source.routes)
    }

    static func kind(_ error: Error) -> String {
        if case DBError.sqlite(let code, _) = error { return "sqlite_\(code)" }
        return String(describing: type(of: error))
    }
}
