import GLib from "gi://GLib";

import { Http } from "../http.js";
import { Utils } from "../utils.js";

const FALLBACK_VERSION = "2.1.0";

function _discoverCredentialsPath(): string | null {
    const home = Utils.homeDir();
    const config = Utils.configDir();
    return Utils.firstExisting([
        GLib.build_filenamev([home, ".claude", ".credentials.json"]),
        GLib.build_filenamev([config, "claude", ".credentials.json"]),
    ]);
}

function _extractToken(creds: any): string | null {
    if (creds.accessToken || creds.access_token) {
        return creds.accessToken || creds.access_token;
    }
    const oauth = creds.claudeAiOauth || creds.claude_ai_oauth;
    if (oauth) return oauth.accessToken || oauth.access_token || null;
    return null;
}

function _extractPlanLabel(creds: any): string | null {
    const oauth = creds.claudeAiOauth || creds.claude_ai_oauth || {};
    const tier = creds.rateLimitTier || creds.rate_limit_tier || oauth.rateLimitTier || oauth.rate_limit_tier;
    const subType = oauth.subscriptionType || oauth.subscription_type;
    const raw = tier || subType;
    if (!raw) return null;
    return _formatPlanLabel(raw);
}

function _formatPlanLabel(value: string): string {
    const parts = value
        .split("_")
        .filter((p: string) => p)
        .slice();
    const firstPart = parts[0];
    if (firstPart && firstPart.toLowerCase() === "default") parts.shift();
    return parts.map(_formatPlanToken).join(" ");
}

function _formatPlanToken(token: string): string {
    const lower = token.toLowerCase();
    if (lower.endsWith("x") && /^\d+x$/.test(lower)) return lower;
    return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function _quotaFromUsage(label: string, data: any): any | null {
    const used = Utils.valueAsNumber(data.used) ?? Utils.valueAsNumber(data.usage);
    let usedPercent = Utils.valueAsNumber(data.percent_used);
    if (usedPercent === null) {
        // Anthropic's /oauth/usage returns `utilization` as a percentage (e.g. 9.0 = 9%),
        // not as a 0-1 fraction — use the value as-is.
        usedPercent = Utils.valueAsNumber(data.utilization);
    }

    let limit = Utils.valueAsNumber(data.limit) ?? Utils.valueAsNumber(data.max);
    if (limit === null && usedPercent !== null) limit = 100;

    let usedPct: number | null;
    let remainingPct: number | null;
    if (usedPercent !== null) {
        usedPct = usedPercent;
        remainingPct = Math.max(0, Math.min(100, 100 - usedPercent));
    } else {
        [usedPct, remainingPct] = Utils.percentPairFromUsedLimit(used, limit);
    }

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
        usedPercent: usedPct,
        remainingPercent: remainingPct,
        valueLabel: null,
        usedDisplay:
            Utils.valueAsString(data.used_display) ||
            (used !== null ? `${Math.round(used)}` : null) ||
            (usedPct !== null ? `${Math.round(usedPct)}% used` : null),
        remainingDisplay:
            Utils.valueAsString(data.remaining_display) ||
            (remainingPct !== null ? `${Math.round(remainingPct)}% left` : null) ||
            Utils.valueAsString(data.reset_text) ||
            null,
        resetAt,
        resetText: Utils.valueAsString(data.resets_in) || Utils.valueAsString(data.reset_text) || null,
    };
}

function _detectClaudeVersion(): string {
    const result = Utils.runCommand(["claude", "--allowed-tools", "", "--version"]);
    if (!result.success) return FALLBACK_VERSION;
    const trimmed = result.stdout.trim();
    if (!trimmed) return FALLBACK_VERSION;
    const token = trimmed.split(/\s+/)[0];
    return token || FALLBACK_VERSION;
}

function _claudeUserAgent(): string {
    return `claude-code/${_detectClaudeVersion()}`;
}

