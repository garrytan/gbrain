import Darwin
import Foundation
import Testing
@testable import HelperCore

final class SetupWorld: @unchecked Sendable {
    let lock = WatchedLock()
    let logLock = NSLock()
    var log: [String] = []
    var config = Config(port: 8792)
    var replies: [String: AdminReply] = [:]
    var helperRunning = false
    var holds: [String: (entered: DispatchSemaphore, gate: DispatchSemaphore)] = [:]

    func note(_ event: String) {
        logLock.lock()
        log.append(event)
        logLock.unlock()
    }

    var events: [String] {
        logLock.lock()
        defer { logLock.unlock() }
        return log
    }

    func hold(_ event: String) {
        holds[event] = (DispatchSemaphore(value: 0), DispatchSemaphore(value: 0))
    }

    var setup: SendSetup {
        SendSetup(configPath: "/tmp/config.json",
                  lockConfig: { self.lock.lock(); return { self.lock.unlock() } },
                  loadConfig: { self.config },
                  saveConfig: { self.config = $0; self.note("config \($0.send?.enabled == true ? "on" : "off")") },
                  post: { fields, _ in
                      let event = "post \(fields["action"] ?? "")"
                      self.note(event)
                      if let hold = self.holds.removeValue(forKey: event) {
                          hold.entered.signal()
                          hold.gate.wait()
                      }
                      return self.replies[fields["action"] ?? ""] ?? .answered(status: 200, body: Data("{}".utf8))
                  },
                  helperRunning: { self.helperRunning })
    }
}

func loopbackSocket() -> (fd: Int32, port: UInt16) {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_addr.s_addr = inet_addr("127.0.0.1")
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    _ = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, length) } }
    _ = listen(fd, 4)
    _ = withUnsafeMutablePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) } }
    return (fd, UInt16(bigEndian: address.sin_port))
}

