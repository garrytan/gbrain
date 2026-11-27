import Contacts
import Foundation

public final class SystemContactsStore: ContactsStore {
    static let keys = [CNContactGivenNameKey, CNContactFamilyNameKey, CNContactNicknameKey, CNContactOrganizationNameKey, CNContactJobTitleKey,
                       CNContactEmailAddressesKey, CNContactPhoneNumbersKey]

    let cacheLock = NSLock()
    var idCache: (at: Date, all: [String], inDefault: Set<String>)?

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


extension SystemContactsStore: ContactsWriteStore {
    static var broadKeys: [CNKeyDescriptor] {
        [CNContactIdentifierKey, CNContactTypeKey, CNContactNamePrefixKey, CNContactGivenNameKey, CNContactMiddleNameKey, CNContactFamilyNameKey,
         CNContactPreviousFamilyNameKey, CNContactNameSuffixKey, CNContactNicknameKey, CNContactPhoneticGivenNameKey, CNContactPhoneticMiddleNameKey,
         CNContactPhoneticFamilyNameKey, CNContactPhoneticOrganizationNameKey, CNContactOrganizationNameKey, CNContactDepartmentNameKey, CNContactJobTitleKey,
         CNContactEmailAddressesKey, CNContactPhoneNumbersKey, CNContactUrlAddressesKey, CNContactPostalAddressesKey, CNContactDatesKey,
         CNContactRelationsKey, CNContactSocialProfilesKey, CNContactInstantMessageAddressesKey, CNContactBirthdayKey,
         CNContactNonGregorianBirthdayKey].map { $0 as CNKeyDescriptor }
    }

    static func raw(_ label: String) -> String {
        switch label.lowercased() {
        case "home": return CNLabelHome
        case "work": return CNLabelWork
        case "other": return CNLabelOther
        case "mobile": return CNLabelPhoneNumberMobile
        case "iphone": return CNLabelPhoneNumberiPhone
        case "main": return CNLabelPhoneNumberMain
        case "": return CNLabelOther
        default: return label
        }
    }

    static func date(_ components: DateComponents?) -> DateValue? {
        guard let components else { return nil }
        let calendar = components.calendar.map { ($0 as NSCalendar).calendarIdentifier.rawValue }
        return DateValue(year: components.year == NSDateComponentUndefined ? nil : components.year, month: components.month, day: components.day,
                         calendar: calendar == NSCalendar.Identifier.gregorian.rawValue ? nil : calendar, leapMonth: components.isLeapMonth == true ? true : nil)
    }

    static func components(_ value: DateValue) -> DateComponents {
        var components = DateComponents()
        components.year = value.year
        components.month = value.month
        components.day = value.day
        if let id = value.calendar, let calendar = NSCalendar(calendarIdentifier: NSCalendar.Identifier(rawValue: id)) { components.calendar = calendar as Calendar }
        if value.leapMonth == true { components.isLeapMonth = true }
        return components
    }

    static func full(_ contact: CNContact, groups: [String], image: Bool) -> FullCard {
        var card = FullCard()
        card.id = contact.identifier
        card.organizationType = contact.contactType == .organization
        card.namePrefix = contact.namePrefix
        card.givenName = contact.givenName
        card.middleName = contact.middleName
        card.familyName = contact.familyName
        card.previousFamilyName = contact.previousFamilyName
        card.nameSuffix = contact.nameSuffix
        card.nickname = contact.nickname
        card.phoneticGivenName = contact.phoneticGivenName
        card.phoneticMiddleName = contact.phoneticMiddleName
        card.phoneticFamilyName = contact.phoneticFamilyName
        card.phoneticOrganizationName = contact.phoneticOrganizationName
        card.organization = contact.organizationName
        card.department = contact.departmentName
        card.jobTitle = contact.jobTitle
        card.emails = contact.emailAddresses.map { Labeled(label: $0.label ?? "", value: $0.value as String) }
        card.phones = contact.phoneNumbers.map { Labeled(label: $0.label ?? "", value: $0.value.stringValue) }
        card.urls = contact.urlAddresses.map { Labeled(label: $0.label ?? "", value: $0.value as String) }
        card.postal = contact.postalAddresses.map { entry in
            var postal = PostalValue()
            let a = entry.value
            postal.street = a.street
            postal.subLocality = a.subLocality
            postal.city = a.city
            postal.subAdministrativeArea = a.subAdministrativeArea
            postal.state = a.state
            postal.postalCode = a.postalCode
            postal.country = a.country
            postal.isoCountryCode = a.isoCountryCode
            return Labeled(label: entry.label ?? "", value: postal)
        }
        card.dates = contact.dates.compactMap { entry in date(entry.value as DateComponents).map { Labeled(label: entry.label ?? "", value: $0) } }
        card.relations = contact.contactRelations.map { Labeled(label: $0.label ?? "", value: $0.value.name) }
        card.social = contact.socialProfiles.map { entry in
            var social = SocialValue()
            social.urlString = entry.value.urlString
            social.username = entry.value.username
            social.userIdentifier = entry.value.userIdentifier
            social.service = entry.value.service
            return Labeled(label: entry.label ?? "", value: social)
        }
        card.instantMessages = contact.instantMessageAddresses.map { entry in
            var im = SocialValue()
            im.username = entry.value.username
            im.service = entry.value.service
            return Labeled(label: entry.label ?? "", value: im)
        }
        card.birthday = date(contact.birthday)
        card.nonGregorianBirthday = date(contact.nonGregorianBirthday)
        if image, contact.isKeyAvailable(CNContactImageDataKey), let data = contact.imageData { card.imageData = data.base64EncodedString() }
        card.groups = groups.sorted()
        return card
    }

