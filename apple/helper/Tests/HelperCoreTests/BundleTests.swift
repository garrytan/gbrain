import Foundation
import Testing
@testable import HelperCore

func bundleFile(_ name: String) throws -> [String: Any] {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let data = try Data(contentsOf: root.appendingPathComponent("Bundle").appendingPathComponent(name))
    guard let plist = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else {
        throw CocoaError(.propertyListReadCorrupt)
    }
    return plist
}

@Suite struct BundleTests {
    @Test func infoPlistNamesTheHelper() throws {
        let info = try bundleFile("Info.plist")
        #expect(info["CFBundleIdentifier"] as? String == HelperIdentity.bundleId)
        #expect(info["CFBundleExecutable"] as? String == HelperIdentity.executable)
        #expect(info["CFBundleName"] as? String == HelperIdentity.appName)
        #expect(info["CFBundleDisplayName"] as? String == HelperIdentity.appName)
        #expect(info["CFBundlePackageType"] as? String == "APPL")
        #expect(info["LSUIElement"] as? Bool == true)
        #expect(info["LSMinimumSystemVersion"] as? String == "13.0")
        #expect((info["NSAppleEventsUsageDescription"] as? String)?.isEmpty == false)
        #expect(info["CFBundleShortVersionString"] is String)
    }

    @Test func backgroundAgentRunsTheBundledProgram() throws {
        let agent = try bundleFile("\(HelperIdentity.bundleId).plist")
        #expect(agent["Label"] as? String == HelperIdentity.bundleId)
        #expect(agent["BundleProgram"] as? String == "Contents/MacOS/\(HelperIdentity.executable)")
        #expect(agent["ProgramArguments"] as? [String] == [HelperIdentity.executable, "serve"])
        #expect(agent["RunAtLoad"] as? Bool == true)
        #expect(agent["Program"] == nil)
    }

    @Test func entitlementsAllowAppleEventsOnly() throws {
        let entitlements = try bundleFile("\(HelperIdentity.executable).entitlements")
        #expect(entitlements.keys.sorted() == ["com.apple.security.automation.apple-events"])
        #expect(entitlements["com.apple.security.automation.apple-events"] as? Bool == true)
    }
}
