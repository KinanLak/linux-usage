import GLib from "gi://GLib";

import { Credentials, type CredentialSource, type ProviderOptions } from "../credentials.js";
import { Http } from "../http.js";
import { Utils } from "../utils.js";

const PRIMARY_KEYS = ["five_hour", "fiveHour", "primary", "session"];
const SECONDARY_KEYS = ["seven_day", "weekly", "secondary", "week"];

function _discoverAuthPath(): string | null {
    const home = Utils.homeDir();
    return Utils.firstExisting([GLib.build_filenamev([home, ".codex", "auth.json"])]);
}

type LocatedAuth = {
    path: string;
    auth: any;
    readError: string | null;
    viaCliProxy: boolean;
};

function _locateAuth(source: CredentialSource): LocatedAuth | null {
    if (source !== "cli-proxy") {
        const path = _discoverAuthPath();
        if (path) {
            const { data, error } = Utils.tryReadJsonFile(path);
            const local = { path, auth: data, readError: error, viaCliProxy: false };
            // In auto mode, an auth.json without a ChatGPT token (API-key login) falls through to CLIProxyAPI.
            if (source === "local" || (data && data.tokens && data.tokens.access_token)) return local;
        }
    }
    if (source !== "local") {
        const account = Credentials.findCliProxyAccount("codex");
        if (account) {
            return { path: account.path, auth: _normalizeCliProxyAuth(account.data), readError: null, viaCliProxy: true };
        }
    }
    return null;
}

// CLIProxyAPI keeps the tokens at the top level; ~/.codex/auth.json nests them under `tokens`.
function _normalizeCliProxyAuth(raw: any): any {
    if (raw.tokens) return raw;
    return {
        tokens: {
            access_token: raw.access_token,
            id_token: raw.id_token,
            refresh_token: raw.refresh_token,
            account_id: raw.account_id,
        },
        last_refresh: raw.last_refresh,
        email: raw.email,
    };
}

function _missingAuthSnapshot(metadata: any, source: CredentialSource): any {
    if (source === "cli-proxy") {
        return Utils.statusSnapshot(
            metadata,
            "unconfigured",
            "No Codex account found in CLIProxyAPI",
            "Add one with `cli-proxy-api --codex-login`, or switch the credential source in preferences.",
        );
    }
    if (source === "local") {
        return Utils.statusSnapshot(
            metadata,
            "unconfigured",
            "No local Codex session found",
            "Sign in with the Codex CLI, or switch the credential source in preferences.",
        );
    }
    return Utils.statusSnapshot(
        metadata,
        "unconfigured",
        "No Codex credentials found (Codex CLI or CLIProxyAPI)",
        "Sign in with the Codex CLI, or add an account with `cli-proxy-api --codex-login`.",
    );
}

function _usageHeaders(token: string, accountId: string | null): Record<string, string> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (accountId) headers["ChatGPT-Account-Id"] = accountId;
    return headers;
}

function _formatNumber(value: number): string {
    return Math.abs(value - Math.round(value)) < Number.EPSILON ? `${Math.round(value)}` : value.toFixed(2);
}

function _formatDurationSeconds(seconds: number): string {
    seconds = Math.max(0, seconds);
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `Resets in ${days}d ${hours}h`;
    if (hours > 0) return `Resets in ${hours}h ${minutes}m`;
    return `Resets in ${minutes}m`;
}

function _windowLabelForSeconds(seconds: number | null, fallback: string): string {
    if (seconds === null || seconds <= 0) return fallback;
    if (seconds < 86400) return "Session";
    const days = Math.round(seconds / 86400);
    if (days === 7) return "Weekly";
    if (days >= 28 && days <= 31) return "Monthly";
    return `${days}-day`;
}

function _extractRateLimitWindow(payload: any, label: string, key: string): any | null {
    const rateLimit = payload.rate_limit;
    if (!rateLimit) return null;
    const data = rateLimit[key];
    if (!data) return null;

    const usedPercent = Utils.valueAsNumber(data.used_percent);
    const windowSeconds = Utils.valueAsNumber(data.limit_window_seconds);
    let resetAt: string | null = null;
    const timestamp = Utils.valueAsNumber(data.reset_at);
    if (timestamp !== null) {
        try {
            resetAt = new Date(timestamp * 1000).toISOString();
        } catch {
            /* ignore */
        }
    }
    let resetText: string | null = null;
    const resetAfter = Utils.valueAsNumber(data.reset_after_seconds);
    if (resetAfter !== null) resetText = _formatDurationSeconds(resetAfter);

    return {
        label: _windowLabelForSeconds(windowSeconds, label),
        usedPercent,
        remainingPercent: usedPercent !== null ? Math.max(0, Math.min(100, 100 - usedPercent)) : null,
        valueLabel: null,
        usedDisplay: usedPercent !== null ? `${Math.round(usedPercent)}% used` : null,
        remainingDisplay: usedPercent !== null ? `${Math.round(Math.max(0, 100 - usedPercent))}% left` : null,
        resetAt,
        resetText,
        periodSeconds: windowSeconds,
    };
}

