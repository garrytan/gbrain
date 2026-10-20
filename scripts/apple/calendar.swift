// gbrain Apple connector: read-only Calendar helper (EventKit).
//
// Usage (run by src/core/apple/readers/calendar.ts, never from user input):
//   swift calendar.swift -- --probe            (never prompts; reports permission_not_determined before the first ask)
//   swift calendar.swift -- --request-access   (shows the macOS prompt if not yet asked; reads no event)
//   swift calendar.swift -- --from <ISO8601> --to <ISO8601> [--calendar-ids id1,id2]
//
// Protocol: prints exactly ONE JSON document on stdout.
//   success: {"items":[AppleCalendarEvent...]}  exit 0
//   failure: {"error":{"code":"...","message":"..."}}  exit non-zero
// Read-only: only requestFullAccessToEvents + events(matching:) are used; nothing is
// created, modified, or deleted. Requires macOS 14+ (Xcode Command Line Tools 15+): an older SDK
// fails to compile with "is only available in macOS 14", which gbrain maps to macos_too_old.
// Birthday calendars are skipped; subscription calendars (holidays, sports) are read only when
// listed in --calendar-ids. All-day events are emitted as date-only strings
// (YYYY-MM-DD, local calendar day, inclusive end). Timed events carry their own UTC offset.
import Foundation
import EventKit

func emit(_ doc: [String: Any], code: Int32) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: doc, options: [])) ?? Data("{\"error\":{\"code\":\"helper_failed\",\"message\":\"json encode failed\"}}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(code)
}

func fail(_ code: String, _ message: String, exitCode: Int32 = 1) -> Never {
    emit(["error": ["code": code, "message": message]], code: exitCode)
}

// ---- argument parsing (validated before touching EventKit) ----
var args = Array(CommandLine.arguments.dropFirst())
if let first = args.first, first.hasSuffix(".swift") { args.removeFirst() }
args.removeAll { $0 == "--" }

var probeOnly = false
var requestOnly = false
var fromArg: String? = nil
var toArg: String? = nil
var calendarIds: [String] = []
var i = 0
while i < args.count {
    let a = args[i]
    switch a {
    case "--probe":
        probeOnly = true
        i += 1
    case "--request-access":
        requestOnly = true
        i += 1
    case "--from", "--to", "--calendar-ids":
        guard i + 1 < args.count else { fail("helper_failed", "missing value for \(a)", exitCode: 2) }
        let v = args[i + 1]
        if a == "--from" { fromArg = v }
        else if a == "--to" { toArg = v }
        else { calendarIds = v.split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }
        i += 2
    default:
        fail("helper_failed", "unknown argument: \(a)", exitCode: 2)
    }
}

func parseISO(_ s: String) -> Date? {
    let f1 = ISO8601DateFormatter()
    f1.formatOptions = [.withInternetDateTime]
    if let d = f1.date(from: s) { return d }
    let f2 = ISO8601DateFormatter()
    f2.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f2.date(from: s)
}

var fromDate: Date? = nil
var toDate: Date? = nil
if !probeOnly && !requestOnly {
    guard let f = fromArg, let t = toArg else { fail("helper_failed", "--from and --to are required", exitCode: 2) }
    guard let fd = parseISO(f), let td = parseISO(t) else { fail("helper_failed", "--from/--to must be ISO8601", exitCode: 2) }
    guard fd < td else { fail("helper_failed", "--from must be before --to", exitCode: 2) }
    fromDate = fd
    toDate = td
}

// ---- authorization ----
let store = EKEventStore()

func denied(_ detail: String) -> Never {
    fail("permission_denied", "Calendar access is not granted (\(detail)).")
}

func checkStatusNoPrompt() {
    switch EKEventStore.authorizationStatus(for: .event) {
    case .fullAccess:
        return
    case .notDetermined:
        fail("permission_not_determined", "Calendar access has not been requested yet (macOS has not asked).")
    case .denied:
        denied("denied")
    case .restricted:
        denied("restricted")
    case .writeOnly:
        denied("write-only access is not enough; full access is required")
    @unknown default:
        denied("unknown authorization status")
    }
}

if probeOnly {
    checkStatusNoPrompt()
    emit(["items": [Any](), "status": "authorized"], code: 0)
}

final class AccessBox: @unchecked Sendable {
    var granted = false
    var message: String? = nil
}
let box = AccessBox()
let sem = DispatchSemaphore(value: 0)
if #available(macOS 14.0, *) {
    store.requestFullAccessToEvents { ok, err in
        box.granted = ok
        box.message = err?.localizedDescription
        sem.signal()
    }
} else {
    store.requestAccess(to: .event) { ok, err in
        box.granted = ok
        box.message = err?.localizedDescription
        sem.signal()
    }
}
sem.wait()
if !box.granted { denied(box.message ?? "request refused") }
if requestOnly { emit(["items": [Any](), "status": "authorized"], code: 0) }

