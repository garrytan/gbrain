import Foundation

public enum Log {
    static let lock = NSLock()
    static var sink: FileHandle?

    public static var defaultPath: String { NSHomeDirectory() + "/Library/Logs/\(HelperIdentity.executable).log" }

    public static func open(path: String) throws {
        let directory = (path as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: path) {
            FileManager.default.createFile(atPath: path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        guard let handle = FileHandle(forWritingAtPath: path) else { throw ConfigError(description: "could not open the log at \(path)") }
        handle.seekToEndOfFile()
        lock.lock()
        sink = handle
        lock.unlock()
    }

    public static func line(_ message: String) {
        let stamp = Date().formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
        lock.lock()
        defer { lock.unlock() }
        (sink ?? FileHandle.standardError).write(Data("\(stamp) \(message)\n".utf8))
    }
}