function _extractWindowFromValue(label: string, data: any): any | null {
    const remaining = Utils.valueAsNumber(data.remaining) ?? Utils.valueAsNumber(data.remaining_amount);
    const limit = Utils.valueAsNumber(data.limit) ?? Utils.valueAsNumber(data.max) ?? Utils.valueAsNumber(data.quota);
    let used = Utils.valueAsNumber(data.used) ?? Utils.valueAsNumber(data.consumed);
    if (used === null && remaining !== null && limit !== null) used = limit - remaining;

    let usedPercent: number | null;
    let remainingPercent: number | null;
    if (data.used_percentage !== undefined) {
        usedPercent = Utils.valueAsNumber(data.used_percentage);
        remainingPercent = usedPercent !== null ? 100 - usedPercent : null;
    } else if (data.remaining_percentage !== undefined) {
        remainingPercent = Utils.valueAsNumber(data.remaining_percentage);
        usedPercent = remainingPercent !== null ? 100 - remainingPercent : null;
    } else {
        [usedPercent, remainingPercent] = Utils.percentPairFromRemainingLimit(remaining, limit);
    }

    if (usedPercent === null && remainingPercent === null) return null;

    const resetAtStr = data.resets_at || data.reset_at;
    let resetAt: string | null = null;
    if (typeof resetAtStr === "string") {
        try {
            resetAt = new Date(resetAtStr).toISOString();
        } catch {
            /* ignore */
        }
    }

    return {
        label,
        usedPercent,
        remainingPercent,
        valueLabel: null,
        usedDisplay: used !== null ? _formatNumber(used) : Utils.valueAsString(data.used_text) || null,
        remainingDisplay:
            remaining !== null ? _formatNumber(remaining) : Utils.valueAsString(data.remaining_text) || null,
        resetAt,
        resetText:
            Utils.valueAsString(data.resets_in) ||
            Utils.valueAsString(data.reset_in) ||
            Utils.valueAsString(data.reset_text) ||
            null,
    };
}

function _extractNamedWindow(payload: any, label: string, keys: string[]): any | null {
    for (const key of keys) {
        if (payload[key]) {
            const window = _extractWindowFromValue(label, payload[key]);
            if (window) return window;
        }
    }
    return null;
}

function _extractArrayWindow(payload: any, label: string, index: number): any | null {
    const arr =
        (Array.isArray(payload.windows) ? payload.windows : null) ||
        (Array.isArray(payload.quota_windows) ? payload.quota_windows : null);
    if (!arr || !arr[index]) return null;
    return _extractWindowFromValue(label, arr[index]);
}

function _collectDetailLines(payload: any): string[] {
    const lines: string[] = [];
    if (payload.credits) {
        const balance = Utils.valueAsNumber(payload.credits.balance);
        if (balance !== null) lines.push(`Credits: ${_formatNumber(balance)}`);
    }
    return lines;
}

function _refreshAccessToken(path: string, auth: any): { token: string; claims: any } | null {
    const refreshToken = auth.tokens && auth.tokens.refresh_token;
    if (!refreshToken) return null;

    try {
        const response = Http.httpPost(
            "https://auth.openai.com/oauth/token",
            {},
            {
                client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
                grant_type: "refresh_token",
                refresh_token: refreshToken,
                scope: "openid profile email",
            },
        );
        if (response.status < 200 || response.status >= 300) return null;

        const payload = JSON.parse(response.body);
        const accessToken = payload.access_token;
        if (!accessToken) return null;

        const idToken = payload.id_token || null;
        const newRefresh = payload.refresh_token || refreshToken;

        const updated = JSON.parse(JSON.stringify(auth));
        if (!updated.tokens) updated.tokens = {};
        updated.tokens.access_token = accessToken;
        if (idToken) updated.tokens.id_token = idToken;
        updated.tokens.refresh_token = newRefresh;
        updated.last_refresh = new Date().toISOString();

        try {
            Utils.writeJsonFile(path, updated);
        } catch {
            /* ignore write error */
        }

        const claims = (idToken ? Utils.parseJwtClaims(idToken) : null) || Utils.parseJwtClaims(accessToken);
        return { token: accessToken, claims };
    } catch {
        return null;
    }
}

