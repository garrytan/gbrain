import Foundation

public struct Problem: Error, Equatable {
    public static let docBase = "https://github.com/garrytan/gbrain/blob/master/apple/helper/README.md#"

    public let code: String
    public let status: Int
    public let title: String
    public let detail: String
    public let retryable: Bool
    public let retryAfter: Int?
    public let fix: String?
    public var sideEffects: String?
    public var outcome: String?
    public var replayed: Bool?
    public var serverTime: Int?

    public init(code: String, status: Int, title: String, detail: String, retryable: Bool = false, retryAfter: Int? = nil, fix: String? = nil) {
        self.code = code
        self.status = status
        self.title = title
        self.detail = detail
        self.retryable = retryable
        self.retryAfter = retryAfter
        self.fix = fix
    }

    public static var noAccess: Problem {
        Problem(code: "no_access", status: 503, title: "No access to the Messages database",
                detail: "macOS refused to open the Messages database because \(HelperIdentity.appName) has no Full Disk Access.",
                fix: "On the Mac, open System Settings > Privacy & Security > Full Disk Access, turn on \(HelperIdentity.appName), then run: launchctl kickstart -k gui/\(getuid())/\(HelperIdentity.bundleId)")
    }

    public static func dbMissing(path: String) -> Problem {
        Problem(code: "db_missing", status: 503, title: "Messages database not found",
                detail: "There is no Messages database at the configured path.",
                fix: "Check db_path in the helper's config (default \(path)) and that Messages is signed in on this Mac.")
    }

    public static let dbBusy = Problem(code: "db_busy", status: 503, title: "Messages database is busy",
                                       detail: "The database stayed locked for 2 seconds.", retryable: true, retryAfter: 2)

    public static func schemaMismatch(_ detail: String) -> Problem {
        Problem(code: "schema_mismatch", status: 503, title: "Messages database layout changed",
                detail: "A query the helper needs no longer fits the database: \(detail).",
                fix: "macOS changed the Messages database; rebuild the helper from a newer gbrain.")
    }

    public static func badParam(_ detail: String) -> Problem {
        Problem(code: "bad_param", status: 400, title: "Bad parameter", detail: detail)
    }

    public static func sourceDisabled(_ id: String) -> Problem {
        Problem(code: "source_disabled", status: 403, title: "Source turned off",
                detail: "The \(id) source is turned off in the helper's config.",
                fix: "Set sources.\(id).enabled to true in the helper's config.json, then run: launchctl kickstart -k gui/\(getuid())/\(HelperIdentity.bundleId)")
    }

    public static func insufficientScope(_ scope: String) -> Problem {
        Problem(code: "insufficient_scope", status: 403, title: "Token lacks the scope",
                detail: "This route needs a token with the \(scope) scope.")
    }

    public static let unauthorized = Problem(code: "unauthorized", status: 401, title: "Missing or wrong token",
                                             detail: "This route needs Authorization: Bearer <token>.",
                                             fix: "Send a token this helper knows as a bearer token.")
    public static let forbiddenSource = Problem(code: "forbidden_source", status: 403, title: "Caller not allowed",
                                                detail: "This listener does not accept requests from that address.")
    public static let forbiddenHost = Problem(code: "forbidden_host", status: 403, title: "Wrong Host header",
                                              detail: "The helper answers only requests addressed to 127.0.0.1 and its own port; other names, localhost included, are refused.",
                                              fix: "Call http://127.0.0.1:<port>/ directly.")
    public static let forbiddenOrigin = Problem(code: "forbidden_origin", status: 403, title: "Browser requests refused",
                                                detail: "A request with an Origin header comes from a web page, and the helper refuses it.")
    public static let overloaded = Problem(code: "overloaded", status: 503, title: "Too many requests at once",
                                           detail: "The helper handles a few requests at a time.", retryable: true, retryAfter: 1)
    public static let notFound = Problem(code: "not_found", status: 404, title: "Not found", detail: "No route or chat matches the request.")
    public static let tooLarge = Problem(code: "too_large", status: 413, title: "Request too large",
                                         detail: "Requests are limited to 8 KB, and a send's body to 32 KB.")
    public static let methodNotAllowed = Problem(code: "method_not_allowed", status: 405, title: "Method not allowed",
                                                 detail: "Read routes take GET; the send and admin routes take POST.")
    public static let lengthRequired = Problem(code: "bad_param", status: 411, title: "Content-Length required",
                                               detail: "A POST needs a Content-Length header; chunked bodies and Expect: 100-continue are refused.")
    public static let internalError = Problem(code: "internal", status: 500, title: "Internal error",
                                              detail: "The helper hit an unexpected error; the request id is in the helper's log.", retryable: true, retryAfter: 5)

    public static func from(_ error: Error, dbPath: String) -> Problem {
        if let problem = error as? Problem { return problem }
        switch error as? DBError {
        case .missing: return .dbMissing(path: dbPath)
        case .noAccess: return .noAccess
        case .busy: return .dbBusy
        case .schemaMismatch(let detail): return .schemaMismatch(detail)
        default: return .internalError
        }
    }
}

struct ProblemBody: Encodable {
    let type: String
    let title: String
    let status: Int
    let code: String
    let detail: String
    let retryable: Bool
    let fix: String?
    let requestId: String
    let sideEffects: String?
    let outcome: String?
    let replayed: Bool?
    let serverTime: Int?
}