@Suite struct SendSetupTests {
    @Test func offTakesEffectWhileASetupWaitsAtItsTouchIDDialog() {
        let world = SetupWorld()
        world.hold("post setup")
        world.replies["setup"] = .answered(status: 503, body: Data(#"{"code":"send_disabled"}"#.utf8))
        let group = DispatchGroup()
        var setupResult = SendSetupResult(out: [], err: nil, code: -1)
        let hold = world.holds["post setup"]
        group.enter()
        Thread {
            setupResult = world.setup.on()
            group.leave()
        }.start()
        #expect(hold?.entered.wait(timeout: .now() + 10) == .success)
        let offResult = world.setup.off()
        #expect(offResult.code == 0)
        #expect(offResult.out.last == "GBrain Helper confirmed sending is off. " + SendSetup.afterStop)
        hold?.gate.signal()
        #expect(group.wait(timeout: .now() + 10) == .success)
        #expect(setupResult.code != 0)
        #expect(world.config.send?.enabled == false)
        #expect(world.events == ["post off", "config on", "post setup", "config off", "post off"])
    }

    @Test func aSetupStartedWhileOffIsInFlightWaitsForOffToFinish() {
        let world = SetupWorld()
        world.config.send = SendSetting(enabled: true)
        world.hold("post off")
        let hold = world.holds["post off"]
        let offGroup = DispatchGroup()
        var offResult = SendSetupResult(out: [], err: nil, code: -1)
        offGroup.enter()
        Thread {
            offResult = world.setup.off()
            offGroup.leave()
        }.start()
        #expect(hold?.entered.wait(timeout: .now() + 10) == .success)
        world.lock.waiting = DispatchSemaphore(value: 0)
        let setupGroup = DispatchGroup()
        setupGroup.enter()
        Thread {
            _ = world.setup.on()
            setupGroup.leave()
        }.start()
        #expect(world.lock.waiting?.wait(timeout: .now() + 10) == .success)
        #expect(world.events == ["config off", "post off"])
        hold?.gate.signal()
        #expect(offGroup.wait(timeout: .now() + 10) == .success)
        #expect(offResult.code == 0)
        #expect(setupGroup.wait(timeout: .now() + 10) == .success)
        #expect(world.events == ["config off", "post off", "post off", "config on", "post setup"])
    }

    @Test(arguments: [(AdminReply.notRunning, Int32(0)), (AdminReply.noReply, Int32(69))])
    func offWithoutAConfirmationSaysWhatHappened(reply: AdminReply, code: Int32) {
        let world = SetupWorld()
        world.config.send = SendSetting(enabled: true)
        world.replies["off"] = reply
        let result = world.setup.off()
        #expect(result.code == code)
        #expect(world.config.send?.enabled == false)
        if reply == .notRunning {
            #expect(result.out.last == "GBrain Helper isn't running, and the config switch stops every send.")
            #expect(result.err == nil)
        } else {
            #expect(result.err?.contains("didn't confirm within 40 seconds") == true)
        }
    }

    @Test func offReportsABusyHelperAsBusy() {
        let world = SetupWorld()
        world.replies["off"] = .answered(status: 503, body: Data(#"{"code":"overloaded"}"#.utf8))
        #expect(world.setup.off().err?.hasPrefix("GBrain Helper was busy (overloaded)") == true)
    }

    @Test func aRefusedConnectionReadsAsNotRunning() {
        let (fd, port) = loopbackSocket()
        Darwin.close(fd)
        #expect(AdminClient.post(port: port, fields: ["action": "off"], timeout: 5) == .notRunning)
    }

    @Test func aListenerThatNeverAnswersReadsAsNoReply() {
        let (fd, port) = loopbackSocket()
        defer { Darwin.close(fd) }
        #expect(AdminClient.post(port: port, fields: ["action": "off"], timeout: 1) == .noReply)
    }

    @Test func offIsNotConfirmedWhenNothingAnswersButAHelperProcessIsRunning() {
        let world = SetupWorld()
        world.config.send = SendSetting(enabled: true)
        world.replies["off"] = .notRunning
        world.helperRunning = true
        let result = world.setup.off()
        #expect(result.code == 69)
        #expect(world.config.send?.enabled == false)
        #expect(result.err?.contains("process is still running, so sending off isn't confirmed") == true)
        #expect(result.err?.hasSuffix("a text it was already handing over may still go out.") == true)
    }

    @Test(arguments: [("overloaded", true), ("send_keys_unreadable", false)])
    func anErrorAnswerSaysATextMayStillGoOutOnlyWhenTheHelperDidNotGetToTheSwitch(code: String, caveat: Bool) {
        let world = SetupWorld()
        world.replies["off"] = .answered(status: 503, body: Data("{\"code\":\"\(code)\"}".utf8))
        let result = world.setup.off()
        #expect(result.code == 1)
        #expect(result.err?.contains("may still go out") == caveat)
    }

    @Test func aRunningProcessIsFoundByItsExecutableName() throws {
        let sleeper = Process()
        sleeper.executableURL = URL(fileURLWithPath: "/bin/sleep")
        sleeper.arguments = ["30"]
        try sleeper.run()
        defer { sleeper.terminate() }
        #expect(HelperProcess.others(named: "sleep", in: try #require(HelperProcess.allPids())).contains(sleeper.processIdentifier))
        let own = (ProcessInfo.processInfo.arguments[0] as NSString).lastPathComponent
        #expect(!HelperProcess.others(named: own, in: try #require(HelperProcess.allPids())).contains(getpid()))
        sleeper.terminate()
        sleeper.waitUntilExit()
        #expect(!HelperProcess.others(named: "sleep", in: try #require(HelperProcess.allPids())).contains(sleeper.processIdentifier))
    }

    @Test func anUnreadableProcessTableCountsAsAHelperRunning() {
        #expect(HelperProcess.running(named: "no-process-has-this-name", in: nil))
        #expect(!HelperProcess.running(named: "no-process-has-this-name", in: [getpid()]))
        #expect(!HelperProcess.running(named: "no-process-has-this-name"))
    }
}
