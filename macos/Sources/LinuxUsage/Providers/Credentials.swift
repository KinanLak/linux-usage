import Foundation

struct ProviderOptions: Sendable {
    let credentialSource: CredentialSource
    /// Remote CLIProxyAPI server, resolved once per refresh (the key is read from the Keychain).
    let server: CliProxyServer?

    static func current(_ source: CredentialSource) async -> ProviderOptions {
        let server = source.usesServer ? await CliProxyServer.configured() : nil
        return ProviderOptions(credentialSource: source, server: server)
    }
}

struct CliProxyAccount {
    let path: String
    let data: JSONObject
}

enum Credentials {
    static var cliProxyAuthDir: String { Paths.join(Paths.home, ".cli-proxy-api") }

    /// CLIProxyAPI stores one JSON file per account (`claude-<email>.json`, `codex-<email>-<plan>.json`)
    /// with a `type` field. When several accounts match, the most recently written one wins: the proxy
    /// rewrites a file each time it refreshes that account's token.
    static func findCliProxyAccount(type: String) -> CliProxyAccount? {
        let dir = URL(fileURLWithPath: cliProxyAuthDir)
        let keys: [URLResourceKey] = [.isRegularFileKey, .contentModificationDateKey]
        guard
            let entries = try? FileManager.default.contentsOfDirectory(
                at: dir, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles]
            )
        else { return nil }

        var best: (account: CliProxyAccount, mtime: Date)?
        for url in entries where url.pathExtension == "json" {
            guard let values = try? url.resourceValues(forKeys: Set(keys)), values.isRegularFile == true,
                let data = try? JSONValue.readObject(atPath: url.path)
            else { continue }
            if data["disabled"] as? Bool == true { continue }

            let name = url.lastPathComponent
            let fileType = (data["type"] as? String) ?? String(name.split(separator: "-").first ?? "")
            guard fileType == type else { continue }

            let mtime = values.contentModificationDate ?? .distantPast
            if best == nil || mtime > best!.mtime {
                best = (CliProxyAccount(path: url.path, data: data), mtime)
            }
        }
        return best?.account
    }
}

/// Claude Code on macOS keeps its OAuth credentials in the login Keychain instead of
/// `~/.claude/.credentials.json`. The item is written by `/usr/bin/security`, so reading it through
/// the same tool doesn't trigger a Keychain access prompt.
enum ClaudeKeychain {
    static let service = "Claude Code-credentials"
    static let label = "macOS Keychain (\(service))"

    static func read() async -> JSONObject? {
        let result = await Shell.run(
            ["/usr/bin/security", "find-generic-password", "-s", service, "-w"], timeout: 10
        )
        guard result.success else { return nil }
        let raw = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        if let object = try? JSONValue.parseObject(Data(raw.utf8)) { return object }
        // `security -w` prints non-ASCII secrets as hex.
        guard let decoded = Data(hex: raw) else { return nil }
        return try? JSONValue.parseObject(decoded)
    }
}

extension Data {
    init?(hex: String) {
        guard hex.count.isMultiple(of: 2), !hex.isEmpty else { return nil }
        var bytes = [UInt8]()
        bytes.reserveCapacity(hex.count / 2)
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
            bytes.append(byte)
            index = next
        }
        self.init(bytes)
    }
}
