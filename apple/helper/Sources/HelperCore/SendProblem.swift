import Darwin
import Foundation

public enum SideEffects {
    public static let none = "none"
    public static let possible = "possible"
    public static let sent = "sent"
}

extension Problem {
    func with(sideEffects: String = SideEffects.none, outcome: String? = "failed", replayed: Bool? = false, serverTime: Int? = nil) -> Problem {
        var copy = self
        copy.sideEffects = sideEffects
        copy.outcome = outcome
        copy.replayed = replayed
        copy.serverTime = serverTime
        return copy
    }

    static let setupFix = "At the Mac, run: gbrain-apple-helper send-setup"

    public static let idempotencyKeyRequired = Problem(code: "idempotency_key_required", status: 400, title: "Idempotency-Key required",
                                                      detail: "A send needs an Idempotency-Key header of 8 to 128 characters from A-Z, a-z, 0-9, dot, underscore and hyphen.")
    public static let idempotencyConflict = Problem(code: "idempotency_conflict", status: 409, title: "Idempotency-Key reused",
                                                   detail: "This Idempotency-Key was already used for a different message in the last 7 days. This message was not sent; side_effects says what happened to the first one.")
    public static let sendInProgress = Problem(code: "send_in_progress", status: 409, title: "Send in progress",
                                              detail: "A send with this Idempotency-Key is still running. Retry with the same key.",
                                              retryable: true, retryAfter: 5)
    public static let auditUnavailable = Problem(code: "audit_unavailable", status: 503, title: "Send log unavailable",
                                                detail: "The helper could not write its send log, so it sent nothing.",
                                                fix: "Check that ~/Library/Application Support/GBrain Helper/send-audit is writable and the disk isn't full.")
    public static let automationDenied = Problem(code: "automation_denied", status: 503, title: "No permission to control Messages",
                                                detail: "macOS hasn't given GBrain Helper permission to control Messages. Nothing was sent.",
                                                fix: setupFix + ", and click Allow when macOS asks.")
    public static let messagesSignedOut = Problem(code: "messages_signed_out", status: 503, title: "Messages is not signed in",
                                                 detail: "Messages on the Mac has no iMessage account turned on. Nothing was sent.",
                                                 fix: "Open Messages on the Mac and sign in to iMessage.")
    public static let messagesUnavailable = Problem(code: "messages_unavailable", status: 503, title: "Messages did not start",
                                                   detail: "Messages did not open or answer on the Mac. Nothing was sent.",
                                                   retryable: true, retryAfter: 10, fix: "Check that someone is logged in at the Mac and Messages opens.")
    public static let recipientNotIMessage = Problem(code: "recipient_not_imessage", status: 422, title: "Recipient not on iMessage",
                                                    detail: "Messages could not reach this recipient over iMessage. Nothing was sent.")
    public static func failedAfterSubmit(_ error: Int64) -> Problem {
        Problem(code: "failed_after_submit", status: 502, title: "Messages could not deliver",
                detail: "Messages took the text but reported error \(error) and did not deliver it. Retrying with the same key returns this answer.")
    }
    public static func sendFailed(_ error: Int) -> Problem {
        Problem(code: "send_failed", status: 502, title: "Messages refused the send",
                detail: "Messages refused the request with Apple Events error \(error) before sending anything.")
    }
    public static func sendRateLimited(_ detail: String, retryAfter: Int) -> Problem {
        Problem(code: "send_rate_limited", status: 429, title: "Send limit reached", detail: detail + " Nothing was sent.",
                retryable: true, retryAfter: retryAfter)
    }
    public static let requesterNotSupported = Problem(code: "requester_not_supported", status: 403, title: "Only the owner's asks are sent",
                                                     detail: "requested_by must be owner. Sends for anyone else's asks are not supported yet.")
    public static let sendDisabled = Problem(code: "send_disabled", status: 503, title: "Sending is off",
                                            detail: "Sending is turned off on this Mac. Nothing was sent.", fix: setupFix)
    public static let signatureInvalid = Problem(code: "signature_invalid", status: 401, title: "Bad signature",
                                                detail: "The GBrain-Sign header is missing, malformed, or its signature doesn't match the request.",
                                                fix: "Sign the exact body, path and Idempotency-Key with the send key this helper knows (see Sending in the README).")
    public static func timestampSkew(serverTime: Int) -> Problem {
        Problem(code: "timestamp_skew", status: 401, title: "Clock too far off",
                detail: "The signed time is more than 60 seconds from the Mac's clock.", retryable: true,
                fix: "Sign again with the current time; server_time is the Mac's clock.").with(serverTime: serverTime)
    }
    public static let nonceReplayed = Problem(code: "nonce_replayed", status: 401, title: "Nonce already used",
                                             detail: "This nonce was seen in the last 10 minutes. Sign again with a fresh nonce and the same Idempotency-Key.",
                                             retryable: true)
    public static let unknownSendKey = Problem(code: "unknown_send_key", status: 401, title: "Unknown send key",
                                              detail: "The helper has no send key with that name.",
                                              fix: "At the Mac, add the key's public half with: gbrain-apple-helper send-key add --name <name> --public-key-file -")
    public static let sendKeysUnreadable = Problem(code: "send_keys_unreadable", status: 503, title: "Send keys unreadable",
                                                  detail: "macOS would not let the helper read its send keys, usually because the helper was re-signed with a new identity.",
                                                  fix: "Reinstall GBrain Helper with the signing identity it was first installed with, then run: gbrain-apple-helper send-setup")
    public static let sendKeysTampered = Problem(code: "send_keys_tampered", status: 503, title: "Send keys failed a check",
                                                detail: "The keychain item holding the send keys can be read or changed by programs other than GBrain Helper, so the helper refuses to trust it.",
                                                fix: "Delete the io.gbrain.apple-helper send-keys item in Keychain Access, then run: gbrain-apple-helper send-setup")
    public static let ownerPresenceUnavailable = Problem(code: "owner_presence_unavailable", status: 503, title: "Nobody to confirm at the Mac",
                                                        detail: "This change needs Touch ID or the login password, and nobody confirmed it at the Mac.",
                                                        fix: "Someone logged in at the Mac must confirm with Touch ID.")
}
