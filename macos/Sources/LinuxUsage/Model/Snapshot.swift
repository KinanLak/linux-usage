import Foundation

/// Mirrors `contracts/snapshot.schema.json` so the cache file stays readable by both ports.
struct Quota: Codable, Sendable, Equatable {
    var label: String
    var usedPercent: Double?
    var remainingPercent: Double?
    var valueLabel: String?
    var usedDisplay: String?
    var remainingDisplay: String?
    var resetAt: String?
    var resetText: String?
    var periodSeconds: Double?
    var periodStartAt: String?
    var periodEndAt: String?

    init(label: String, usedPercent: Double? = nil, remainingPercent: Double? = nil) {
        self.label = label
        self.usedPercent = usedPercent
        self.remainingPercent = remainingPercent
    }
}

enum ProviderStatus: String, Codable, Sendable {
    case ok, refreshing, stale, unconfigured
    case authRequired = "auth_required"
    case unavailable, error

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ProviderStatus(rawValue: raw) ?? .error
    }
}

struct ProviderSnapshot: Codable, Sendable, Equatable, Identifiable {
    var providerId: String
    var title: String
    var iconName: String
    var status: ProviderStatus
    var sourceLabel: String?
    var accountLabel: String?
    var planLabel: String?
    var primaryQuota: Quota?
    var secondaryQuota: Quota?
    var detailLines: [String]
    var errorMessage: String?
    var remediation: String?
    var refreshedAt: String?
    var stale: Bool

    var id: String { providerId }

    init(metadata: ProviderMetadata, status: ProviderStatus = .refreshing) {
        providerId = metadata.id
        title = metadata.title
        iconName = metadata.iconName
        self.status = status
        detailLines = []
        stale = false
    }

    static func status(
        _ metadata: ProviderMetadata,
        _ status: ProviderStatus,
        _ errorMessage: String? = nil,
        _ remediation: String? = nil
    ) -> ProviderSnapshot {
        var snapshot = ProviderSnapshot(metadata: metadata, status: status)
        snapshot.errorMessage = errorMessage
        snapshot.remediation = remediation
        return snapshot
    }
}

struct Snapshot: Codable, Sendable, Equatable {
    var generatedAt: String
    var overallStatus: String
    var providers: [ProviderSnapshot]
}