    static func fill(_ m: CNMutableContact, from card: FullCard) {
        m.contactType = card.organizationType ? .organization : .person
        m.namePrefix = card.namePrefix
        m.givenName = card.givenName
        m.middleName = card.middleName
        m.familyName = card.familyName
        m.previousFamilyName = card.previousFamilyName
        m.nameSuffix = card.nameSuffix
        m.nickname = card.nickname
        m.phoneticGivenName = card.phoneticGivenName
        m.phoneticMiddleName = card.phoneticMiddleName
        m.phoneticFamilyName = card.phoneticFamilyName
        m.phoneticOrganizationName = card.phoneticOrganizationName
        m.organizationName = card.organization
        m.departmentName = card.department
        m.jobTitle = card.jobTitle
        m.emailAddresses = card.emails.map { CNLabeledValue(label: raw($0.label), value: $0.value as NSString) }
        m.phoneNumbers = card.phones.map { CNLabeledValue(label: raw($0.label), value: CNPhoneNumber(stringValue: $0.value)) }
        m.urlAddresses = card.urls.map { CNLabeledValue(label: raw($0.label), value: $0.value as NSString) }
        m.postalAddresses = card.postal.map { entry in
            let a = CNMutablePostalAddress()
            a.street = entry.value.street
            a.subLocality = entry.value.subLocality
            a.city = entry.value.city
            a.subAdministrativeArea = entry.value.subAdministrativeArea
            a.state = entry.value.state
            a.postalCode = entry.value.postalCode
            a.country = entry.value.country
            a.isoCountryCode = entry.value.isoCountryCode
            return CNLabeledValue(label: raw(entry.label), value: a.copy() as! CNPostalAddress)
        }
        m.dates = card.dates.map { CNLabeledValue(label: raw($0.label), value: components($0.value) as NSDateComponents) }
        m.contactRelations = card.relations.map { CNLabeledValue(label: raw($0.label), value: CNContactRelation(name: $0.value)) }
        m.socialProfiles = card.social.map {
            CNLabeledValue(label: raw($0.label), value: CNSocialProfile(urlString: $0.value.urlString, username: $0.value.username,
                                                                         userIdentifier: $0.value.userIdentifier, service: $0.value.service))
        }
        m.instantMessageAddresses = card.instantMessages.map {
            CNLabeledValue(label: raw($0.label), value: CNInstantMessageAddress(username: $0.value.username, service: $0.value.service))
        }
        m.birthday = card.birthday.map(components)
        m.nonGregorianBirthday = card.nonGregorianBirthday.map(components)
        if let image = card.imageData { m.imageData = Data(base64Encoded: image) }
    }

    func defaultGroups(_ store: CNContactStore) throws -> [CNGroup] {
        try store.groups(matching: CNGroup.predicateForGroupsInContainer(withIdentifier: store.defaultContainerIdentifier()))
    }

    func groupNames(_ store: CNContactStore, of id: String) throws -> [String] {
        try store.groups(matching: nil).filter { group in
            try store.unifiedContacts(matching: CNContact.predicateForContactsInGroup(withIdentifier: group.identifier), keysToFetch: []).contains { $0.identifier == id }
        }.map(\.name)
    }

    func rawIds(_ store: CNContactStore, container: String?) throws -> [String] {
        let request = CNContactFetchRequest(keysToFetch: [CNContactIdentifierKey as CNKeyDescriptor])
        request.unifyResults = false
        if let container { request.predicate = CNContact.predicateForContactsInContainer(withIdentifier: container) }
        var ids: [String] = []
        try store.enumerateContacts(with: request) { contact, _ in ids.append(contact.identifier) }
        return ids
    }

