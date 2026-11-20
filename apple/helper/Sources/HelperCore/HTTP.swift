import Foundation

public struct HTTPRequest {
    public let method: String
    public let path: String
    public let query: [String: String]
    public let headers: [String: String]
    public var body: [UInt8] = []
}

public enum HTTPParse {
    case incomplete
    case tooLarge
    case bad
    case request(HTTPRequest, headLength: Int)
}

public struct HTTPResponse {
    public var status: Int
    public var contentType: String
    public var extraHeaders: [(String, String)]
    public var body: [UInt8]

    public static func json<T: Encodable>(_ status: Int, _ value: T) -> HTTPResponse {
        HTTPResponse(status: status, contentType: "application/json", extraHeaders: [], body: encode(value))
    }

    public static func problem(_ problem: Problem, requestId: String) -> HTTPResponse {
        let body = ProblemBody(type: Problem.docBase + problem.code, title: problem.title, status: problem.status, code: problem.code,
                               detail: problem.detail, retryable: problem.retryable, fix: problem.fix, requestId: requestId,
                               sideEffects: problem.sideEffects, outcome: problem.outcome, replayed: problem.replayed, serverTime: problem.serverTime)
        var headers: [(String, String)] = []
        if let retryAfter = problem.retryAfter { headers.append(("Retry-After", String(retryAfter))) }
        return HTTPResponse(status: problem.status, contentType: "application/problem+json", extraHeaders: headers, body: encode(body))
    }

    static func encode<T: Encodable>(_ value: T) -> [UInt8] {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return (try? Array(encoder.encode(value))) ?? Array("{}".utf8)
    }

    public func serialize(requestId: String) -> [UInt8] {
        var head = "HTTP/1.1 \(status) \(Self.reason(status))\r\n"
        head += "Content-Type: \(contentType)\r\n"
        head += "Content-Length: \(body.count)\r\n"
        head += "Cache-Control: no-store\r\n"
        head += "Connection: close\r\n"
        head += "X-Request-Id: \(requestId)\r\n"
        for (name, value) in extraHeaders { head += "\(name): \(value)\r\n" }
        head += "\r\n"
        return Array(head.utf8) + body
    }

    static func reason(_ status: Int) -> String {
        switch status {
        case 200: return "OK"
        case 202: return "Accepted"
        case 400: return "Bad Request"
        case 401: return "Unauthorized"
        case 403: return "Forbidden"
        case 404: return "Not Found"
        case 405: return "Method Not Allowed"
        case 408: return "Request Timeout"
        case 409: return "Conflict"
        case 411: return "Length Required"
        case 413: return "Content Too Large"
        case 422: return "Unprocessable Content"
        case 429: return "Too Many Requests"
        case 500: return "Internal Server Error"
        case 502: return "Bad Gateway"
        case 503: return "Service Unavailable"
        default: return "Status"
        }
    }
}

public enum HTTPParser {
    static let terminator: [UInt8] = [13, 10, 13, 10]

    public static func parse(_ buffer: [UInt8], maxBytes: Int) -> HTTPParse {
        guard let end = TypedStream.find(terminator, in: buffer, from: 0) else {
            return buffer.count >= maxBytes ? .tooLarge : .incomplete
        }
        guard end + terminator.count <= maxBytes else { return .tooLarge }
        guard let head = String(bytes: buffer[0..<end], encoding: .utf8) else { return .bad }
        let lines = head.components(separatedBy: "\r\n")
        let requestLine = lines[0].split(separator: " ")
        guard requestLine.count == 3, requestLine[2].hasPrefix("HTTP/1.") else { return .bad }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { return .bad }
            headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        let target = String(requestLine[1])
        let parts = target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        guard let path = parts.first.map(String.init), path.hasPrefix("/") else { return .bad }
        var query: [String: String] = [:]
        if parts.count == 2 {
            for pair in parts[1].split(separator: "&") {
                let kv = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
                guard let key = String(kv[0]).removingPercentEncoding,
                      let value = (kv.count == 2 ? String(kv[1]) : "").removingPercentEncoding else { return .bad }
                if query[key] == nil { query[key] = value }
            }
        }
        return .request(HTTPRequest(method: String(requestLine[0]), path: path, query: query, headers: headers), headLength: end + terminator.count)
    }
}