function _fetchAccountLabel(token: string, userAgent: string): string | null {
    try {
        const response = Http.httpGet("https://api.anthropic.com/api/oauth/account", {
            Authorization: `Bearer ${token}`,
            "anthropic-beta": "oauth-2025-04-20",
            "User-Agent": userAgent,
        });
        if (response.status < 200 || response.status >= 300) return null;
        const account = JSON.parse(response.body);
        return account.display_name || account.full_name || account.email_address || null;
    } catch {
        return null;
    }
}

function fetch(metadata: any): any {
    const credsPath = _discoverCredentialsPath();
    if (!credsPath) {
        return Utils.statusSnapshot(
            metadata,
            "unconfigured",
            "No local Claude credentials found",
            "Sign in with Claude Code to enable quota monitoring.",
        );
    }

    let creds: any;
    try {
        creds = Utils.readJsonFile(credsPath);
    } catch (error: any) {
        return Utils.statusSnapshot(
            metadata,
            "error",
            error.message || String(error),
            "Inspect the Claude credentials file on disk.",
        );
    }

    const token = _extractToken(creds);
    if (!token) {
        return Utils.statusSnapshot(
            metadata,
            "auth_required",
            "Claude credentials exist but no access token is present",
            "Run `claude auth login` again to refresh the token.",
        );
    }

    const userAgent = _claudeUserAgent();
    let response: any;
    try {
        response = Http.httpGet("https://api.anthropic.com/api/oauth/usage", {
            Authorization: `Bearer ${token}`,
            "anthropic-beta": "oauth-2025-04-20",
            "User-Agent": userAgent,
        });
    } catch (error: any) {
        return Utils.statusSnapshot(
            metadata,
            "error",
            `Claude request failed: ${error.message || error}`,
            "Check network access or retry later.",
        );
    }

    if (response.status < 200 || response.status >= 300) {
        return Utils.statusSnapshot(
            metadata,
            Utils.providerStatusFromHttpStatus(response.status),
            Utils.errorFromStatus(response.status, "Claude usage endpoint returned an unexpected status"),
            "Refresh Claude Code with `claude auth login`.",
        );
    }

    let payload: any;
    try {
        payload = JSON.parse(response.body);
    } catch (error: any) {
        return Utils.statusSnapshot(
            metadata,
            "error",
            `Claude payload parse failed: ${error.message || error}`,
            "The provider response format may have changed.",
        );
    }

    const claims = Utils.parseJwtClaims(token);
    const snapshot = Utils.baseSnapshot(metadata);
    snapshot.status = "ok";
    snapshot.sourceLabel = "Local session + Claude OAuth API";
    snapshot.accountLabel = creds.email || (claims && claims.email) || null;
    if (!snapshot.accountLabel) {
        snapshot.accountLabel = _fetchAccountLabel(token, userAgent);
    }
    snapshot.planLabel = _extractPlanLabel(creds);

    if (payload.five_hour) {
        snapshot.primaryQuota = _quotaFromUsage("Session", payload.five_hour);
        snapshot.primaryQuota.periodSeconds = 5 * 3600;
    }
    if (payload.seven_day) {
        snapshot.secondaryQuota = _quotaFromUsage("Weekly", payload.seven_day);
        snapshot.secondaryQuota.periodSeconds = 7 * 86400;
    }

    if (payload.extra_usage) {
        const spend = Utils.valueAsNumber(payload.extra_usage.spend);
        const limit = Utils.valueAsNumber(payload.extra_usage.limit);
        if (spend !== null && limit !== null) {
            snapshot.detailLines.push(`Extra usage: $${spend.toFixed(2)} / $${limit.toFixed(2)}`);
        }
    }

    snapshot.refreshedAt = new Date().toISOString();

    if (!snapshot.primaryQuota && !snapshot.secondaryQuota) {
        snapshot.status = "error";
        snapshot.errorMessage = "Claude response did not include recognizable quota windows";
        snapshot.remediation = "Inspect the helper output to update the parser.";
    }

    return snapshot;
}

export const ClaudeProvider = { fetch };
