import Foundation

/// Port of `src/helper/providers/codex.ts`.
enum CodexProvider {
    private static let usageURL = "https://chatgpt.com/backend-api/wham/usage"
    private static let tokenURL = "https://auth.openai.com/oauth/token"
    private static let clientId = "app_EMoamEEZ73f0CkXaXp7hrann"
    private static let primaryKeys = ["five_hour", "fiveHour", "primary", "session"]
    private static let secondaryKeys = ["seven_day", "weekly", "secondary", "week"]

    private struct Located {
        let path: String
        let auth: JSONObject?
        let readError: String?
        let viaCliProxy: Bool
    }

    static func fetch(_ metadata: ProviderMetadata, _ options: ProviderOptions) async -> ProviderSnapshot {
        let source = options.credentialSource
        if source != .server, let located = locateAuth(source) {
            return await fetchLocal(metadata, located)
        }
        if source.usesServer, let server = options.server {
            if let snapshot = await fetchRemote(metadata, server) { return snapshot }
        } else if source == .server {
            return CliProxyServer.notConfigured(metadata)
        }
        return missingAuth(metadata, source)
    }

    private static func fetchLocal(_ metadata: ProviderMetadata, _ located: Located) async -> ProviderSnapshot {
        let viaCliProxy = located.viaCliProxy
        if let readError = located.readError {
            return .status(metadata, .error, readError, "Inspect \(located.path) permissions and content.")
        }
        let auth = located.auth ?? [:]
        let tokens = auth["tokens"] as? JSONObject ?? [:]

        guard var token = JSONValue.nonEmpty(tokens["access_token"]) else {
            return .status(
                metadata, .authRequired, "Codex auth file exists but has no access token",
                viaCliProxy ? remediation(for: nil, viaCliProxy: true) : "Run `codex login` again to refresh the local session."
            )
        }
        let accountId = JSONValue.nonEmpty(tokens["account_id"])
        var claims = JWT.claims(JSONValue.nonEmpty(tokens["id_token"])) ?? JWT.claims(token)

        var response: HTTPResponse
        do {
            response = try await HTTP.get(usageURL, headers: usageHeaders(token, accountId))
        } catch {
            return .status(
                metadata, .error, "Codex request failed: \(error.localizedDescription)",
                "Check network access or try again later."
            )
        }

        // CLIProxyAPI owns the refresh token: refreshing here would rotate it and lock the proxy out.
        if response.status == 401 && !viaCliProxy, let refreshed = await refreshAccessToken(path: located.path, auth: auth) {
            token = refreshed.token
            if let refreshedClaims = refreshed.claims { claims = refreshedClaims }
            do {
                response = try await HTTP.get(usageURL, headers: usageHeaders(token, accountId))
            } catch {
                return .status(
                    metadata, .error, "Codex retry failed after refresh: \(error.localizedDescription)",
                    "Check network access or try again later."
                )
            }
        }

        guard (200..<300).contains(response.status) else {
            if !viaCliProxy, let rpc = await fetchViaRpc(metadata) { return rpc }
            let parsed = (JSONValue.at(try? JSONValue.parseObject(response.body), ["error", "message"]) as? String)
            let message = parsed
                ?? HTTPStatus.errorMessage(response.status, fallback: "Codex usage endpoint returned an unexpected status")
            return .status(
                metadata, HTTPStatus.providerStatus(response.status), message,
                remediation(for: message, viaCliProxy: viaCliProxy)
            )
        }

        var snapshot = usageSnapshot(metadata, response)
        guard snapshot.status == .ok else { return snapshot }
        snapshot.sourceLabel = viaCliProxy ? "CLIProxyAPI + OpenAI usage API" : "Local session + OpenAI usage API"
        snapshot.accountLabel = JSONValue.nonEmpty(JSONValue.at(claims, ["https://api.openai.com/profile", "email"]))
            ?? JSONValue.nonEmpty(claims?["email"])
            ?? JSONValue.nonEmpty(auth["email"])
        let planType = JSONValue.string(JSONValue.at(claims, ["https://api.openai.com/auth", "chatgpt_plan_type"]))
            ?? JSONValue.string(claims?["plan"])
        snapshot.planLabel = planType.flatMap { $0.isEmpty ? nil : $0.uppercased() }
        return snapshot
    }

