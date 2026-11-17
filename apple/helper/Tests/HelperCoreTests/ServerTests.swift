import Darwin
import Foundation
import Testing
@testable import HelperCore

func connect(_ port: UInt16) -> Int32 {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = port.bigEndian
    address.sin_addr = in_addr(s_addr: IPv4.parse("127.0.0.1")!.bigEndian)
    let rc = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
    precondition(rc == 0)
    var timeout = timeval(tv_sec: 5, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    return fd
}

func sendText(_ fd: Int32, _ text: String) {
    let bytes = Array(text.utf8)
    _ = bytes.withUnsafeBytes { Darwin.send(fd, $0.baseAddress, $0.count, 0) }
}

func readAll(_ fd: Int32) -> String {
    var result: [UInt8] = []
    var chunk = [UInt8](repeating: 0, count: 4096)
    while true {
        let count = recv(fd, &chunk, chunk.count, 0)
        if count <= 0 { break }
        result.append(contentsOf: chunk[0..<count])
    }
    close(fd)
    return String(decoding: result, as: UTF8.self)
}

func status(_ response: String) -> Int {
    Int(response.split(separator: " ").dropFirst().first ?? "") ?? 0
}

func get(_ port: UInt16, _ target: String, host: String? = nil, extra: String = "") -> String {
    let fd = connect(port)
    sendText(fd, "GET \(target) HTTP/1.1\r\nHost: \(host ?? "127.0.0.1:\(port)")\r\n\(extra)\r\n")
    return readAll(fd)
}

@Suite(.serialized) struct ServerTests {
    func running(_ fixture: Fixture, timeout: TimeInterval = 10) throws -> Server {
        let server = Server(host: loopbackPeer, port: 0, router: router(dbPath: fixture.path), maxConcurrent: 4, ioTimeout: timeout)
        try server.start()
        Thread.detachNewThread { server.serveForever() }
        return server
    }

    @Test func servesLoopbackRequestsAddressedToItsOwnPort() throws {
        let fixture = Fixture.standard()
        let server = try running(fixture)
        defer { server.stop() }
        let port = server.boundPort
        let health = get(port, "/health")
        #expect(status(health) == 200)
        #expect(health.contains("Cache-Control: no-store"))
        #expect(!health.lowercased().contains("access-control"))
        #expect(status(get(port, "/v1/imessage/threads", extra: "Authorization: Bearer \(token)\r\n")) == 200)
        #expect(status(get(port, "/v1/imessage/threads", extra: "Authorization: Bearer \(token)\r\nOrigin: http://attacker.example\r\n")) == 403)
        #expect(status(get(port, "/health", host: "localhost:\(port)")) == 403)
        #expect(status(get(port, "/health", host: "127.0.0.1:\(port &+ 1)")) == 403)
    }

    @Test func refusesTheFifthConcurrentRequest() throws {
        let fixture = Fixture.standard()
        let server = try running(fixture, timeout: 3)
        defer { server.stop() }
        let held = (0..<4).map { _ in connect(server.boundPort) }
        for fd in held { sendText(fd, "GET /health HTTP/1.1\r\n") }
        Thread.sleep(forTimeInterval: 0.5)
        let fifth = connect(server.boundPort)
        sendText(fifth, "GET /health HTTP/1.1\r\n\r\n")
        let response = readAll(fifth)
        #expect(status(response) == 503)
        #expect(response.contains("overloaded"))
        #expect(response.contains("Retry-After: 1"))
        for fd in held { close(fd) }
    }

    @Test func dropsSlowClientsAndOversizedRequests() throws {
        let fixture = Fixture.standard()
        let server = try running(fixture, timeout: 1)
        defer { server.stop() }
        let slow = connect(server.boundPort)
        sendText(slow, "GET /health HTTP/1.1\r\n")
        let started = Date()
        #expect(readAll(slow).isEmpty)
        #expect(Date().timeIntervalSince(started) < 3)
        let big = connect(server.boundPort)
        sendText(big, "GET /health?" + String(repeating: "a", count: 8192 - 12))
        #expect(status(readAll(big)) == 413)
        let bad = connect(server.boundPort)
        sendText(bad, "NONSENSE\r\n\r\n")
        #expect(status(readAll(bad)) == 400)
    }
}
