import Foundation

/// A CLIProxyAPI server reached through its management API. The proxy keeps the OAuth tokens:
/// `POST /v0/management/api-call` makes the usage request on its side, substituting `$TOKEN$` with
/// the account's access token, so no provider token ever reaches this Mac.
struct CliProxyServer: Sendable {
    let baseURL: String
    let managementKey: String

    /// Placeholder the proxy replaces with the selected account's access token.
    static let tokenPlaceholder = "Bearer $TOKEN$"

    var label: String { URL(string: baseURL)?.host ?? baseURL }

    /// The configured server, or `nil` when the URL or the management key is missing.
    static func configured(_ defaults: UserDefaults = .standard) async -> CliProxyServer? {
        guard let url = normalizeURL(defaults.string(forKey: AppSettings.Key.cliProxyURL) ?? ""),
            let key = await ManagementKeyStore.read()
        else { return nil }
        return CliProxyServer(baseURL: url, managementKey: key)
    }

    static func notConfigured(_ metadata: ProviderMetadata) -> ProviderSnapshot {
        .status(
            metadata, .unconfigured, "No CLIProxyAPI server configured",
            "Set the server URL and management key in Preferences → Credentials."
        )
    }

    /// Accepts `host:8317`, a trailing slash or the OpenAI-style `/v1` base URL clients use.
    static func normalizeURL(_ raw: String) -> String? {
        var url = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !url.isEmpty else { return nil }
        if !url.contains("://") { url = "https://\(url)" }
        while url.hasSuffix("/") { url.removeLast() }
        if url.hasSuffix("/v1") { url.removeLast(3) }
        guard let parsed = URL(string: url), parsed.host != nil else { return nil }
        return url
    }
}

struct CliProxyRemoteAccount: Sendable {
    let authIndex: String
    let name: String
    let email: String?
    /// Codex only: from the `id_token` summary in the auth-files listing.
    let chatgptAccountId: String?
    let planType: String?
}

/// Failure talking to the management API itself, as opposed to an upstream provider error.
struct CliProxyRemoteError: Error {
    let status: ProviderStatus
    let message: String
    let remediation: String
}

enum CliProxyRemote {
    private static let remediationReach =
        "Check that CLIProxyAPI is running on the server and that this Mac can reach it (Tailscale)."
    private static let remediationKey =
        "Check the management key in Preferences → Credentials (`remote-management.secret-key` in the proxy config)."

    /// Same choice as the local `~/.cli-proxy-api` lookup: enabled accounts of `type`, most recently
    /// written first (the proxy rewrites a file when it refreshes that account's token).
    static func findAccount(type: String, on server: CliProxyServer) async throws -> CliProxyRemoteAccount? {
        let response = try await management(server, method: "GET", path: "/v0/management/auth-files", body: nil)
        guard let files = (try? JSONValue.parseObject(response.body))?["files"] as? [JSONObject] else {
            throw CliProxyRemoteError(
                status: .error, message: "CLIProxyAPI returned an unexpected auth-files listing",
                remediation: "Update CLIProxyAPI on the server, or switch the credential source in preferences."
            )
        }

        let candidates = files.filter { file in
            let fileType = JSONValue.nonEmpty(file["type"]) ?? JSONValue.nonEmpty(file["provider"])
            return fileType == type && file["disabled"] as? Bool != true && file["unavailable"] as? Bool != true
                && JSONValue.nonEmpty(file["auth_index"]) != nil
        }
        let newest = candidates.max { lhs, rhs in
            (ISODate.parseLoose(lhs["modtime"]) ?? .distantPast) < (ISODate.parseLoose(rhs["modtime"]) ?? .distantPast)
        }
        guard let file = newest, let authIndex = JSONValue.nonEmpty(file["auth_index"]) else { return nil }

        let idToken = file["id_token"] as? JSONObject
        return CliProxyRemoteAccount(
            authIndex: authIndex,
            name: JSONValue.nonEmpty(file["name"]) ?? authIndex,
            email: JSONValue.nonEmpty(file["email"]) ?? JSONValue.nonEmpty(file["account"]),
            chatgptAccountId: JSONValue.nonEmpty(idToken?["chatgpt_account_id"]),
            planType: JSONValue.nonEmpty(idToken?["plan_type"])
        )
    }

