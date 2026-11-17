import Darwin
import Foundation

public enum IPv4 {
    public static func parse(_ string: String) -> UInt32? {
        var address = in_addr()
        guard string.withCString({ inet_pton(AF_INET, $0, &address) }) == 1 else { return nil }
        return UInt32(bigEndian: address.s_addr)
    }

    public static func string(_ ip: UInt32) -> String {
        "\(ip >> 24 & 0xFF).\(ip >> 16 & 0xFF).\(ip >> 8 & 0xFF).\(ip & 0xFF)"
    }

    public static func isTailnet(_ ip: UInt32) -> Bool {
        ip & 0xFFC0_0000 == 0x6440_0000
    }

    public static func isLoopback(_ ip: UInt32) -> Bool {
        ip >> 24 == 127
    }
}

public enum Interfaces {
    public static func ipv4() -> [UInt32: String] {
        var result: [UInt32: String] = [:]
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0 else { return result }
        defer { freeifaddrs(head) }
        var cursor = head
        while let entry = cursor {
            if let address = entry.pointee.ifa_addr, address.pointee.sa_family == sa_family_t(AF_INET) {
                let ip = address.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { UInt32(bigEndian: $0.pointee.sin_addr.s_addr) }
                result[ip] = String(cString: entry.pointee.ifa_name)
            }
            cursor = entry.pointee.ifa_next
        }
        return result
    }
}

public enum BindPolicy {
    public static func problem(host: UInt32, interfaces: [UInt32: String]) -> String? {
        guard IPv4.isTailnet(host) else { return "host \(IPv4.string(host)) is not a Tailscale address (100.64.0.0/10)" }
        guard let name = interfaces[host] else { return "host \(IPv4.string(host)) is not on any interface yet" }
        guard name.hasPrefix("utun") else { return "host \(IPv4.string(host)) is on \(name), not a Tailscale utun interface" }
        return nil
    }
}
