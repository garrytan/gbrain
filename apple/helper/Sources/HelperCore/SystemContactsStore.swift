import Contacts
import Foundation

public final class SystemContactsStore: ContactsStore {
    static let keys = [CNContactGivenNameKey, CNContactFamilyNameKey, CNContactNicknameKey, CNContactOrganizationNameKey, CNContactJobTitleKey,
                       CNContactEmailAddressesKey, CNContactPhoneNumbersKey]

    public init() {}

    public func access() -> ContactsAccess {
        switch CNContactStore.authorizationStatus(for: .contacts) {
        case .authorized: return .allowed
        case .notDetermined: return .notDetermined
        case .restricted: return .restricted
        default: return .denied
        }
    }

    public func requestAccess(timeout: TimeInterval) -> ContactsAccess {
        let done = DispatchSemaphore(value: 0)
        CNContactStore().requestAccess(for: .contacts) { _, _ in done.signal() }
        _ = done.wait(timeout: .now() + timeout)
        return access()
    }

    public func snapshot() throws -> [ContactRecord] {
        let store = CNContactStore()
        var groups: [String: [String]] = [:]
        for group in try store.groups(matching: nil) {
            let members = try store.unifiedContacts(matching: CNContact.predicateForContactsInGroup(withIdentifier: group.identifier), keysToFetch: [])
            for member in members { groups[member.identifier, default: []].append(group.name) }
        }
        var records: [ContactRecord] = []
        try store.enumerateContacts(with: CNContactFetchRequest(keysToFetch: Self.keys.map { $0 as CNKeyDescriptor })) { contact, _ in
            records.append(ContactRecord(id: contact.identifier, fields: ContactFields(
                givenName: contact.givenName, familyName: contact.familyName, nickname: contact.nickname, organization: contact.organizationName,
                jobTitle: contact.jobTitle,
                emails: contact.emailAddresses.map { LabeledValue(label: Self.label($0.label), value: $0.value as String) },
                phones: contact.phoneNumbers.map { LabeledValue(label: Self.label($0.label), value: $0.value.stringValue) },
                groups: (groups[contact.identifier] ?? []).sorted())))
        }
        return records
    }

    static func label(_ raw: String?) -> String {
        raw.map { CNLabeledValue<NSString>.localizedString(forLabel: $0) } ?? ""
    }
}