function _rpcWindow(label: string, data: any): any | null {
    if (!data) return null;
    const usedPercent = typeof data.usedPercent === "number" ? data.usedPercent : null;
    const windowMinutes = Utils.valueAsNumber(data.windowDurationMins) ?? Utils.valueAsNumber(data.windowMinutes);
    const windowSeconds = windowMinutes !== null ? windowMinutes * 60 : null;
    let resetAt: string | null = null;
    if (typeof data.resetsAt === "number") {
        try {
            resetAt = new Date(data.resetsAt * 1000).toISOString();
        } catch {
            /* ignore */
        }
    }
    return {
        label: _windowLabelForSeconds(windowSeconds, label),
        usedPercent,
        remainingPercent: usedPercent !== null ? Math.max(0, Math.min(100, 100 - usedPercent)) : null,
        valueLabel: null,
        usedDisplay: usedPercent !== null ? `${Math.round(usedPercent)}% used` : null,
        remainingDisplay: usedPercent !== null ? `${Math.round(Math.max(0, 100 - usedPercent))}% left` : null,
        resetAt,
        resetText: null,
        periodSeconds: windowSeconds,
    };
}

function _fetchViaRpc(metadata: any): any | null {
    const input =
        [
            JSON.stringify({
                id: 1,
                method: "initialize",
                params: { clientInfo: { name: "linux-usage", version: "0.1.0" } },
            }),
            JSON.stringify({ method: "initialized", params: {} }),
            JSON.stringify({ id: 2, method: "account/rateLimits/read", params: {} }),
            JSON.stringify({ id: 3, method: "account/read", params: {} }),
        ].join("\n") + "\n";

    const result = Utils.runCommandWithInput(["codex", "-s", "read-only", "-a", "untrusted", "app-server"], input);

    let rateLimits: any = null;
    let account: any = null;
    let rpcError: string | null = null;

    if (result.stdout) {
        for (const line of result.stdout.split("\n")) {
            if (!line.trim()) continue;
            try {
                const msg = JSON.parse(line);
                if (msg.id === 2) {
                    if (msg.error && msg.error.message) {
                        rpcError = msg.error.message;
                    } else {
                        rateLimits = msg.result;
                    }
                } else if (msg.id === 3) {
                    account = msg.result;
                }
            } catch {
                /* skip malformed lines */
            }
        }
    }

    if (rateLimits) {
        const snapshot = Utils.baseSnapshot(metadata);
        snapshot.status = "ok";
        snapshot.sourceLabel = "Codex CLI app-server";
        snapshot.accountLabel = account?.account?.email || null;
        snapshot.planLabel = account?.account?.planType ? account.account.planType.toUpperCase() : null;

        const limits = rateLimits.rateLimits || rateLimits;
        snapshot.primaryQuota = _rpcWindow("Session", limits.primary);
        if (snapshot.primaryQuota && snapshot.primaryQuota.periodSeconds === null)
            snapshot.primaryQuota.periodSeconds = 5 * 3600;
        snapshot.secondaryQuota = _rpcWindow("Weekly", limits.secondary);
        if (snapshot.secondaryQuota && snapshot.secondaryQuota.periodSeconds === null)
            snapshot.secondaryQuota.periodSeconds = 7 * 86400;

        const balance = limits.credits?.balance;
        if (balance) snapshot.detailLines.push(`Credits: ${balance}`);

        snapshot.refreshedAt = new Date().toISOString();
        return snapshot;
    }

    const cleanedStderr = result.stderr.split("\n").map((l: string) => Utils.stripAnsi(l));
    const stderrHint = cleanedStderr.find(
        (line: string) =>
            line.includes("refresh token has already been used") ||
            line.includes("refresh token was already used") ||
            line.includes("refresh_token_reused"),
    );
    if (stderrHint) {
        return Utils.statusSnapshot(
            metadata,
            "error",
            stderrHint,
            "Run `codex logout`, then `codex login` to generate a fresh local session.",
        );
    }

    if (rpcError) {
        return Utils.statusSnapshot(metadata, "error", rpcError, _remediationForError(rpcError));
    }

    return null;
}

function _parseErrorResponse(body: string): string | null {
    try {
        const value = JSON.parse(body);
        return (value.error && value.error.message) || null;
    } catch {
        return null;
    }
}

function _remediationForError(message: string | null, viaCliProxy: boolean = false): string {
    if (viaCliProxy) {
        return "Make sure CLIProxyAPI is running so it refreshes the token, or log in again with `cli-proxy-api --codex-login`.";
    }
    const msg = message || "";
    if (
        msg.includes("refresh token has already been used") ||
        msg.includes("already used") ||
        msg.includes("refresh_token_reused")
    ) {
        return "Run `codex logout`, then `codex login` to generate a fresh local session.";
    }
    if (msg.includes("token is expired") || msg.includes("token_expired")) {
        return "Refresh your Codex login and try again.";
    }
    return "Refresh your Codex login or try again later.";
}

