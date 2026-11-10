import Foundation

/// Port of `src/helper/providers/claude.ts`. On macOS the local Claude Code login lives in the
/// Keychain, so it is checked after the legacy credential files.
enum ClaudeProvider {
    private static let fallbackVersion = "2.1.0"
    private static let usageURL = "https://api.anthropic.com/api/oauth/usage"
    private static let accountURL = "https://api.anthropic.com/api/oauth/account"
    private static let profileURL = "https://api.anthropic.com/api/oauth/profile"

    private struct Located {
        let path: String
        let creds: JSONObject?
        let readError: String?
        let viaCliProxy: Bool
    }

    static func fetch(_ metadata: ProviderMetadata, _ options: ProviderOptions) async -> ProviderSnapshot {
        let source = options.credentialSource
        if source != .server, let located = await locateCredentials(source) {
            return await fetchLocal(metadata, located)
        }
        if source.usesServer, let server = options.server {
            if let snapshot = await fetchRemote(metadata, server) { return snapshot }
        } else if source == .server {
            return CliProxyServer.notConfigured(metadata)
        }
        return missingCredentials(metadata, source)
    }

    private static func fetchLocal(_ metadata: ProviderMetadata, _ located: Located) async -> ProviderSnapshot {
        if let readError = located.readError {
            return .status(metadata, .error, readError, "Inspect \(located.path).")
        }
        let creds = located.creds ?? [:]

        guard let token = extractToken(creds) else {
            return .status(
                metadata, .authRequired,
                "Claude credentials exist but no access token is present",
                authRemediation(located.viaCliProxy)
            )
        }

        var headers = await apiHeaders()
        headers["Authorization"] = "Bearer \(token)"

        let response: HTTPResponse
        do {
            response = try await HTTP.get(usageURL, headers: headers)
        } catch {
            return .status(
                metadata, .error, "Claude request failed: \(error.localizedDescription)",
                "Check network access or retry later."
            )
        }

        var snapshot = usageSnapshot(metadata, response, remediation: authRemediation(located.viaCliProxy))
        guard snapshot.status == .ok else { return snapshot }
        snapshot.sourceLabel = located.viaCliProxy
            ? "CLIProxyAPI + Claude OAuth API" : "Local session + Claude OAuth API"
        snapshot.accountLabel = JSONValue.nonEmpty(creds["email"]) ?? JSONValue.nonEmpty(JWT.claims(token)?["email"])
        if snapshot.accountLabel == nil {
            snapshot.accountLabel = await fetchAccountLabel(headers: headers)
        }
        snapshot.planLabel = extractPlanLabel(creds)
        return snapshot
    }

    /// Usage through the CLIProxyAPI management API: the token stays on the server. `nil` when the
    /// server has no Claude account, so automatic mode reports the usual missing-credentials state.
    private static func fetchRemote(_ metadata: ProviderMetadata, _ server: CliProxyServer) async -> ProviderSnapshot? {
        let headers = await apiHeaders()
        let account: CliProxyRemoteAccount
        let response: HTTPResponse
        do {
            guard let found = try await CliProxyRemote.findAccount(type: "claude", on: server) else { return nil }
            account = found
            response = try await CliProxyRemote.get(usageURL, headers: headers, account: account, on: server)
        } catch let error as CliProxyRemoteError {
            return .status(metadata, error.status, error.message, error.remediation)
        } catch {
            return .status(metadata, .error, "Claude request failed: \(error.localizedDescription)", "Retry later.")
        }

        var snapshot = usageSnapshot(metadata, response, remediation: remoteRemediation)
        guard snapshot.status == .ok else { return snapshot }
        snapshot.sourceLabel = "CLIProxyAPI server (\(server.label)) + Claude OAuth API"
        snapshot.accountLabel = account.email

        // The plan isn't in the auth-files listing: ask the profile endpoint, through the proxy too.
        if let profile = try? await CliProxyRemote.get(profileURL, headers: headers, account: account, on: server),
            (200..<300).contains(profile.status),
            let payload = try? JSONValue.parseObject(profile.body),
            let tier = JSONValue.nonEmpty(JSONValue.at(payload, ["organization", "rate_limit_tier"]))
        {
            snapshot.planLabel = formatPlanLabel(tier)
        }
        return snapshot
    }

    private static let remoteRemediation =
        "Make sure the Claude account is still logged in on the CLIProxyAPI server (`cli-proxy-api --claude-login`)."

    private static func apiHeaders() async -> [String: String] {
        ["anthropic-beta": "oauth-2025-04-20", "User-Agent": await userAgent()]
    }

