import Foundation

struct HTTPResponse: Sendable {
    let status: Int
    let body: Data

    var text: String { String(decoding: body, as: UTF8.self) }
}

enum HTTP {
    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 10
        configuration.timeoutIntervalForResource = 20
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpCookieStorage = nil
        return URLSession(configuration: configuration)
    }()

    static func get(_ url: String, headers: [String: String]) async throws -> HTTPResponse {
        try await send(method: "GET", url: url, headers: headers, body: nil)
    }

    static func post(_ url: String, headers: [String: String], json: Any) async throws -> HTTPResponse {
        var headers = headers
        headers["Content-Type"] = "application/json"
        return try await send(
            method: "POST", url: url, headers: headers,
            body: try JSONSerialization.data(withJSONObject: json)
        )
    }

    static func send(method: String, url: String, headers: [String: String], body: Data?) async throws
        -> HTTPResponse
    {
        guard let target = URL(string: url) else { throw ProviderError("Invalid URL \(url)") }
        var request = URLRequest(url: target)
        request.httpMethod = method
        request.httpBody = body
        for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
        let (data, response) = try await session.data(for: request)
        return HTTPResponse(status: (response as? HTTPURLResponse)?.statusCode ?? 0, body: data)
    }
}