    /// Usage through the CLIProxyAPI management API: the token stays on the server, which also owns
    /// its refresh (so no refresh and no `codex app-server` fallback here). `nil` when the server has
    /// no Codex account.
    private static func fetchRemote(_ metadata: ProviderMetadata, _ server: CliProxyServer) async -> ProviderSnapshot? {
        let account: CliProxyRemoteAccount
        let response: HTTPResponse
        do {
            guard let found = try await CliProxyRemote.findAccount(type: "codex", on: server) else { return nil }
            account = found
            var headers: [String: String] = [:]
            if let accountId = account.chatgptAccountId { headers["ChatGPT-Account-Id"] = accountId }
            response = try await CliProxyRemote.get(usageURL, headers: headers, account: account, on: server)
        } catch let error as CliProxyRemoteError {
            return .status(metadata, error.status, error.message, error.remediation)
        } catch {
            return .status(metadata, .error, "Codex request failed: \(error.localizedDescription)", "Retry later.")
        }

        guard (200..<300).contains(response.status) else {
            let parsed = JSONValue.at(try? JSONValue.parseObject(response.body), ["error", "message"]) as? String
            let message = parsed
                ?? HTTPStatus.errorMessage(response.status, fallback: "Codex usage endpoint returned an unexpected status")
            return .status(
                metadata, HTTPStatus.providerStatus(response.status), message,
                response.status == 429
                    ? HTTPStatus.rateLimitRemediation
                    : "Make sure the Codex account is still logged in on the CLIProxyAPI server (`cli-proxy-api --codex-login`)."
            )
        }

        var snapshot = usageSnapshot(metadata, response)
        guard snapshot.status == .ok else { return snapshot }
        snapshot.sourceLabel = "CLIProxyAPI server (\(server.label)) + OpenAI usage API"
        snapshot.accountLabel = account.email
        snapshot.planLabel = account.planType?.uppercased()
        return snapshot
    }

    /// Quota parsing shared by the local and remote paths, for a 2xx response.
    private static func usageSnapshot(_ metadata: ProviderMetadata, _ response: HTTPResponse) -> ProviderSnapshot {
        let payload: JSONObject
        do {
            payload = try JSONValue.parseObject(response.body)
        } catch {
            return .status(
                metadata, .error, "Codex payload parse failed: \(error.localizedDescription)",
                "The provider response format may have changed."
            )
        }

        var snapshot = ProviderSnapshot(metadata: metadata, status: .ok)
        snapshot.primaryQuota = rateLimitWindow(payload, label: "Session", key: "primary_window")
            ?? namedWindow(payload, label: "Session", keys: primaryKeys)
            ?? arrayWindow(payload, label: "Session", index: 0)
        if snapshot.primaryQuota != nil && snapshot.primaryQuota?.periodSeconds == nil {
            snapshot.primaryQuota?.periodSeconds = 5 * 3600
        }
        snapshot.secondaryQuota = rateLimitWindow(payload, label: "Weekly", key: "secondary_window")
            ?? namedWindow(payload, label: "Weekly", keys: secondaryKeys)
            ?? arrayWindow(payload, label: "Weekly", index: 1)
        if snapshot.secondaryQuota != nil && snapshot.secondaryQuota?.periodSeconds == nil {
            snapshot.secondaryQuota?.periodSeconds = 7 * 86400
        }

        if let balance = JSONValue.number(JSONValue.at(payload, ["credits", "balance"])) {
            snapshot.detailLines = ["Credits: \(formatNumber(balance))"]
        }
        snapshot.refreshedAt = ISODate.now()

        if snapshot.primaryQuota == nil && snapshot.secondaryQuota == nil {
            snapshot.status = .error
            snapshot.errorMessage = "Codex response did not include recognizable quota windows"
            snapshot.remediation = "Inspect the helper output to update the parser."
        }
        return snapshot
    }

    // MARK: - Credentials

    private static func locateAuth(_ source: CredentialSource) -> Located? {
        if source != .cliProxy {
            let path = Paths.join(Paths.home, ".codex", "auth.json")
            if Paths.exists(path) {
                let local: Located
                do {
                    local = Located(path: path, auth: try JSONValue.readObject(atPath: path), readError: nil, viaCliProxy: false)
                } catch {
                    local = Located(path: path, auth: nil, readError: error.localizedDescription, viaCliProxy: false)
                }
                // In auto mode, an auth.json without a ChatGPT token (API-key login) falls through to CLIProxyAPI.
                let hasToken = JSONValue.nonEmpty(JSONValue.at(local.auth, ["tokens", "access_token"])) != nil
                if source == .local || hasToken { return local }
            }
        }
        if source != .local, let account = Credentials.findCliProxyAccount(type: "codex") {
            return Located(path: account.path, auth: normalizeCliProxyAuth(account.data), readError: nil, viaCliProxy: true)
        }
        return nil
    }