    /// Status handling and quota parsing shared by the local and remote paths.
    private static func usageSnapshot(_ metadata: ProviderMetadata, _ response: HTTPResponse, remediation: String)
        -> ProviderSnapshot
    {
        guard (200..<300).contains(response.status) else {
            return .status(
                metadata, HTTPStatus.providerStatus(response.status),
                HTTPStatus.errorMessage(response.status, fallback: "Claude usage endpoint returned an unexpected status"),
                response.status == 429 ? HTTPStatus.rateLimitRemediation : remediation
            )
        }

        let payload: JSONObject
        do {
            payload = try JSONValue.parseObject(response.body)
        } catch {
            return .status(
                metadata, .error, "Claude payload parse failed: \(error.localizedDescription)",
                "The provider response format may have changed."
            )
        }

        var snapshot = ProviderSnapshot(metadata: metadata, status: .ok)
        if let fiveHour = payload["five_hour"] as? JSONObject {
            snapshot.primaryQuota = quota(label: "Session", data: fiveHour)
            snapshot.primaryQuota?.periodSeconds = 5 * 3600
        }
        if let sevenDay = payload["seven_day"] as? JSONObject {
            snapshot.secondaryQuota = quota(label: "Weekly", data: sevenDay)
            snapshot.secondaryQuota?.periodSeconds = 7 * 86400
        }

        if let extra = payload["extra_usage"] as? JSONObject,
            let spend = JSONValue.number(extra["spend"]), let limit = JSONValue.number(extra["limit"])
        {
            snapshot.detailLines.append("Extra usage: $\(formatFixed2(spend)) / $\(formatFixed2(limit))")
        }

        snapshot.refreshedAt = ISODate.now()

        if snapshot.primaryQuota == nil && snapshot.secondaryQuota == nil {
            snapshot.status = .error
            snapshot.errorMessage = "Claude response did not include recognizable quota windows"
            snapshot.remediation = "Inspect the helper output to update the parser."
        }
        return snapshot
    }

    // MARK: - Credentials

    private static func discoverCredentialsPath() -> String? {
        Paths.firstExisting([
            Paths.join(Paths.home, ".claude", ".credentials.json"),
            Paths.join(Paths.config, "claude", ".credentials.json"),
        ])
    }

    private static func locateCredentials(_ source: CredentialSource) async -> Located? {
        if source != .cliProxy {
            var file: Located?
            if let path = discoverCredentialsPath() {
                do {
                    file = Located(path: path, creds: try JSONValue.readObject(atPath: path), readError: nil, viaCliProxy: false)
                } catch {
                    file = Located(path: path, creds: nil, readError: error.localizedDescription, viaCliProxy: false)
                }
                // Claude Code keeps this file for MCP OAuth tokens even when signed out of claude.ai,
                // so a file without an access token falls through to the Keychain / CLIProxyAPI.
                if let creds = file?.creds, extractToken(creds) != nil { return file }
            }
            if let creds = await ClaudeKeychain.read() {
                let keychain = Located(path: ClaudeKeychain.label, creds: creds, readError: nil, viaCliProxy: false)
                if source == .local || extractToken(creds) != nil { return keychain }
            }
            if source == .local, let file { return file }
        }
        if source != .local, let account = Credentials.findCliProxyAccount(type: "claude") {
            return Located(path: account.path, creds: account.data, readError: nil, viaCliProxy: true)
        }
        return nil
    }

    private static func missingCredentials(_ metadata: ProviderMetadata, _ source: CredentialSource) -> ProviderSnapshot {
        switch source {
        case .cliProxy:
            .status(
                metadata, .unconfigured, "No Claude account found in CLIProxyAPI",
                "Add one with `cli-proxy-api --claude-login`, or switch the credential source in preferences."
            )
        case .local:
            .status(
                metadata, .unconfigured, "No local Claude credentials found",
                "Sign in with Claude Code, or switch the credential source in preferences."
            )
        case .server:
            .status(
                metadata, .unconfigured, "No Claude account found on the CLIProxyAPI server",
                "Add one on the server with `cli-proxy-api --claude-login`, or switch the credential source in preferences."
            )
        case .auto:
            .status(
                metadata, .unconfigured, "No Claude credentials found (Claude Code or CLIProxyAPI)",
                "Sign in with Claude Code, or set up a CLIProxyAPI server in Preferences → Credentials."
            )
        }
    }

    private static func authRemediation(_ viaCliProxy: Bool) -> String {
        viaCliProxy
            ? "Make sure CLIProxyAPI is running so it refreshes the token, or log in again with `cli-proxy-api --claude-login`."
            : "Refresh Claude Code with `claude auth login`."
    }

