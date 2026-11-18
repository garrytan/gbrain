import Foundation
import LocalAuthentication
import Security

public struct SendLimits: Codable, Equatable {
    public var maxPerMinute = 5
    public var maxPerHour = 30
    public var maxPerDay = 60
    public var maxPerRecipientPerHour = 10
    public var maxFirstContactPerDay = 3

    enum CodingKeys: String, CodingKey, CaseIterable {
        case maxPerMinute = "max_per_minute"
        case maxPerHour = "max_per_hour"
        case maxPerDay = "max_per_day"
        case maxPerRecipientPerHour = "max_per_recipient_per_hour"
        case maxFirstContactPerDay = "max_first_contact_per_day"
    }

    public init() {}

    public static let names = CodingKeys.allCases.map(\.rawValue)

    public func value(_ name: String) -> Int? {
        switch name {
        case CodingKeys.maxPerMinute.rawValue: return maxPerMinute
        case CodingKeys.maxPerHour.rawValue: return maxPerHour
        case CodingKeys.maxPerDay.rawValue: return maxPerDay
        case CodingKeys.maxPerRecipientPerHour.rawValue: return maxPerRecipientPerHour
        case CodingKeys.maxFirstContactPerDay.rawValue: return maxFirstContactPerDay
        default: return nil
        }
    }

    public mutating func set(_ name: String, _ value: Int) {
        switch name {
        case CodingKeys.maxPerMinute.rawValue: maxPerMinute = value
        case CodingKeys.maxPerHour.rawValue: maxPerHour = value
        case CodingKeys.maxPerDay.rawValue: maxPerDay = value
        case CodingKeys.maxPerRecipientPerHour.rawValue: maxPerRecipientPerHour = value
        case CodingKeys.maxFirstContactPerDay.rawValue: maxFirstContactPerDay = value
        default: break
        }
    }
}

public struct SendKey: Codable, Equatable {
    public let name: String
    public let publicKey: String

    enum CodingKeys: String, CodingKey {
        case name
        case publicKey = "public_key"
    }

    public init(name: String, publicKey: String) {
        self.name = name
        self.publicKey = publicKey
    }

    public var rawKey: [UInt8]? { Base64URL.decode(publicKey).flatMap { $0.count == 32 ? $0 : nil } }

    public var fingerprint: String { String(Recipient.hash(publicKey).prefix(8)) }
}

public struct SendState: Codable, Equatable {
    public var enabled = false
    public var keys: [SendKey] = []
    public var limits = SendLimits()

    public init(enabled: Bool = false, keys: [SendKey] = [], limits: SendLimits = SendLimits()) {
        self.enabled = enabled
        self.keys = keys
        self.limits = limits
    }
}

public protocol SendStateStore {
    func load() throws -> SendState?
    func save(_ state: SendState) throws
}

public struct ACLEntry: Equatable {
    public let authorizations: Set<String>
    public let applications: [String]?

    public init(authorizations: Set<String>, applications: [String]?) {
        self.authorizations = authorizations
        self.applications = applications
    }
}

public enum SendKeychainPolicy {
    public static let service = HelperIdentity.bundleId
    public static let account = "send-keys"
    static let sensitive: Set<String> = ["ACLAuthorizationAny", "ACLAuthorizationDecrypt", "ACLAuthorizationChangeACL",
                                         "ACLAuthorizationChangeOwner", "ACLAuthorizationExportClear", "ACLAuthorizationExportWrapped"]

    public static func trusted(_ entries: [ACLEntry], helperPath: String) -> Bool {
        guard !entries.isEmpty else { return false }
        for entry in entries where !entry.authorizations.isDisjoint(with: sensitive) {
            guard let applications = entry.applications else { return false }
            for path in applications where path != helperPath { return false }
        }
        return true
    }
}

public final class KeychainSendStateStore: SendStateStore {
    let helperPath: String

    public init(helperPath: String) {
        self.helperPath = helperPath
    }

    var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: SendKeychainPolicy.service,
         kSecAttrAccount as String: SendKeychainPolicy.account, kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail]
    }

    public func load() throws -> SendState? {
        var search = query
        search[kSecMatchLimit as String] = kSecMatchLimitAll
        search[kSecReturnRef as String] = true
        var found: CFTypeRef?
        let status = SecItemCopyMatching(search as CFDictionary, &found)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let items = found as? [SecKeychainItem] else { throw Problem.sendKeysUnreadable }
        guard items.count == 1 else { throw Problem.sendKeysTampered }
        guard SendKeychainPolicy.trusted(try Self.entries(items[0]), helperPath: helperPath) else { throw Problem.sendKeysTampered }
        var read = query
        read[kSecReturnData as String] = true
        var data: CFTypeRef?
        guard SecItemCopyMatching(read as CFDictionary, &data) == errSecSuccess, let bytes = data as? Data else { throw Problem.sendKeysUnreadable }
        guard let state = try? JSONDecoder().decode(SendState.self, from: bytes) else { throw Problem.sendKeysTampered }
        return state
    }

    public func save(_ state: SendState) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(state)
        if try load() != nil {
            guard SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary) == errSecSuccess else { throw Problem.sendKeysUnreadable }
            return
        }
        var me: SecTrustedApplication?
        var access: SecAccess?
        guard SecTrustedApplicationCreateFromPath(nil, &me) == errSecSuccess, let me,
              SecAccessCreate("\(HelperIdentity.appName) send keys" as CFString, [me] as CFArray, &access) == errSecSuccess, let access else {
            throw Problem.sendKeysUnreadable
        }
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccess as String] = access
        add[kSecAttrLabel as String] = "\(HelperIdentity.appName) send keys"
        guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { throw Problem.sendKeysUnreadable }
    }

    static func entries(_ item: SecKeychainItem) throws -> [ACLEntry] {
        var access: SecAccess?
        guard SecKeychainItemCopyAccess(item, &access) == errSecSuccess, let access else { throw Problem.sendKeysUnreadable }
        var list: CFArray?
        guard SecAccessCopyACLList(access, &list) == errSecSuccess, let acls = list as? [SecACL] else { throw Problem.sendKeysUnreadable }
        return acls.map { acl in
            var applications: CFArray?
            var description: CFString?
            var prompt = SecKeychainPromptSelector()
            SecACLCopyContents(acl, &applications, &description, &prompt)
            let paths = (applications as? [SecTrustedApplication])?.map { application -> String in
                var data: CFData?
                SecTrustedApplicationCopyData(application, &data)
                let bytes = (data as Data?).map(Array.init) ?? []
                return String(decoding: bytes.prefix { $0 != 0 }, as: UTF8.self)
            }
            let authorizations = Set((SecACLCopyAuthorizations(acl) as? [String]) ?? [])
            return ACLEntry(authorizations: authorizations, applications: paths)
        }
    }
}

public enum Presence: Equatable {
    case confirmed
    case unavailable
}

public protocol OwnerPresence {
    func confirm(reason: String) -> Presence
}

public final class LocalOwnerPresence: OwnerPresence {
    public init() {}

    public func confirm(reason: String) -> Presence {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else { return .unavailable }
        let done = DispatchSemaphore(value: 0)
        var result = Presence.unavailable
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, _ in
            result = ok ? .confirmed : .unavailable
            done.signal()
        }
        guard done.wait(timeout: .now() + 120) == .success else {
            context.invalidate()
            return .unavailable
        }
        return result
    }
}