    /// CLIProxyAPI keeps the tokens at the top level; `~/.codex/auth.json` nests them under `tokens`.
    private static func normalizeCliProxyAuth(_ raw: JSONObject) -> JSONObject {
        if raw["tokens"] != nil { return raw }
        var tokens: JSONObject = [:]
        for key in ["access_token", "id_token", "refresh_token", "account_id"] { tokens[key] = raw[key] }
        var normalized: JSONObject = ["tokens": tokens]
        normalized["last_refresh"] = raw["last_refresh"]
        normalized["email"] = raw["email"]
        return normalized
    }

    private static func missingAuth(_ metadata: ProviderMetadata, _ source: CredentialSource) -> ProviderSnapshot {
        switch source {
        case .cliProxy:
            .status(
                metadata, .unconfigured, "No Codex account found in CLIProxyAPI",
                "Add one with `cli-proxy-api --codex-login`, or switch the credential source in preferences."
            )
        case .local:
            .status(
                metadata, .unconfigured, "No local Codex session found",
                "Sign in with the Codex CLI, or switch the credential source in preferences."
            )
        case .server:
            .status(
                metadata, .unconfigured, "No Codex account found on the CLIProxyAPI server",
                "Add one on the server with `cli-proxy-api --codex-login`, or switch the credential source in preferences."
            )
        case .auto:
            .status(
                metadata, .unconfigured, "No Codex credentials found (Codex CLI or CLIProxyAPI)",
                "Sign in with the Codex CLI, or set up a CLIProxyAPI server in Preferences → Credentials."
            )
        }
    }

    private static func usageHeaders(_ token: String, _ accountId: String?) -> [String: String] {
        var headers = ["Authorization": "Bearer \(token)"]
        if let accountId { headers["ChatGPT-Account-Id"] = accountId }
        return headers
    }

    private static func refreshAccessToken(path: String, auth: JSONObject) async -> (token: String, claims: JSONObject?)? {
        guard let refreshToken = JSONValue.nonEmpty(JSONValue.at(auth, ["tokens", "refresh_token"])) else { return nil }
        guard
            let response = try? await HTTP.post(
                tokenURL, headers: [:],
                json: [
                    "client_id": clientId,
                    "grant_type": "refresh_token",
                    "refresh_token": refreshToken,
                    "scope": "openid profile email",
                ]
            ),
            (200..<300).contains(response.status),
            let payload = try? JSONValue.parseObject(response.body),
            let accessToken = JSONValue.nonEmpty(payload["access_token"])
        else { return nil }

        let idToken = JSONValue.nonEmpty(payload["id_token"])
        var updated = auth
        var tokens = updated["tokens"] as? JSONObject ?? [:]
        tokens["access_token"] = accessToken
        if let idToken { tokens["id_token"] = idToken }
        tokens["refresh_token"] = JSONValue.nonEmpty(payload["refresh_token"]) ?? refreshToken
        updated["tokens"] = tokens
        updated["last_refresh"] = ISODate.now()
        try? JSONValue.writeObject(updated, toPath: path)

        return (accessToken, JWT.claims(idToken) ?? JWT.claims(accessToken))
    }

    // MARK: - Payload

    private static func formatNumber(_ value: Double) -> String {
        abs(value - value.rounded()) < Double.ulpOfOne ? "\(jsRound(value))" : formatFixed2(value)
    }

    static func formatDuration(_ seconds: Double) -> String {
        let seconds = Int(max(0, seconds))
        let days = seconds / 86400
        let hours = (seconds % 86400) / 3600
        let minutes = (seconds % 3600) / 60
        if days > 0 { return "Resets in \(days)d \(hours)h" }
        if hours > 0 { return "Resets in \(hours)h \(minutes)m" }
        return "Resets in \(minutes)m"
    }

