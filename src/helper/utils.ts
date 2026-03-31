/* oxlint-disable no-unused-vars */

const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;

function homeDir(): string {
  return GLib.get_home_dir();
}

function cacheDir(): string {
  return GLib.get_user_cache_dir();
}

function configDir(): string {
  return GLib.getenv("XDG_CONFIG_HOME") || GLib.build_filenamev([homeDir(), ".config"]);
}

function readJsonFile(path: string): any {
  const file = Gio.File.new_for_path(path);
  const [, contents] = file.load_contents(null);
  return JSON.parse(new TextDecoder().decode(contents));
}

function writeJsonFile(path: string, data: any): void {
  const dir = GLib.path_get_dirname(path);
  GLib.mkdir_with_parents(dir, 0o755);
  const file = Gio.File.new_for_path(path);
  file.replace_contents(
    new TextEncoder().encode(JSON.stringify(data, null, 2)),
    null,
    false,
    Gio.FileCreateFlags.REPLACE_DESTINATION,
    null,
  );
}

function fileExists(path: string): boolean {
  return GLib.file_test(path, GLib.FileTest.EXISTS);
}

function firstExisting(paths: string[]): string | null {
  for (const path of paths) {
    if (fileExists(path)) return path;
  }
  return null;
}

function parseJwtClaims(token: string): any {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  while (payload.length % 4) payload += "=";
  try {
    const decoded = GLib.base64_decode(payload);
    return JSON.parse(new TextDecoder().decode(decoded));
  } catch {
    return null;
  }
}

function runCommand(args: string[]): { success: boolean; stdout: string; stderr: string } {
  try {
    const proc = Gio.Subprocess.new(
      args,
      Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    );
    const [, stdout, stderr] = proc.communicate_utf8(null, null);
    return { success: proc.get_successful(), stdout: stdout || "", stderr: stderr || "" };
  } catch (error: any) {
    return { success: false, stdout: "", stderr: error.message || String(error) };
  }
}

function runCommandWithInput(
  args: string[],
  input: string,
): { success: boolean; stdout: string; stderr: string } {
  try {
    const proc = Gio.Subprocess.new(
      args,
      Gio.SubprocessFlags.STDIN_PIPE |
        Gio.SubprocessFlags.STDOUT_PIPE |
        Gio.SubprocessFlags.STDERR_PIPE,
    );
    const [, stdout, stderr] = proc.communicate_utf8(input, null);
    return { success: proc.get_successful(), stdout: stdout || "", stderr: stderr || "" };
  } catch (error: any) {
    return { success: false, stdout: "", stderr: error.message || String(error) };
  }
}

function percentPairFromUsedLimit(
  used: number | null,
  limit: number | null,
): [number | null, number | null] {
  if (used !== null && limit !== null && limit > 0) {
    const usedPercent = Math.max(0, Math.min(100, (used / limit) * 100));
    return [usedPercent, 100 - usedPercent];
  }
  return [null, null];
}

function percentPairFromRemainingLimit(
  remaining: number | null,
  limit: number | null,
): [number | null, number | null] {
  if (remaining !== null && limit !== null && limit > 0) {
    const remainingPercent = Math.max(0, Math.min(100, (remaining / limit) * 100));
    return [100 - remainingPercent, remainingPercent];
  }
  return [null, null];
}

function valueAtPath(obj: any, path: string[]): any {
  let current = obj;
  for (const key of path) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}

function valueAsNumber(value: any): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = parseFloat(value);
    return isNaN(parsed) ? null : parsed;
  }
  return null;
}

function valueAsString(value: any): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function errorFromStatus(status: number, fallback: string): string {
  if (status === 401 || status === 403) return "Authentication expired or missing";
  if (status === 429) return "Provider rate-limited the usage request";
  return fallback;
}

function providerStatusFromHttpStatus(status: number): string {
  if (status === 401 || status === 403) return "auth_required";
  return "error";
}

function ghCliToken(): string | null {
  const result = runCommand(["gh", "auth", "token"]);
  if (!result.success) return null;
  const trimmed = result.stdout.trim();
  return trimmed || null;
}

function stripAnsi(input: string): string {
  // oxlint-disable-next-line no-control-regex -- intentional: strips ANSI escape sequences from CLI stderr
  return input.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "");
}

function baseSnapshot(metadata: any): any {
  return {
    providerId: metadata.id,
    title: metadata.title,
    iconName: metadata.iconName,
    status: "refreshing",
    sourceLabel: null,
    accountLabel: null,
    planLabel: null,
    primaryQuota: null,
    secondaryQuota: null,
    detailLines: [],
    errorMessage: null,
    remediation: null,
    refreshedAt: null,
    stale: false,
  };
}

function statusSnapshot(
  metadata: any,
  status: string,
  errorMessage?: string | null,
  remediation?: string | null,
): any {
  const snapshot = baseSnapshot(metadata);
  snapshot.status = status;
  snapshot.errorMessage = errorMessage || null;
  snapshot.remediation = remediation || null;
  return snapshot;
}

var Utils = {
  homeDir,
  cacheDir,
  configDir,
  readJsonFile,
  writeJsonFile,
  fileExists,
  firstExisting,
  parseJwtClaims,
  runCommand,
  runCommandWithInput,
  percentPairFromUsedLimit,
  percentPairFromRemainingLimit,
  valueAtPath,
  valueAsNumber,
  valueAsString,
  errorFromStatus,
  providerStatusFromHttpStatus,
  ghCliToken,
  stripAnsi,
  baseSnapshot,
  statusSnapshot,
};
