import Foundation

public enum AdminClient {
    public static func post(port: UInt16, fields: [String: String], timeout: TimeInterval) -> (status: Int, body: Data)? {
        guard let url = URL(string: "http://127.0.0.1:\(port)\(SendService.adminRoute)") else { return nil }
        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body = "{" + fields.sorted { $0.key < $1.key }.map { "\(StrictJSON.quote($0.key)):\(StrictJSON.quote($0.value))" }.joined(separator: ",") + "}"
        request.httpBody = Data(body.utf8)
        let done = DispatchSemaphore(value: 0)
        var result: (Int, Data)?
        let configuration = URLSessionConfiguration.ephemeral
        configuration.connectionProxyDictionary = [:]
        URLSession(configuration: configuration).dataTask(with: request) { data, response, _ in
            if let http = response as? HTTPURLResponse { result = (http.statusCode, data ?? Data()) }
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + timeout + 5)
        return result
    }
}
