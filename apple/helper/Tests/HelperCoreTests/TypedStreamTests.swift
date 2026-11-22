import Foundation
import Testing
@testable import HelperCore

@Suite struct TypedStreamTests {
    static let hello = hex("040b73747265616d747970656481e803840140848484124e5341747472696275746564537472696e67008484084e534f626a656374008592848484084e53537472696e67019484012b0548656c6c6f86")

    @Test func decodesKnownVector() {
        #expect(TypedStream.decodeText(Self.hello) == .text("Hello"))
    }

    @Test(arguments: [0, 1, 127, 128, 255, 256, 32767, 32768, 70000])
    func decodesArchivedLengths(length: Int) {
        let string = String(repeating: "a", count: length)
        #expect(TypedStream.decodeText(archive(string)) == .text(string))
        #expect(TypedStream.decodeText(archive(string, attributes: true)) == .text(string))
    }

    @Test func decodesUnicode() {
        for string in ["héllo wörld", "👋🏽 hi there", "日本語のテキスト", "line one\nline two", "\u{FFFC}with attachment"] {
            #expect(TypedStream.decodeText(archive(string)) == .text(string))
        }
    }

    @Test func agreesWithFoundation() {
        for string in ["short", String(repeating: "é", count: 300), "🙂🙃"] {
            let blob = archive(string, attributes: true)
            let foundation = (NSUnarchiver.unarchiveObject(with: Data(blob)) as? NSAttributedString)?.string
            #expect(TypedStream.decodeText(blob) == .text(foundation ?? "<nil>"))
        }
    }

    @Test func rejectsGarbage() {
        #expect(TypedStream.decodeText([]) == .undecodable)
        #expect(TypedStream.decodeText(TypedStream.header) == .undecodable)
        #expect(TypedStream.decodeText(Array("not a typedstream".utf8)) == .undecodable)
        #expect(TypedStream.decodeText(TypedStream.header + [0x08] + Array("NSString".utf8) + [0x01, 0x94, 0x84, 0x01, 0x2B, 0x7F]) == .undecodable)
        #expect(TypedStream.decodeText(TypedStream.header + [0x08] + Array("NSString".utf8) + [0x01, 0x94, 0x84, 0x01, 0x2B, 0x82, 0xFF, 0xFF, 0xFF, 0xFF]) == .undecodable)
        #expect(TypedStream.decodeText(TypedStream.header + [0x08] + Array("NSString".utf8) + [0x01, 0x94, 0x84, 0x01, 0x2B, 0x02, 0xC3, 0x28]) == .undecodable)
    }

    @Test func survivesTruncationAndMutation() {
        let blob = archive("a message long enough to matter, with ünïcödé", attributes: true)
        for end in 0..<blob.count { _ = TypedStream.decodeText(Array(blob[0..<end])) }
        var random = SplitMix(state: 42)
        for _ in 0..<5000 {
            var mutated = blob
            for _ in 0..<Int.random(in: 1...4, using: &random) {
                mutated[Int.random(in: 0..<mutated.count, using: &random)] = UInt8.random(in: 0...255, using: &random)
            }
            _ = TypedStream.decodeText(mutated)
        }
        for _ in 0..<2000 {
            let tail = (0..<Int.random(in: 0...64, using: &random)).map { _ in UInt8.random(in: 0...255, using: &random) }
            _ = TypedStream.decodeText(TypedStream.header + tail)
        }
    }
}

@Suite struct AppleTimeTests {
    @Test func convertsNanosecondsAndSeconds() {
        #expect(AppleTime.iso(fromRaw: 788_918_400_000_000_000) == "2026-01-01T00:00:00.000Z")
        #expect(AppleTime.iso(fromRaw: 788_918_400) == "2026-01-01T00:00:00.000Z")
        #expect(AppleTime.raw(from: AppleTime.parseISO("2026-01-01T00:00:00Z")!) == 788_918_400_000_000_000)
        #expect(AppleTime.parseISO("2026-01-01T00:00:00.250Z") != nil)
        #expect(AppleTime.parseISO("yesterday") == nil)
    }

    @Test func extremeTimesClampInsteadOfCrashing() {
        #expect(AppleTime.raw(from: Date(timeIntervalSince1970: -62_135_596_800)) == Int64.min)
        #expect(AppleTime.raw(from: Date(timeIntervalSince1970: 253_402_214_400)) == Int64.max)
        #expect(AppleTime.nanoseconds(fromRaw: Int64.min) == Int64.min)
        #expect(AppleTime.nanoseconds(fromRaw: 50_000_000_000) == Int64.max)
        #expect(AppleTime.nanoseconds(fromRaw: -50_000_000_000) == Int64.min)
    }
}