function fetch(metadata: any, options: ProviderOptions): any {
    const located = _locateAuth(options.credentialSource);
    if (!located) return _missingAuthSnapshot(metadata, options.credentialSource);
    const authPath = located.path;
    const viaCliProxy = located.viaCliProxy;
    if (located.readError) {
        return Utils.statusSnapshot(
            metadata,
            "error",
            located.readError,
            `Inspect ${authPath} permissions and content.`,
        );
    }
    const auth = located.auth;

    let tokenValue = auth.tokens && auth.tokens.access_token;
    if (!tokenValue) {
        return Utils.statusSnapshot(
            metadata,
            "auth_required",
            "Codex auth file exists but has no access token",
            viaCliProxy
                ? _remediationForError(null, true)
                : "Run `codex login` again to refresh the local session.",
        );
    }
    const accountId: string | null = (auth.tokens && auth.tokens.account_id) || null;

    let claims =
        (auth.tokens && auth.tokens.id_token ? Utils.parseJwtClaims(auth.tokens.id_token) : null) ||
        Utils.parseJwtClaims(tokenValue);

    let response: any;
    try {
        response = Http.httpGet("https://chatgpt.com/backend-api/wham/usage", _usageHeaders(tokenValue, accountId));
    } catch (error: any) {
        return Utils.statusSnapshot(
            metadata,
            "error",
            `Codex request failed: ${error.message || error}`,
            "Check network access or try again later.",
        );
    }

    // CLIProxyAPI owns the refresh token: refreshing here would rotate it and lock the proxy out.
    if (response.status === 401 && !viaCliProxy) {
        const refreshed = _refreshAccessToken(authPath, auth);
        if (refreshed) {
            tokenValue = refreshed.token;
            if (refreshed.claims) claims = refreshed.claims;
            try {
                response = Http.httpGet(
                    "https://chatgpt.com/backend-api/wham/usage",
                    _usageHeaders(tokenValue, accountId),
                );
            } catch (error: any) {
                return Utils.statusSnapshot(
                    metadata,
                    "error",
                    `Codex retry failed after refresh: ${error.message || error}`,
                    "Check network access or try again later.",
                );
            }
        }
    }

    if (response.status < 200 || response.status >= 300) {
        const rpcResult = viaCliProxy ? null : _fetchViaRpc(metadata);
        if (rpcResult) return rpcResult;

        const parsedError = _parseErrorResponse(response.body);
        const message =
            parsedError || Utils.errorFromStatus(response.status, "Codex usage endpoint returned an unexpected status");
        return Utils.statusSnapshot(
            metadata,
            Utils.providerStatusFromHttpStatus(response.status),
            message,
            _remediationForError(message, viaCliProxy),
        );
    }

    let payload: any;
    try {
        payload = JSON.parse(response.body);
    } catch (error: any) {
        return Utils.statusSnapshot(
            metadata,
            "error",
            `Codex payload parse failed: ${error.message || error}`,
            "The provider response format may have changed.",
        );
    }

    const snapshot = Utils.baseSnapshot(metadata);
    snapshot.status = "ok";
    snapshot.sourceLabel = viaCliProxy ? "CLIProxyAPI + OpenAI usage API" : "Local session + OpenAI usage API";
    snapshot.accountLabel =
        Utils.valueAtPath(claims, ["https://api.openai.com/profile", "email"]) ||
        (claims && claims.email) ||
        auth.email ||
        null;
    const planType =
        Utils.valueAtPath(claims, ["https://api.openai.com/auth", "chatgpt_plan_type"]) ||
        (claims && claims.plan) ||
        null;
    snapshot.planLabel = planType ? String(planType).toUpperCase() : null;

    snapshot.primaryQuota =
        _extractRateLimitWindow(payload, "Session", "primary_window") ||
        _extractNamedWindow(payload, "Session", PRIMARY_KEYS) ||
        _extractArrayWindow(payload, "Session", 0);
    if (snapshot.primaryQuota && typeof snapshot.primaryQuota.periodSeconds !== "number")
        snapshot.primaryQuota.periodSeconds = 5 * 3600;
    snapshot.secondaryQuota =
        _extractRateLimitWindow(payload, "Weekly", "secondary_window") ||
        _extractNamedWindow(payload, "Weekly", SECONDARY_KEYS) ||
        _extractArrayWindow(payload, "Weekly", 1);
    if (snapshot.secondaryQuota && typeof snapshot.secondaryQuota.periodSeconds !== "number")
        snapshot.secondaryQuota.periodSeconds = 7 * 86400;

    snapshot.detailLines = _collectDetailLines(payload);
    snapshot.refreshedAt = new Date().toISOString();

    if (!snapshot.primaryQuota && !snapshot.secondaryQuota) {
        snapshot.status = "error";
        snapshot.errorMessage = "Codex response did not include recognizable quota windows";
        snapshot.remediation = "Inspect the helper output to update the parser.";
    }

    return snapshot;
}

export const CodexProvider = { fetch };