    /// Runs `GET url` on the proxy with the account's token. Returns the upstream status and body.
    static func get(
        _ url: String, headers: [String: String], account: CliProxyRemoteAccount, on server: CliProxyServer
    ) async throws -> HTTPResponse {
        var header = headers
        header["Authorization"] = CliProxyServer.tokenPlaceholder
        let request: JSONObject = ["auth_index": account.authIndex, "method": "GET", "url": url, "header": header]
        let response = try await management(
            server, method: "POST", path: "/v0/management/api-call",
            body: try JSONSerialization.data(withJSONObject: request)
        )
        guard let envelope = try? JSONValue.parseObject(response.body),
            let status = JSONValue.number(envelope["status_code"])
        else {
            throw CliProxyRemoteError(
                status: .error, message: "CLIProxyAPI returned an unexpected api-call response",
                remediation: "Update CLIProxyAPI on the server (the management api-call endpoint is required)."
            )
        }
        return HTTPResponse(status: Int(status), body: Data((JSONValue.string(envelope["body"]) ?? "").utf8))
    }

    private static func management(_ server: CliProxyServer, method: String, path: String, body: Data?) async throws
        -> HTTPResponse
    {
        var headers = ["Authorization": "Bearer \(server.managementKey)"]
        let response: HTTPResponse
        do {
            if let body {
                headers["Content-Type"] = "application/json"
                response = try await HTTP.send(method: method, url: server.baseURL + path, headers: headers, body: body)
            } else {
                response = try await HTTP.get(server.baseURL + path, headers: headers)
            }
        } catch {
            // `.error` like a direct network failure: the registry falls back to the cached quotas.
            throw CliProxyRemoteError(
                status: .error,
                message: "CLIProxyAPI server \(server.label) unreachable: \(error.localizedDescription)",
                remediation: remediationReach
            )
        }

        switch response.status {
        case 200..<300:
            return response
        case 401:
            throw CliProxyRemoteError(
                status: .authRequired, message: "CLIProxyAPI rejected the management key", remediation: remediationKey
            )
        case 403:
            throw CliProxyRemoteError(
                status: .error, message: "CLIProxyAPI refuses remote management",
                remediation: "Enable `remote-management.allow-remote` in the proxy config on the server."
            )
        case 404:
            throw CliProxyRemoteError(
                status: .error, message: "CLIProxyAPI management API not found on \(server.label)",
                remediation: "Set a management secret key in the proxy config, or update CLIProxyAPI."
            )
        default:
            let detail = (JSONValue.at(try? JSONValue.parseObject(response.body), ["error"]) as? String)
                ?? "HTTP \(response.status)"
            throw CliProxyRemoteError(
                status: .error, message: "CLIProxyAPI management request failed: \(detail)", remediation: remediationReach
            )
        }
    }
}

/// The management key lives in the login Keychain. Like Claude Code's own item, it is written and
/// read through `/usr/bin/security`, which keeps the item's access list stable across rebuilds of
/// this ad-hoc signed app (no Keychain prompt after each `make install`).
enum ManagementKeyStore {
    static let service = "io.github.kinanlak.linux-usage.cli-proxy"
    static let account = "management-key"

    static func read() async -> String? {
        let result = await Shell.run(
            ["/usr/bin/security", "find-generic-password", "-s", service, "-a", account, "-w"], timeout: 10
        )
        let key = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        return result.success && !key.isEmpty ? key : nil
    }

    /// The key goes through stdin (`security -i`), never through argv where `ps` could see it.
    static func save(_ key: String) async -> Bool {
        let escaped = key.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        let command = "add-generic-password -U -s \(service) -a \(account) -l \"Linux Usage CLIProxyAPI management key\" -w \"\(escaped)\"\n"
        let result = await Shell.run(["/usr/bin/security", "-i"], input: command, timeout: 10)
        guard result.success else { return false }
        return await read() == key
    }

    static func delete() async {
        _ = await Shell.run(["/usr/bin/security", "delete-generic-password", "-s", service, "-a", account], timeout: 10)
    }
}