    func unified(_ store: CNContactStore, _ id: String, keys: [CNKeyDescriptor]) throws -> CNContact? {
        try store.unifiedContacts(matching: CNContact.predicateForContacts(withIdentifiers: [id]), keysToFetch: keys).first
    }

    public func card(_ id: String, image: Bool) throws -> WritableCard? {
        let store = CNContactStore()
        let keys = Self.broadKeys + (image ? [CNContactImageDataKey as CNKeyDescriptor] : [])
        guard let contact = try unified(store, id, keys: keys) else { return nil }
        cacheLock.lock()
        defer { cacheLock.unlock() }
        if idCache == nil || Date().timeIntervalSince(idCache!.at) > 30 || !idCache!.all.contains(contact.identifier) {
            idCache = (Date(), try rawIds(store, container: nil), Set(try rawIds(store, container: store.defaultContainerIdentifier())))
        }
        let members = idCache!.all.filter { contact.isUnifiedWithContact(withIdentifier: $0) }
        let writable = members.count <= 1 && idCache!.inDefault.contains(contact.identifier)
        return WritableCard(card: Self.full(contact, groups: try groupNames(store, of: contact.identifier), image: image), writable: writable)
    }

    public func allCards() throws -> [FullCard] {
        let store = CNContactStore()
        var groups: [String: [String]] = [:]
        for group in try store.groups(matching: nil) {
            for member in try store.unifiedContacts(matching: CNContact.predicateForContactsInGroup(withIdentifier: group.identifier), keysToFetch: []) {
                groups[member.identifier, default: []].append(group.name)
            }
        }
        var cards: [FullCard] = []
        try store.enumerateContacts(with: CNContactFetchRequest(keysToFetch: Self.broadKeys)) { contact, _ in
            cards.append(Self.full(contact, groups: groups[contact.identifier] ?? [], image: false))
        }
        return cards
    }

    public func groupExists(_ name: String) throws -> Bool {
        try defaultGroups(CNContactStore()).contains { $0.name == name }
    }

    public func save(_ edit: CardEdit) throws -> String {
        let store = CNContactStore()
        let request = CNSaveRequest()
        func mutable(_ id: String) throws -> CNMutableContact {
            guard let contact = try unified(store, id, keys: Self.broadKeys) else { throw Problem.notFound }
            return contact.mutableCopy() as! CNMutableContact
        }
        func group(_ name: String, create: Bool) throws -> CNGroup {
            if let found = try defaultGroups(store).first(where: { $0.name == name }) { return found }
            guard create else { throw Problem.notFound }
            let made = CNMutableGroup()
            made.name = name
            let groupRequest = CNSaveRequest()
            groupRequest.add(made, toContainerWithIdentifier: nil)
            try store.execute(groupRequest)
            guard let found = try defaultGroups(store).first(where: { $0.name == name }) else { throw Problem.notFound }
            return found
        }
        var id = ""
        switch edit {
        case .create(let card):
            let m = CNMutableContact()
            Self.fill(m, from: card)
            request.add(m, toContainerWithIdentifier: nil)
            try store.execute(request)
            id = m.identifier
            for name in card.groups {
                let members = CNSaveRequest()
                members.addMember(m, to: try group(name, create: name == ContactsWriter.addedGroup))
                try store.execute(members)
            }
            return id
        case .setField(let target, let field, let value):
            let m = try mutable(target)
            switch field {
            case .givenName: m.givenName = value
            case .familyName: m.familyName = value
            case .nickname: m.nickname = value
            case .organization: m.organizationName = value
            case .jobTitle: m.jobTitle = value
            }
            request.update(m)
            id = target
        case .addValue(let target, let field, let label, let value):
            let m = try mutable(target)
            if field == .emails {
                m.emailAddresses.append(CNLabeledValue(label: Self.raw(label), value: value as NSString))
            } else {
                m.phoneNumbers.append(CNLabeledValue(label: Self.raw(label), value: CNPhoneNumber(stringValue: value)))
            }
            request.update(m)
            id = target
        case .removeValue(let target, let field, let value, let country):
            let m = try mutable(target)
            let wanted = field.key(value, countryCode: country)
            func same(_ text: String) -> Bool { text == value || (wanted != nil && field.key(text, countryCode: country) == wanted) }
            if field == .emails { m.emailAddresses.removeAll { same($0.value as String) } } else { m.phoneNumbers.removeAll { same($0.value.stringValue) } }
            request.update(m)
            id = target
        case .addToGroup(let target, let name, let create):
            request.addMember(try mutable(target), to: try group(name, create: create))
            id = target
        case .removeFromGroup(let target, let name):
            request.removeMember(try mutable(target), from: try group(name, create: false))
            id = target
        case .delete(let target):
            request.delete(try mutable(target))
            id = target
        }
        try store.execute(request)
        return id
    }
}
