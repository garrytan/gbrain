import Foundation

public enum AdminClient {
    public static func post(port: UInt16, route: String = SendService.adminRoute, fields: [String: String], timeout: TimeInterval) -> AdminReply {
        guard let url = URL(string: "http://127.0.0.1:\(port)\(route)") else { return .noReply }
        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body = "{" + fields.sorted { $0.key < $1.key }.map { "\(StrictJSON.quote($0.key)):\(StrictJSON.quote($0.value))" }.joined(separator: ",") + "}"
        request.httpBody = Data(body.utf8)
        let done = DispatchSemaphore(value: 0)
        var reply = AdminReply.noReply
        let configuration = URLSessionConfiguration.ephemeral
        configuration.connectionProxyDictionary = [:]
        URLSession(configuration: configuration).dataTask(with: request) { data, response, error in
            if let http = response as? HTTPURLResponse {
                reply = .answered(status: http.statusCode, body: data ?? Data())
            } else if (error as? URLError)?.code == .cannotConnectToHost {
                reply = .notRunning
            }
            done.signal()
        }.resume()
        guard done.wait(timeout: .now() + timeout + 5) == .success else { return .noReply }
        return reply
    }
}
