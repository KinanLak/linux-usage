import GLib from "gi://GLib";

import { Http } from "../http.js";
import { Utils } from "../utils.js";

function _getToken(): string | null {
    return GLib.getenv("GITHUB_TOKEN") || GLib.getenv("GH_TOKEN") || Utils.ghCliToken();
}

function _quotaFromRemaining(label: string, data: any): any | null {
    const unlimited = data.unlimited === true;
    let remainingPercent =
        Utils.valueAsNumber(data.percentRemaining) ??
        Utils.valueAsNumber(data.remainingPercent) ??
        Utils.valueAsNumber(data.percent_remaining);
    if (remainingPercent !== null) {
        remainingPercent = Math.max(0, Math.min(100, remainingPercent));
    }
    const usedPercent = unlimited
        ? null
        : remainingPercent !== null
          ? Math.max(0, Math.min(100, 100 - remainingPercent))
          : null;

    return {
        label,
        usedPercent,
        remainingPercent,
        valueLabel: unlimited ? "Included" : null,
        usedDisplay: usedPercent !== null ? `${Math.round(usedPercent)}% used` : null,
        remainingDisplay: null,
        resetAt: null,
        resetText: null,
    };
}

function _parseResetDate(text: string): { resetAt: string; resetText: string } | null {
    try {
        const resetAt = new Date(text);
        if (isNaN(resetAt.getTime())) return null;
        const remaining = resetAt.getTime() - Date.now();
        const totalMinutes = Math.max(0, Math.floor(remaining / 60000));
        const days = Math.floor(totalMinutes / (24 * 60));
        const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
        const minutes = totalMinutes % 60;
        let label: string;
        if (days > 0) label = `Resets in ${days}d ${hours}h`;
        else if (hours > 0) label = `Resets in ${hours}h ${minutes}m`;
        else label = `Resets in ${minutes}m`;
        return { resetAt: resetAt.toISOString(), resetText: label };
    } catch {
        return null;
    }
}

function _previousMonthlyBoundary(resetAt: Date): Date {
    const year = resetAt.getUTCFullYear();
    const month = resetAt.getUTCMonth();
    const prevYear = month === 0 ? year - 1 : year;
    const prevMonth = month === 0 ? 11 : month - 1;
    const lastDayOfPrevMonth = new Date(Date.UTC(prevYear, prevMonth + 1, 0)).getUTCDate();
    return new Date(
        Date.UTC(
            prevYear,
            prevMonth,
            Math.min(resetAt.getUTCDate(), lastDayOfPrevMonth),
            resetAt.getUTCHours(),
            resetAt.getUTCMinutes(),
            resetAt.getUTCSeconds(),
            resetAt.getUTCMilliseconds(),
        ),
    );
}

function _applyMonthlyQuotaWindow(quota: any, resetAtIso: string) {
    const end = new Date(resetAtIso);
    if (isNaN(end.getTime())) return;
    const start = _previousMonthlyBoundary(end);
    const periodSeconds = Math.max(1, Math.round((end.getTime() - start.getTime()) / 1000));
    quota.periodStartAt = start.toISOString();
    quota.periodEndAt = end.toISOString();
    quota.periodSeconds = periodSeconds;
}

function fetch(metadata: any): any {
    const token = _getToken();
    if (!token) {
        return Utils.statusSnapshot(
            metadata,
            "auth_required",
            "No GitHub token available for Copilot",
            "Log in with `gh auth login` or add a GitHub token before enabling Copilot usage.",
        );
    }

    let response: any;
    try {
        response = Http.httpGet("https://api.github.com/copilot_internal/user", {
            Authorization: `token ${token}`,
            Accept: "application/json",
            "Editor-Version": "vscode/1.96.2",
            "Editor-Plugin-Version": "copilot-chat/0.26.7",
            "User-Agent": "GitHubCopilotChat/0.26.7",
            "X-Github-Api-Version": "2025-04-01",
        });
    } catch (error: any) {
        return Utils.statusSnapshot(
            metadata,
            "error",
            `Copilot request failed: ${error.message || error}`,
            "Check network access or retry later.",
        );
    }

    if (response.status < 200 || response.status >= 300) {
        return Utils.statusSnapshot(
            metadata,
            Utils.providerStatusFromHttpStatus(response.status),
            Utils.errorFromStatus(response.status, "Copilot usage endpoint returned an unexpected status"),
            "Refresh your GitHub login or use a token with access to Copilot usage.",
        );
    }

    let payload: any;
    try {
        payload = JSON.parse(response.body);
    } catch (error: any) {
        return Utils.statusSnapshot(
            metadata,
            "error",
            `Copilot payload parse failed: ${error.message || error}`,
            "The provider response format may have changed.",
        );
    }

    const snapshot = Utils.baseSnapshot(metadata);
    snapshot.status = "ok";
    snapshot.sourceLabel = "GitHub token + Copilot usage API";
    snapshot.accountLabel = payload.userLogin || payload.login || null;
    snapshot.planLabel = payload.copilotPlan || payload.copilot_plan || null;

    const quotaSnapshots = payload.quotaSnapshots || payload.quota_snapshots;
    if (quotaSnapshots) {
        const premium = quotaSnapshots.premiumInteractions || (payload.quota_snapshots || {}).premium_interactions;
        if (premium) {
            snapshot.primaryQuota = _quotaFromRemaining("Premium interactions", premium);
        }
        if (quotaSnapshots.chat) {
            snapshot.secondaryQuota = _quotaFromRemaining("Chat", quotaSnapshots.chat);
        }
    }

    if (snapshot.primaryQuota) snapshot.primaryQuota.periodSeconds = 30 * 86400;
    if (snapshot.secondaryQuota) snapshot.secondaryQuota.periodSeconds = 30 * 86400;

    const resetDateStr = payload.quotaResetDateUtc || payload.quota_reset_date_utc;
    if (resetDateStr) {
        const parsed = _parseResetDate(resetDateStr);
        if (parsed) {
            if (snapshot.primaryQuota) {
                snapshot.primaryQuota.resetAt = parsed.resetAt;
                snapshot.primaryQuota.resetText = parsed.resetText;
                _applyMonthlyQuotaWindow(snapshot.primaryQuota, parsed.resetAt);
            }
            if (snapshot.secondaryQuota) {
                snapshot.secondaryQuota.resetAt = parsed.resetAt;
                snapshot.secondaryQuota.resetText = parsed.resetText;
                _applyMonthlyQuotaWindow(snapshot.secondaryQuota, parsed.resetAt);
            }
        }
    }

    snapshot.refreshedAt = new Date().toISOString();

    if (!snapshot.primaryQuota && !snapshot.secondaryQuota) {
        snapshot.status = "error";
        snapshot.errorMessage = "Copilot response did not include recognizable quota windows";
        snapshot.remediation = "Inspect the helper output to update the parser.";
    }

    return snapshot;
}

export const CopilotProvider = { fetch };