    static func windowLabel(seconds: Double?, fallback: String) -> String {
        guard let seconds, seconds > 0 else { return fallback }
        if seconds < 86400 { return "Session" }
        let days = jsRound(seconds / 86400)
        if days == 7 { return "Weekly" }
        if (28...31).contains(days) { return "Monthly" }
        return "\(days)-day"
    }

    private static func percentWindow(label: String, usedPercent: Double?, windowSeconds: Double?) -> Quota {
        var quota = Quota(
            label: windowLabel(seconds: windowSeconds, fallback: label),
            usedPercent: usedPercent,
            remainingPercent: usedPercent.map { clampPercent(100 - $0) }
        )
        quota.usedDisplay = usedPercent.map { "\(jsRound($0))% used" }
        quota.remainingDisplay = usedPercent.map { "\(jsRound(max(0, 100 - $0)))% left" }
        quota.periodSeconds = windowSeconds
        return quota
    }

    private static func rateLimitWindow(_ payload: JSONObject, label: String, key: String) -> Quota? {
        guard let data = JSONValue.at(payload, ["rate_limit", key]) as? JSONObject else { return nil }
        var quota = percentWindow(
            label: label,
            usedPercent: JSONValue.number(data["used_percent"]),
            windowSeconds: JSONValue.number(data["limit_window_seconds"])
        )
        if let timestamp = JSONValue.number(data["reset_at"]) {
            quota.resetAt = ISODate.string(Date(timeIntervalSince1970: timestamp))
        }
        if let resetAfter = JSONValue.number(data["reset_after_seconds"]) {
            quota.resetText = formatDuration(resetAfter)
        }
        return quota
    }

    private static func windowFromValue(label: String, data: JSONObject) -> Quota? {
        let remaining = JSONValue.number(data["remaining"]) ?? JSONValue.number(data["remaining_amount"])
        let limit = JSONValue.number(data["limit"]) ?? JSONValue.number(data["max"]) ?? JSONValue.number(data["quota"])
        var used = JSONValue.number(data["used"]) ?? JSONValue.number(data["consumed"])
        if used == nil, let remaining, let limit { used = limit - remaining }

        var usedPercent: Double?
        var remainingPercent: Double?
        if data["used_percentage"] != nil {
            usedPercent = JSONValue.number(data["used_percentage"])
            remainingPercent = usedPercent.map { 100 - $0 }
        } else if data["remaining_percentage"] != nil {
            remainingPercent = JSONValue.number(data["remaining_percentage"])
            usedPercent = remainingPercent.map { 100 - $0 }
        } else if let remaining, let limit, limit > 0 {
            remainingPercent = clampPercent(remaining / limit * 100)
            usedPercent = 100 - remainingPercent!
        }
        if usedPercent == nil && remainingPercent == nil { return nil }

        var quota = Quota(label: label, usedPercent: usedPercent, remainingPercent: remainingPercent)
        quota.usedDisplay = used.map(formatNumber) ?? JSONValue.nonEmpty(data["used_text"])
        quota.remainingDisplay = remaining.map(formatNumber) ?? JSONValue.nonEmpty(data["remaining_text"])
        quota.resetAt = ISODate.normalize(JSONValue.first(data, "resets_at", "reset_at"))
        quota.resetText = JSONValue.nonEmpty(data["resets_in"]) ?? JSONValue.nonEmpty(data["reset_in"])
            ?? JSONValue.nonEmpty(data["reset_text"])
        return quota
    }

    private static func namedWindow(_ payload: JSONObject, label: String, keys: [String]) -> Quota? {
        for key in keys {
            if let data = payload[key] as? JSONObject, let quota = windowFromValue(label: label, data: data) {
                return quota
            }
        }
        return nil
    }

    private static func arrayWindow(_ payload: JSONObject, label: String, index: Int) -> Quota? {
        let windows = (payload["windows"] as? [Any]) ?? (payload["quota_windows"] as? [Any])
        guard let windows, index < windows.count, let data = windows[index] as? JSONObject else { return nil }
        return windowFromValue(label: label, data: data)
    }

    // MARK: - `codex app-server` fallback

    private static func rpcWindow(label: String, data: Any?) -> Quota? {
        guard let data = data as? JSONObject else { return nil }
        let usedPercent = (data["usedPercent"] as? NSNumber).map(\.doubleValue)
        let minutes = JSONValue.number(data["windowDurationMins"]) ?? JSONValue.number(data["windowMinutes"])
        var quota = percentWindow(label: label, usedPercent: usedPercent, windowSeconds: minutes.map { $0 * 60 })
        if let resetsAt = (data["resetsAt"] as? NSNumber)?.doubleValue {
            quota.resetAt = ISODate.string(Date(timeIntervalSince1970: resetsAt))
        }
        return quota
    }