    private static func extractToken(_ creds: JSONObject) -> String? {
        if let token = JSONValue.nonEmpty(creds["accessToken"]) ?? JSONValue.nonEmpty(creds["access_token"]) {
            return token
        }
        guard let oauth = JSONValue.first(creds, "claudeAiOauth", "claude_ai_oauth") as? JSONObject else { return nil }
        return JSONValue.nonEmpty(oauth["accessToken"]) ?? JSONValue.nonEmpty(oauth["access_token"])
    }

    private static func extractPlanLabel(_ creds: JSONObject) -> String? {
        let oauth = JSONValue.first(creds, "claudeAiOauth", "claude_ai_oauth") as? JSONObject ?? [:]
        let tier = JSONValue.nonEmpty(creds["rateLimitTier"]) ?? JSONValue.nonEmpty(creds["rate_limit_tier"])
            ?? JSONValue.nonEmpty(oauth["rateLimitTier"]) ?? JSONValue.nonEmpty(oauth["rate_limit_tier"])
        let subscription = JSONValue.nonEmpty(oauth["subscriptionType"]) ?? JSONValue.nonEmpty(oauth["subscription_type"])
        guard let raw = tier ?? subscription else { return nil }
        return formatPlanLabel(raw)
    }

    private static func formatPlanLabel(_ value: String) -> String {
        var parts = value.split(separator: "_").map(String.init)
        if parts.first?.lowercased() == "default" { parts.removeFirst() }
        return parts.map { token in
            let lower = token.lowercased()
            if lower.range(of: #"^\d+x$"#, options: .regularExpression) != nil { return lower }
            return lower.prefix(1).uppercased() + lower.dropFirst()
        }.joined(separator: " ")
    }

    // MARK: - Payload

    private static func quota(label: String, data: JSONObject) -> Quota {
        let used = JSONValue.number(data["used"]) ?? JSONValue.number(data["usage"])
        // Anthropic's /oauth/usage returns `utilization` as a percentage (9.0 = 9%), not a 0-1 fraction.
        let usedPercent = JSONValue.number(data["percent_used"]) ?? JSONValue.number(data["utilization"])
        var limit = JSONValue.number(data["limit"]) ?? JSONValue.number(data["max"])
        if limit == nil && usedPercent != nil { limit = 100 }

        var usedPct: Double?
        var remainingPct: Double?
        if let usedPercent {
            usedPct = usedPercent
            remainingPct = clampPercent(100 - usedPercent)
        } else if let used, let limit, limit > 0 {
            usedPct = clampPercent(used / limit * 100)
            remainingPct = 100 - usedPct!
        }

        var quota = Quota(label: label, usedPercent: usedPct, remainingPercent: remainingPct)
        quota.usedDisplay = JSONValue.nonEmpty(data["used_display"])
            ?? used.map { "\(jsRound($0))" }
            ?? usedPct.map { "\(jsRound($0))% used" }
        quota.remainingDisplay = JSONValue.nonEmpty(data["remaining_display"])
            ?? remainingPct.map { "\(jsRound($0))% left" }
            ?? JSONValue.nonEmpty(data["reset_text"])
        quota.resetAt = ISODate.normalize(JSONValue.first(data, "resets_at", "reset_at"))
        quota.resetText = JSONValue.nonEmpty(data["resets_in"]) ?? JSONValue.nonEmpty(data["reset_text"])
        return quota
    }

    private static let userAgentLock = NSLock()
    nonisolated(unsafe) private static var cachedUserAgent: String?

    /// `claude --version` spawns Node, so it runs once per launch instead of on every refresh.
    private static func userAgent() async -> String {
        if let cached = userAgentLock.withLock({ cachedUserAgent }) { return cached }
        let agent = await detectUserAgent()
        userAgentLock.withLock { cachedUserAgent = agent }
        return agent
    }

    private static func detectUserAgent() async -> String {
        var version = fallbackVersion
        if let claude = await Shell.which("claude") {
            let result = await Shell.run([claude, "--allowed-tools", "", "--version"], timeout: 10)
            if result.success,
                let token = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
                    .split(whereSeparator: \.isWhitespace).first
            {
                version = String(token)
            }
        }
        return "claude-code/\(version)"
    }

    private static func fetchAccountLabel(headers: [String: String]) async -> String? {
        guard let response = try? await HTTP.get(accountURL, headers: headers),
            (200..<300).contains(response.status),
            let account = try? JSONValue.parseObject(response.body)
        else { return nil }
        return JSONValue.nonEmpty(account["display_name"]) ?? JSONValue.nonEmpty(account["full_name"])
            ?? JSONValue.nonEmpty(account["email_address"])
    }
}
