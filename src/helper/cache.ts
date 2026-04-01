import GLib from "gi://GLib";

import { Utils } from "./utils.js";

const BACKOFF_BASE_SECONDS = 300;
const BACKOFF_MAX_SECONDS = 21600;

function _snapshotPath(): string {
    return GLib.build_filenamev([Utils.cacheDir(), "linux-usage", "snapshot.json"]);
}

function _backoffPath(): string {
    return GLib.build_filenamev([Utils.cacheDir(), "linux-usage", "provider-backoff.json"]);
}

function loadSnapshot(): any {
    const path = _snapshotPath();
    if (!Utils.fileExists(path)) return null;
    try {
        return Utils.readJsonFile(path);
    } catch {
        return null;
    }
}

function storeSnapshot(snapshot: any): void {
    try {
        Utils.writeJsonFile(_snapshotPath(), snapshot);
    } catch {
        /* ignore write errors */
    }
}

function _loadBackoffState(): any {
    const path = _backoffPath();
    if (!Utils.fileExists(path)) return { providers: {} };
    try {
        return Utils.readJsonFile(path);
    } catch {
        return { providers: {} };
    }
}

function _storeBackoffState(state: any): void {
    try {
        Utils.writeJsonFile(_backoffPath(), state);
    } catch {
        /* ignore */
    }
}

function _pruneExpired(state: any): boolean {
    const now = Date.now();
    let changed = false;
    for (const key of Object.keys(state.providers)) {
        if (new Date(state.providers[key].blockedUntil).getTime() <= now) {
            delete state.providers[key];
            changed = true;
        }
    }
    return changed;
}

function activeBackoff(providerId: string): any | null {
    const state = _loadBackoffState();
    const now = Date.now();
    let changed = _pruneExpired(state);

    const entry = state.providers[providerId];
    if (!entry || new Date(entry.blockedUntil).getTime() <= now) {
        if (entry) {
            delete state.providers[providerId];
            changed = true;
        }
        if (changed) _storeBackoffState(state);
        return null;
    }

    if (changed) _storeBackoffState(state);
    return entry;
}

function recordFailure(providerId: string, lastError: string | null): any {
    const state = _loadBackoffState();
    _pruneExpired(state);

    const existing = state.providers[providerId];
    const failureCount = existing ? existing.failureCount + 1 : 1;
    const exponent = Math.min(failureCount - 1, 10);
    const seconds = Math.min(BACKOFF_BASE_SECONDS * Math.pow(2, exponent), BACKOFF_MAX_SECONDS);
    const blockedUntil = new Date(Date.now() + seconds * 1000).toISOString();

    const entry = { blockedUntil, failureCount, lastError };
    state.providers[providerId] = entry;
    _storeBackoffState(state);
    return entry;
}

function clearBackoff(providerId: string): void {
    const state = _loadBackoffState();
    if (!state.providers[providerId]) return;
    delete state.providers[providerId];
    _storeBackoffState(state);
}

export const Cache = {
    loadSnapshot,
    storeSnapshot,
    activeBackoff,
    recordFailure,
    clearBackoff,
};
