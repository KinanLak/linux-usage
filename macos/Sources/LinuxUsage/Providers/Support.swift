import Foundation

typealias JSONObject = [String: Any]

enum ISODate {
    nonisolated(unsafe) private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    nonisolated(unsafe) private static let plain: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private static let lock = NSLock()

    static func parse(_ string: String?) -> Date? {
        guard let string, !string.isEmpty else { return nil }
        lock.lock()
        defer { lock.unlock() }
        return fractional.date(from: string) ?? plain.date(from: string)
    }

    static func string(_ date: Date) -> String {
        lock.lock()
        defer { lock.unlock() }
        return fractional.string(from: date)
    }

    static func now() -> String { string(Date()) }

    /// Also accepts Go's nanosecond timestamps (`2026-11-10T10:37:14.546411313+01:00`), which
    /// `ISO8601DateFormatter` rejects, by trimming the fraction to milliseconds.
    static func parseLoose(_ value: Any?) -> Date? {
        guard let text = value as? String else { return nil }
        if let date = parse(text) { return date }
        let trimmed = text.replacingOccurrences(
            of: #"(\.\d{3})\d+"#, with: "$1", options: .regularExpression
        )
        return parse(trimmed)
    }

    /// Equivalent of `new Date(value).toISOString()` for a string from a provider payload.
    static func normalize(_ value: Any?) -> String? {
        guard let text = value as? String, let date = parse(text) else { return nil }
        return string(date)
    }
}

enum JSONValue {
    static func number(_ value: Any?) -> Double? {
        switch value {
        case let number as NSNumber:
            // JSONSerialization maps true/false to NSNumber too; JS `typeof` would reject them.
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return nil }
            return number.doubleValue
        case let text as String:
            return Double(text.trimmingCharacters(in: .whitespaces)).flatMap { $0.isNaN ? nil : $0 }
        default:
            return nil
        }
    }

    static func string(_ value: Any?) -> String? {
        switch value {
        case let text as String: return text
        case let number as NSNumber: return number.stringValue
        default: return nil
        }
    }

    /// JS-style truthy non-empty string.
    static func nonEmpty(_ value: Any?) -> String? {
        guard let text = value as? String, !text.isEmpty else { return nil }
        return text
    }

    /// First non-null value among `keys`. Avoids `dict["a"] ?? dict["b"]`, which on `Any?` values yields a
    /// double-wrapped optional that then fails `as?` casts.
    static func first(_ object: JSONObject, _ keys: String...) -> Any? {
        for key in keys {
            if let value = object[key], !(value is NSNull) { return value }
        }
        return nil
    }

    static func at(_ object: Any?, _ path: [String]) -> Any? {
        var current = object
        for key in path {
            guard let dict = current as? JSONObject else { return nil }
            current = dict[key]
        }
        return current
    }

    static func parseObject(_ data: Data) throws -> JSONObject {
        guard let object = try JSONSerialization.jsonObject(with: data) as? JSONObject else {
            throw ProviderError("JSON root is not an object")
        }
        return object
    }

    static func readObject(atPath path: String) throws -> JSONObject {
        try parseObject(try Data(contentsOf: URL(fileURLWithPath: path)))
    }

    static func writeObject(_ object: Any, toPath path: String) throws {
        let url = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
        try data.write(to: url, options: .atomic)
    }
}

struct ProviderError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

enum JWT {
    static func claims(_ token: String?) -> JSONObject? {
        guard let token else { return nil }
        let parts = token.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count >= 2 else { return nil }
        var payload = parts[1].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while payload.count % 4 != 0 { payload += "=" }
        guard let data = Data(base64Encoded: payload) else { return nil }
        return try? JSONValue.parseObject(data)
    }
}

enum Paths {
    static var home: String { FileManager.default.homeDirectoryForCurrentUser.path }

    static var config: String {
        ProcessInfo.processInfo.environment["XDG_CONFIG_HOME"] ?? (home as NSString).appendingPathComponent(".config")
    }

    static func join(_ parts: String...) -> String {
        NSString.path(withComponents: parts)
    }

    static func exists(_ path: String) -> Bool { FileManager.default.fileExists(atPath: path) }

    static func firstExisting(_ paths: [String]) -> String? { paths.first(where: exists) }
}

enum HTTPStatus {
    static func errorMessage(_ status: Int, fallback: String) -> String {
        if status == 401 || status == 403 { return "Authentication expired or missing" }
        if status == 429 { return "Provider rate-limited the usage request" }
        return fallback
    }

    static let rateLimitRemediation = "The usage endpoint is rate-limited; refreshes resume after the cooldown."

    static func providerStatus(_ status: Int) -> ProviderStatus {
        status == 401 || status == 403 ? .authRequired : .error
    }
}

func formatFixed2(_ value: Double) -> String { String(format: "%.2f", value) }

/// `Math.round` semantics (half up), as used by the GNOME helper.
func jsRound(_ value: Double) -> Int { Int((value + 0.5).rounded(.down)) }

func clampPercent(_ value: Double) -> Double { max(0, min(100, value)) }

func stripAnsi(_ input: String) -> String {
    input.replacingOccurrences(of: "\u{1B}\\[[0-9;]*[a-zA-Z]", with: "", options: .regularExpression)
}
