import GLib from "gi://GLib";

import { Cache } from "./cache.js";
import { ClaudeProvider } from "./providers/claude.js";
import { CodexProvider } from "./providers/codex.js";
import { CopilotProvider } from "./providers/copilot.js";
import { Utils } from "./utils.js";

function _loadCatalog(extensionDir: string): any[] {
    const path = GLib.build_filenamev([extensionDir, "providers.json"]);
    return Utils.readJsonFile(path);
}

function _providerFetchers(): Record<string, (metadata: any) => any> {
    return {
        claude: ClaudeProvider.fetch,
        copilot: CopilotProvider.fetch,
        codex: CodexProvider.fetch,
    };
}

function _cachedProvider(cached: any, providerId: string): any | null {
    if (!cached || !cached.providers) return null;
    return cached.providers.find((p: any) => p.providerId === providerId) || null;
}

function _mergeStale(snapshot: any, cached: any | null): any {
    if (
        snapshot.status === "error" &&
        !snapshot.primaryQuota &&
        cached &&
        (cached.primaryQuota || cached.secondaryQuota)
    ) {
        snapshot.primaryQuota = cached.primaryQuota;
        snapshot.secondaryQuota = cached.secondaryQuota;
        snapshot.accountLabel = snapshot.accountLabel || cached.accountLabel;
        snapshot.planLabel = snapshot.planLabel || cached.planLabel;
        snapshot.sourceLabel = snapshot.sourceLabel || cached.sourceLabel;
        if (!snapshot.detailLines || !snapshot.detailLines.length) {
            snapshot.detailLines = cached.detailLines || [];
        }
        snapshot.status = "stale";
        snapshot.stale = true;
    }
    return snapshot;
}

function _formatBackoffDuration(blockedUntil: string, short: boolean = false): string {
    const remaining = new Date(blockedUntil).getTime() - Date.now();
    const totalSeconds = Math.max(60, Math.round(remaining / 1000));
    const totalMinutes = Math.ceil(totalSeconds / 60);
    if (totalMinutes >= 60 && totalMinutes % 60 === 0) {
        const hours = totalMinutes / 60;
        if (short) {
            return hours === 1 ? "1h" : `${hours}h`;
        } else {
            return hours === 1 ? "1 hour" : `${hours} hours`;
        }
    }
    if (short) {
        return totalMinutes === 1 ? "1min" : `${totalMinutes}min`;
    } else {
        return totalMinutes === 1 ? "1 minute" : `${totalMinutes} minutes`;
    }
}

function _formatBackoffReason(lastError: string | null): string {
    if (!lastError || !lastError.trim()) return "recent failures";
    const normalized = lastError.toLowerCase();
    if (normalized.includes("rate-limit") || normalized.includes("rate limit")) {
        return "rate-limit";
    }
    return lastError.replace(/^Provider /, "");
}

function _snapshotFromBackoff(metadata: any, cached: any | null, backoff: any): any {
    const duration = _formatBackoffDuration(backoff.blockedUntil);
    const reason = _formatBackoffReason(backoff.lastError);
    const message = `Refresh paused for ${duration} because of ${reason}`;

    if (cached && (cached.primaryQuota || cached.secondaryQuota)) {
        const snapshot = Object.assign({}, cached);
        snapshot.status = "stale";
        snapshot.stale = true;
        snapshot.errorMessage = message;
        snapshot.remediation = "Using cached data until the provider cooldown expires.";
        return snapshot;
    }

    return Utils.statusSnapshot(
        metadata,
        "error",
        message,
        "Wait for the provider cooldown to expire before retrying.",
    );
}

function _fetchProviderSnapshot(metadata: any, fetcher: (meta: any) => any, cached: any | null): any {
    const backoff = Cache.activeBackoff(metadata.id);
    if (backoff) {
        const cachedProv = _cachedProvider(cached, metadata.id);
        return _snapshotFromBackoff(metadata, cachedProv, backoff);
    }

    let snapshot: any;
    try {
        snapshot = fetcher(metadata);
    } catch (error: any) {
        snapshot = Utils.statusSnapshot(
            metadata,
            "error",
            error.message || String(error),
            "An unexpected error occurred. Try again later.",
        );
    }

    if (snapshot.status === "error") {
        Cache.recordFailure(metadata.id, snapshot.errorMessage);
    } else {
        Cache.clearBackoff(metadata.id);
    }

    return _mergeStale(snapshot, _cachedProvider(cached, metadata.id));
}

function fetchAll(extensionDir: string): any {
    const catalog = _loadCatalog(extensionDir);
    const fetchers = _providerFetchers();
    const cached = Cache.loadSnapshot();

    const providers = catalog.map((metadata: any) => {
        const fetcher = fetchers[metadata.id];
        if (!fetcher) {
            return Utils.statusSnapshot(metadata, "error", `No implementation for provider '${metadata.id}'`);
        }
        return _fetchProviderSnapshot(metadata, fetcher, cached);
    });

    const hasError = providers.some((p: any) => p.status === "error" || p.status === "auth_required");
    const snapshot = {
        generatedAt: new Date().toISOString(),
        overallStatus: hasError ? "degraded" : "ok",
        providers,
    };

    Cache.storeSnapshot(snapshot);
    return snapshot;
}

function fetchCachedOrLive(extensionDir: string): any {
    const cached = Cache.loadSnapshot();
    if (cached) return cached;
    return fetchAll(extensionDir);
}

function fetchOne(extensionDir: string, providerId: string): any | null {
    const catalog = _loadCatalog(extensionDir);
    const metadata = catalog.find((m: any) => m.id === providerId);
    if (!metadata) return null;

    const fetchers = _providerFetchers();
    const fetcher = fetchers[providerId];
    if (!fetcher) {
        return Utils.statusSnapshot(metadata, "error", `No implementation for provider '${providerId}'`);
    }

    const cached = Cache.loadSnapshot();
    return _fetchProviderSnapshot(metadata, fetcher, cached);
}

export const Registry = { fetchAll, fetchCachedOrLive, fetchOne };