    private static func fetchViaRpc(_ metadata: ProviderMetadata) async -> ProviderSnapshot? {
        guard let codex = await Shell.which("codex") else { return nil }

        let messages: [JSONObject] = [
            ["id": 1, "method": "initialize", "params": ["clientInfo": ["name": "linux-usage", "version": "0.1.0"]]],
            ["method": "initialized", "params": [String: Any]()],
            ["id": 2, "method": "account/rateLimits/read", "params": [String: Any]()],
            ["id": 3, "method": "account/read", "params": [String: Any]()],
        ]
        let input = messages
            .compactMap { try? JSONSerialization.data(withJSONObject: $0) }
            .map { String(decoding: $0, as: UTF8.self) }
            .joined(separator: "\n") + "\n"

        let result = await Shell.run([codex, "-s", "read-only", "-a", "untrusted", "app-server"], input: input, timeout: 20)

        var rateLimits: JSONObject?
        var account: JSONObject?
        var rpcError: String?
        for line in result.stdout.split(separator: "\n") where !line.trimmingCharacters(in: .whitespaces).isEmpty {
            guard let message = try? JSONValue.parseObject(Data(line.utf8)) else { continue }
            switch JSONValue.number(message["id"]) {
            case 2:
                if let error = JSONValue.nonEmpty(JSONValue.at(message, ["error", "message"])) {
                    rpcError = error
                } else {
                    rateLimits = message["result"] as? JSONObject
                }
            case 3:
                account = message["result"] as? JSONObject
            default:
                break
            }
        }

        if let rateLimits {
            var snapshot = ProviderSnapshot(metadata: metadata, status: .ok)
            snapshot.sourceLabel = "Codex CLI app-server"
            snapshot.accountLabel = JSONValue.nonEmpty(JSONValue.at(account, ["account", "email"]))
            snapshot.planLabel = JSONValue.nonEmpty(JSONValue.at(account, ["account", "planType"]))?.uppercased()

            let limits = rateLimits["rateLimits"] as? JSONObject ?? rateLimits
            snapshot.primaryQuota = rpcWindow(label: "Session", data: limits["primary"])
            if snapshot.primaryQuota != nil && snapshot.primaryQuota?.periodSeconds == nil {
                snapshot.primaryQuota?.periodSeconds = 5 * 3600
            }
            snapshot.secondaryQuota = rpcWindow(label: "Weekly", data: limits["secondary"])
            if snapshot.secondaryQuota != nil && snapshot.secondaryQuota?.periodSeconds == nil {
                snapshot.secondaryQuota?.periodSeconds = 7 * 86400
            }
            if let balance = JSONValue.string(JSONValue.at(limits, ["credits", "balance"])), !balance.isEmpty, balance != "0" {
                snapshot.detailLines.append("Credits: \(balance)")
            }
            snapshot.refreshedAt = ISODate.now()
            return snapshot
        }

        let hint = result.stderr.split(separator: "\n").map { stripAnsi(String($0)) }.first {
            $0.contains("refresh token has already been used") || $0.contains("refresh token was already used")
                || $0.contains("refresh_token_reused")
        }
        if let hint {
            return .status(
                metadata, .error, hint, "Run `codex logout`, then `codex login` to generate a fresh local session."
            )
        }
        if let rpcError {
            return .status(metadata, .error, rpcError, remediation(for: rpcError, viaCliProxy: false))
        }
        return nil
    }

    private static func remediation(for message: String?, viaCliProxy: Bool) -> String {
        if viaCliProxy {
            return "Make sure CLIProxyAPI is running so it refreshes the token, or log in again with `cli-proxy-api --codex-login`."
        }
        let message = message ?? ""
        if message.contains("refresh token has already been used") || message.contains("already used")
            || message.contains("refresh_token_reused")
        {
            return "Run `codex logout`, then `codex login` to generate a fresh local session."
        }
        if message.contains("token is expired") || message.contains("token_expired") {
            return "Refresh your Codex login and try again."
        }
        return "Refresh your Codex login or try again later."
    }
}