// ---- read ----
// Birthday calendars are derived from Contacts and are not meetings: never listed.
let allCalendars = store.calendars(for: .event).filter { $0.type != .birthday }
let selected: [EKCalendar] = calendarIds.isEmpty ? allCalendars : allCalendars.filter { calendarIds.contains($0.calendarIdentifier) }
// A configured id that matches nothing is an ERROR, not an empty listing: an empty listing would
// read as "everything was deleted" to a --full sweep.
if !calendarIds.isEmpty {
    let resolvedIds = Set(selected.map { $0.calendarIdentifier })
    let missing = calendarIds.filter { !resolvedIds.contains($0) }
    if !missing.isEmpty {
        fail("selection_not_found", "Configured calendar id(s) do not match calendars on this Mac: " + missing.joined(separator: ", ") + ".")
    }
}

func isoString(_ d: Date, tz: TimeZone?) -> String {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    f.timeZone = tz ?? TimeZone.current
    return f.string(from: d)
}

func dayString(_ d: Date) -> String {
    let c = Calendar.current.dateComponents([.year, .month, .day], from: d)
    return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
}

func emailOf(_ p: EKParticipant) -> String? {
    let url = p.url
    if url.scheme?.lowercased() == "mailto" {
        let raw = url.absoluteString.dropFirst("mailto:".count)
        let addr = String(raw.split(separator: "?").first ?? "")
        return addr.removingPercentEncoding ?? addr
    }
    return nil
}

func participantDict(_ p: EKParticipant) -> [String: Any] {
    var d: [String: Any] = [:]
    if let n = p.name, !n.isEmpty { d["name"] = n }
    if let e = emailOf(p), !e.isEmpty { d["email"] = e }
    return d
}

func statusString(_ s: EKEventStatus) -> String {
    switch s {
    case .none: return "none"
    case .confirmed: return "confirmed"
    case .tentative: return "tentative"
    case .canceled: return "canceled"
    @unknown default: return "unknown"
    }
}

// EventKit silently truncates predicates wider than ~4 years, so walk the window in 3-year slices.
var events: [String: EKEvent] = [:]
var cursor = fromDate!
let finalEnd = toDate!
let slice: TimeInterval = 3 * 365 * 86400
while cursor < finalEnd {
    let end = min(cursor.addingTimeInterval(slice), finalEnd)
    let pred = store.predicateForEvents(withStart: cursor, end: end, calendars: selected.isEmpty ? nil : selected)
    for ev in store.events(matching: pred) {
        // calendarItemExternalIdentifier is shared by every occurrence of a series and survives more
        // edits than eventIdentifier; fall back to eventIdentifier, then the local item id.
        let ext: String? = ev.calendarItemExternalIdentifier
        let base = (ext?.isEmpty == false ? ext : nil) ?? ev.eventIdentifier ?? ev.calendarItemIdentifier
        let recurring = ev.hasRecurrenceRules || (ev.recurrenceRules?.isEmpty == false)
        let key = recurring ? "\(base)#\(Int(ev.startDate.timeIntervalSince1970))" : base
        events[key] = ev
    }
    cursor = end
}

var items: [[String: Any]] = []
for (key, ev) in events {
    var o: [String: Any] = [:]
    o["id"] = key
    o["calendarId"] = ev.calendar.calendarIdentifier
    o["calendarTitle"] = ev.calendar.title
    o["title"] = ev.title ?? ""
    let allDay = ev.isAllDay
    o["allDay"] = allDay
    if allDay {
        o["start"] = dayString(ev.startDate)
        var endDate: Date = ev.endDate
        // Some EventKit versions report all-day end as exclusive next-day midnight; make it inclusive.
        if endDate > ev.startDate, Calendar.current.startOfDay(for: endDate) == endDate {
            endDate = endDate.addingTimeInterval(-1)
        }
        o["end"] = dayString(endDate)
    } else {
        o["start"] = isoString(ev.startDate, tz: ev.timeZone)
        o["end"] = isoString(ev.endDate, tz: ev.timeZone)
    }
    if let l = ev.location, !l.isEmpty { o["location"] = l }
    if let n = ev.notes, !n.isEmpty { o["notes"] = n }
    if let org = ev.organizer {
        if let n = org.name, !n.isEmpty { o["organizer"] = n }
        else if let e = emailOf(org) { o["organizer"] = e }
    }
    o["attendees"] = (ev.attendees ?? []).map(participantDict)
    o["status"] = statusString(ev.status)
    o["recurring"] = ev.hasRecurrenceRules || (ev.recurrenceRules?.isEmpty == false)
    if let m = ev.lastModifiedDate { o["lastModified"] = isoString(m, tz: TimeZone(identifier: "UTC")) }
    items.append(o)
}
items.sort {
    let a = ($0["start"] as? String) ?? ""
    let b = ($1["start"] as? String) ?? ""
    if a != b { return a < b }
    return (($0["id"] as? String) ?? "") < (($1["id"] as? String) ?? "")
}
emit(["items": items], code: 0)
