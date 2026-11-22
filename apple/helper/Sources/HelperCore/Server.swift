import Darwin
import Foundation

public struct ServerError: Error, CustomStringConvertible {
    public let description: String
}

public final class Server {
    let host: UInt32
    let port: UInt16
    let router: Router
    let maxConcurrent: Int
    let ioTimeout: TimeInterval
    let maxRequestBytes: Int
    let lock = NSLock()
    var listener: Int32 = -1
    var inflight = 0
    var stopped = false
    public private(set) var boundPort: UInt16 = 0

    public init(host: UInt32, port: UInt16, router: Router, maxConcurrent: Int = 4, ioTimeout: TimeInterval = 10, maxRequestBytes: Int = 8192) {
        self.host = host
        self.port = port
        self.router = router
        self.maxConcurrent = maxConcurrent
        self.ioTimeout = ioTimeout
        self.maxRequestBytes = maxRequestBytes
    }

    public func start() throws {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw ServerError(description: "socket: \(String(cString: strerror(errno)))") }
        var yes: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = port.bigEndian
        address.sin_addr = in_addr(s_addr: host.bigEndian)
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard bound == 0, listen(fd, 32) == 0 else {
            let reason = String(cString: strerror(errno))
            close(fd)
            throw ServerError(description: "bind \(IPv4.string(host)):\(port): \(reason)")
        }
        var actual = sockaddr_in()
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &actual) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
        }
        boundPort = UInt16(bigEndian: actual.sin_port)
        listener = fd
    }

    public func stop() {
        lock.lock()
        stopped = true
        lock.unlock()
    }

    var isStopped: Bool {
        lock.lock()
        defer { lock.unlock() }
        return stopped
    }

    public func serveForever() {
        defer { close(listener) }
        while !isStopped {
            var poller = pollfd(fd: listener, events: Int16(POLLIN), revents: 0)
            guard poll(&poller, 1, 200) > 0 else { continue }
            var peer = sockaddr_in()
            var length = socklen_t(MemoryLayout<sockaddr_in>.size)
            let client = withUnsafeMutablePointer(to: &peer) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { accept(listener, $0, &length) }
            }
            guard client >= 0 else { continue }
            var noSigPipe: Int32 = 1
            setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
            let peerIP = UInt32(bigEndian: peer.sin_addr.s_addr)
            guard router.admits(peerIP) else {
                let rid = Self.requestId()
                finish(client, .problem(.forbiddenSource, requestId: rid), route: "-", rows: 0, requestId: rid, started: Date())
                continue
            }
            lock.lock()
            let busy = inflight >= maxConcurrent
            if !busy { inflight += 1 }
            lock.unlock()
            if busy {
                let rid = Self.requestId()
                finish(client, .problem(.overloaded, requestId: rid), route: "-", rows: 0, requestId: rid, started: Date())
                continue
            }
            DispatchQueue.global(qos: .userInitiated).async {
                self.serve(client, peer: peerIP)
                self.lock.lock()
                self.inflight -= 1
                self.lock.unlock()
            }
        }
    }

    func serve(_ client: Int32, peer: UInt32) {
        let started = Date()
        let rid = Self.requestId()
        var buffer: [UInt8] = []
        var chunk = [UInt8](repeating: 0, count: 4096)
        var parsed = HTTPParse.incomplete
        while case .incomplete = parsed {
            let remaining = ioTimeout - Date().timeIntervalSince(started)
            guard remaining > 0 else { return abandon(client, requestId: rid, started: started) }
            var timeout = timeval(tv_sec: Int(remaining), tv_usec: Int32((remaining - Double(Int(remaining))) * 1_000_000))
            setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
            setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
            let count = recv(client, &chunk, chunk.count, 0)
            guard count > 0 else { return abandon(client, requestId: rid, started: started) }
            buffer.append(contentsOf: chunk[0..<count])
            parsed = HTTPParser.parse(buffer, maxBytes: maxRequestBytes)
        }
        switch parsed {
        case .request(var request, let headLength):
            if request.method == "POST" {
                switch readBody(client, request: request, buffer: buffer, headLength: headLength, started: started) {
                case .success(let body): request.body = body
                case .failure(let failure):
                    guard let problem = failure.problem else { return abandon(client, requestId: rid, started: started) }
                    return finish(client, .problem(problem, requestId: rid), route: "-", rows: 0, requestId: rid, started: started)
                }
            }
            let routed = router.handle(request, peer: peer, port: boundPort, requestId: rid)
            finish(client, routed.response, route: routed.route, rows: routed.rows, requestId: rid, started: started)
        case .tooLarge:
            finish(client, .problem(.tooLarge, requestId: rid), route: "-", rows: 0, requestId: rid, started: started)
        default:
            finish(client, .problem(.badParam("malformed HTTP request"), requestId: rid), route: "-", rows: 0, requestId: rid, started: started)
        }
    }

    struct BodyFailure: Error {
        let problem: Problem?
    }

    func readBody(_ client: Int32, request: HTTPRequest, buffer: [UInt8], headLength: Int, started: Date) -> Result<[UInt8], BodyFailure> {
        guard request.headers["transfer-encoding"] == nil, request.headers["expect"] == nil else { return .failure(BodyFailure(problem: .lengthRequired)) }
        guard let lengthText = request.headers["content-length"], lengthText.allSatisfy(\.isNumber), let length = Int(lengthText) else {
            return .failure(BodyFailure(problem: .lengthRequired))
        }
        guard let limit = router.bodyLimit(path: request.path) else { return .failure(BodyFailure(problem: .methodNotAllowed)) }
        guard length <= limit else { return .failure(BodyFailure(problem: .tooLarge)) }
        var body = Array(buffer[headLength...])
        var chunk = [UInt8](repeating: 0, count: 4096)
        while body.count < length {
            let remaining = ioTimeout - Date().timeIntervalSince(started)
            guard remaining > 0 else { return .failure(BodyFailure(problem: nil)) }
            var timeout = timeval(tv_sec: Int(remaining), tv_usec: Int32((remaining - Double(Int(remaining))) * 1_000_000))
            setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
            let count = recv(client, &chunk, min(chunk.count, length - body.count + 1), 0)
            guard count > 0 else { return .failure(BodyFailure(problem: nil)) }
            body.append(contentsOf: chunk[0..<count])
        }
        guard body.count == length else { return .failure(BodyFailure(problem: .badParam("the body is longer than its Content-Length"))) }
        return .success(body)
    }

    func abandon(_ client: Int32, requestId: String, started: Date) {
        close(client)
        Log.line("route=- status=408 ms=\(Self.millis(since: started)) rows=0 rid=\(requestId)")
    }

    func finish(_ client: Int32, _ response: HTTPResponse, route: String, rows: Int, requestId: String, started: Date) {
        let bytes = response.serialize(requestId: requestId)
        var sent = 0
        while sent < bytes.count {
            let count = bytes[sent...].withUnsafeBytes { send(client, $0.baseAddress, $0.count, 0) }
            if count <= 0 { break }
            sent += count
        }
        close(client)
        Log.line("route=\(route) status=\(response.status) ms=\(Self.millis(since: started)) rows=\(rows) rid=\(requestId)")
    }

    static func millis(since start: Date) -> Int {
        Int(Date().timeIntervalSince(start) * 1000)
    }

    static func requestId() -> String {
        String(format: "%016llx", UInt64.random(in: 0...UInt64.max))
    }
}
