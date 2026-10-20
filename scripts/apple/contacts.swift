// gbrain Apple connector: read-only Contacts helper (Contacts framework).
//
// Usage (run by src/core/apple/readers/contacts.ts, never from user input):
//   swift contacts.swift -- --probe            (never prompts; reports permission_not_determined before the first ask)
//   swift contacts.swift -- --request-access   (shows the macOS prompt if not yet asked; reads no contact)
//   swift contacts.swift --
//
// Protocol: prints exactly ONE JSON document on stdout.
//   success: {"items":[AppleContact...]}  exit 0
//   failure: {"error":{"code":"...","message":"..."}}  exit non-zero
// Read-only: only enumerateContacts / groups(matching:) are used. Notes, photos and other
// protected-by-entitlement fields are never requested. The Contacts framework exposes no
// modification date, so `lastModified` is omitted.
import Foundation
import Contacts

func emit(_ doc: [String: Any], code: Int32) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: doc, options: [])) ?? Data("{\"error\":{\"code\":\"helper_failed\",\"message\":\"json encode failed\"}}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(code)
}

func fail(_ code: String, _ message: String, exitCode: Int32 = 1) -> Never {
    emit(["error": ["code": code, "message": message]], code: exitCode)
}

var args = Array(CommandLine.arguments.dropFirst())
if let first = args.first, first.hasSuffix(".swift") { args.removeFirst() }
args.removeAll { $0 == "--" }
var probeOnly = false
var requestOnly = false
for a in args {
    if a == "--probe" { probeOnly = true }
    else if a == "--request-access" { requestOnly = true }
    else { fail("helper_failed", "unknown argument: \(a)", exitCode: 2) }
}

func denied(_ detail: String) -> Never {
    fail("permission_denied", "Contacts access is not granted (\(detail)).")
}

let store = CNContactStore()

switch CNContactStore.authorizationStatus(for: .contacts) {
case .authorized:
    break
case .notDetermined:
    if probeOnly { fail("permission_not_determined", "Contacts access has not been requested yet (macOS has not asked).") }
    final class Box: @unchecked Sendable { var granted = false; var message: String? = nil }
    let box = Box()
    let sem = DispatchSemaphore(value: 0)
    store.requestAccess(for: .contacts) { ok, err in
        box.granted = ok
        box.message = err?.localizedDescription
        sem.signal()
    }
    sem.wait()
    if !box.granted { denied(box.message ?? "request refused") }
case .denied:
    denied("denied")
case .restricted:
    denied("restricted")
default:
    // .limited (macOS 15+) and any future status: the enumeration below returns what is visible.
    break
}

if probeOnly || requestOnly { emit(["items": [Any](), "status": "authorized"], code: 0) }

// ---- group membership: contact id -> [group names] ----
var groupsByContact: [String: [String]] = [:]
do {
    let groups = try store.groups(matching: nil)
    for g in groups {
        let pred = CNContact.predicateForContactsInGroup(withIdentifier: g.identifier)
        let keys: [CNKeyDescriptor] = [CNContactIdentifierKey as CNKeyDescriptor]
        let members = try store.unifiedContacts(matching: pred, keysToFetch: keys)
        for m in members { groupsByContact[m.identifier, default: []].append(g.name) }
    }
} catch {
    fail("helper_failed", "reading groups failed: \(error.localizedDescription)")
}

let keys: [CNKeyDescriptor] = [
    CNContactIdentifierKey as CNKeyDescriptor,
    CNContactGivenNameKey as CNKeyDescriptor,
    CNContactFamilyNameKey as CNKeyDescriptor,
    CNContactNicknameKey as CNKeyDescriptor,
    CNContactOrganizationNameKey as CNKeyDescriptor,
    CNContactJobTitleKey as CNKeyDescriptor,
    CNContactEmailAddressesKey as CNKeyDescriptor,
    CNContactPhoneNumbersKey as CNKeyDescriptor,
]
let request = CNContactFetchRequest(keysToFetch: keys)
request.unifyResults = true
request.sortOrder = .none

var items: [[String: Any]] = []
do {
    try store.enumerateContacts(with: request) { c, _ in
        var o: [String: Any] = ["id": c.identifier]
        if !c.givenName.isEmpty { o["givenName"] = c.givenName }
        if !c.familyName.isEmpty { o["familyName"] = c.familyName }
        if !c.nickname.isEmpty { o["nickname"] = c.nickname }
        if !c.organizationName.isEmpty { o["organization"] = c.organizationName }
        if !c.jobTitle.isEmpty { o["jobTitle"] = c.jobTitle }
        o["emails"] = c.emailAddresses.map { String($0.value) }.filter { !$0.isEmpty }
        o["phones"] = c.phoneNumbers.map { $0.value.stringValue }.filter { !$0.isEmpty }
        o["groups"] = (groupsByContact[c.identifier] ?? []).sorted()
        items.append(o)
    }
} catch {
    let ns = error as NSError
    if ns.domain == CNErrorDomain && ns.code == CNError.authorizationDenied.rawValue {
        denied("denied")
    }
    fail("helper_failed", "enumerateContacts failed: \(error.localizedDescription)")
}
items.sort { (($0["id"] as? String) ?? "") < (($1["id"] as? String) ?? "") }
emit(["items": items], code: 0)
