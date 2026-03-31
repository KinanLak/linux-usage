pub mod catalog;
pub mod claude;
pub mod codex;
pub mod copilot;

use crate::cache::SnapshotCache;
use crate::cache::backoff::{ProviderBackoffCache, ProviderBackoffEntry};
use crate::models::{AppSnapshot, ProviderMetadata, ProviderSnapshot, ProviderStatus};
use anyhow::{Context, Result, anyhow, ensure};
use chrono::{DateTime, Utc};
use futures::future::join_all;
use reqwest::{Client, StatusCode};
use serde_json::Value;
use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;
use tracing::warn;

pub use catalog::{provider_catalog, required_provider_metadata};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Clone)]
pub struct ProviderContext {
    pub client: Client,
}

pub trait Provider: Send + Sync {
    fn metadata(&self) -> &'static ProviderMetadata;
    fn fetch<'a>(&'a self, ctx: &'a ProviderContext) -> BoxFuture<'a, ProviderSnapshot>;
}

#[derive(Clone)]
pub struct ProviderRegistry {
    ctx: ProviderContext,
    backoff: Arc<ProviderBackoffCache>,
    cache: Arc<SnapshotCache>,
    providers: Vec<Arc<dyn Provider>>,
}

impl ProviderRegistry {
    pub fn new() -> Result<Self> {
        let client = Client::builder()
            .user_agent("linux-usage/1.0.0 (httops://github.com/KinanLak/linux-usage)")
            .timeout(Duration::from_secs(20))
            .build()
            .context("failed to build HTTP client")?;

        let providers = registered_providers();
        validate_provider_registry(&providers)?;

        Ok(Self {
            ctx: ProviderContext { client },
            backoff: Arc::new(ProviderBackoffCache::new()?),
            cache: Arc::new(SnapshotCache::new()?),
            providers,
        })
    }

    pub async fn fetch_all(&self) -> AppSnapshot {
        let cached = self.cache.load();
        let providers = join_all(
            self.providers
                .iter()
                .cloned()
                .map(|provider| self.fetch_provider_snapshot(provider, cached.as_ref())),
        )
        .await;

        let overall_status = if [ProviderStatus::Error, ProviderStatus::AuthRequired]
            .iter()
            .any(|status| {
                providers.iter().any(|snapshot| {
                    std::mem::discriminant(&snapshot.status) == std::mem::discriminant(status)
                })
            }) {
            "degraded"
        } else {
            "ok"
        }
        .to_string();

        let snapshot = AppSnapshot {
            generated_at: Utc::now(),
            overall_status,
            providers,
        };

        let _ = self.cache.store(&snapshot);
        snapshot
    }

    pub async fn fetch_cached_or_live(&self) -> AppSnapshot {
        if let Some(snapshot) = self.cache.load() {
            return snapshot;
        }
        self.fetch_all().await
    }

    pub async fn fetch_one(&self, provider: &str) -> Option<ProviderSnapshot> {
        let cached = self.cache.load();
        let candidate = self
            .providers
            .iter()
            .find(|entry| entry.metadata().id == provider)?
            .clone();
        Some(
            self.fetch_provider_snapshot(candidate, cached.as_ref())
                .await,
        )
    }

    pub fn known_provider_ids(&self) -> Vec<&str> {
        self.providers
            .iter()
            .map(|provider| provider.metadata().id.as_str())
            .collect()
    }

    async fn fetch_provider_snapshot(
        &self,
        provider: Arc<dyn Provider>,
        cached: Option<&AppSnapshot>,
    ) -> ProviderSnapshot {
        let provider_id = provider.metadata().id.clone();
        let cached_provider = cached_provider(cached, &provider_id);
        let now = Utc::now();

        if let Some(backoff) = self.backoff.active(&provider_id, now) {
            return snapshot_from_backoff(provider.metadata(), cached_provider.as_ref(), &backoff);
        }

        let snapshot = provider.fetch(&self.ctx).await;
        if matches!(snapshot.status, ProviderStatus::Error) {
            if let Err(error) = self.backoff.record_failure(
                &snapshot.provider_id,
                now,
                snapshot.error_message.as_deref(),
            ) {
                warn!(provider_id = snapshot.provider_id.as_str(), %error, "failed to persist provider backoff state");
            }
        } else if let Err(error) = self.backoff.clear(&snapshot.provider_id) {
            warn!(provider_id = snapshot.provider_id.as_str(), %error, "failed to clear provider backoff state");
        }

        merge_stale(snapshot, cached_provider.as_ref())
    }
}

fn registered_providers() -> Vec<Arc<dyn Provider>> {
    vec![
        Arc::new(codex::CodexProvider::default()),
        Arc::new(claude::ClaudeProvider::default()),
        Arc::new(copilot::CopilotProvider::default()),
    ]
}

fn validate_provider_registry(providers: &[Arc<dyn Provider>]) -> Result<()> {
    let catalog_ids = provider_catalog()
        .iter()
        .map(|metadata| metadata.id.as_str())
        .collect::<HashSet<_>>();
    let mut registered_ids = HashSet::new();

    for provider in providers {
        let metadata = provider.metadata();
        ensure!(
            catalog_ids.contains(metadata.id.as_str()),
            "registered provider `{}` is missing from extension/providers.json",
            metadata.id
        );
        ensure!(
            registered_ids.insert(metadata.id.as_str()),
            "provider `{}` is registered more than once",
            metadata.id
        );
    }

    for metadata in provider_catalog() {
        ensure!(
            registered_ids.contains(metadata.id.as_str()),
            "provider `{}` exists in extension/providers.json but has no helper implementation",
            metadata.id
        );
    }

    if providers.is_empty() {
        return Err(anyhow!("provider registry is empty"));
    }

    Ok(())
}

fn cached_provider(cached: Option<&AppSnapshot>, provider_id: &str) -> Option<ProviderSnapshot> {
    cached.and_then(|app| {
        app.providers
            .iter()
            .find(|candidate| candidate.provider_id == provider_id)
            .cloned()
    })
}

fn merge_stale(
    mut snapshot: ProviderSnapshot,
    cached_provider: Option<&ProviderSnapshot>,
) -> ProviderSnapshot {
    let should_use_stale = matches!(snapshot.status, ProviderStatus::Error)
        && snapshot.primary_quota.is_none()
        && cached_provider.is_some_and(|cached| {
            cached.primary_quota.is_some() || cached.secondary_quota.is_some()
        });

    if should_use_stale {
        if let Some(cached_provider) = cached_provider.cloned() {
            snapshot.primary_quota = cached_provider.primary_quota;
            snapshot.secondary_quota = cached_provider.secondary_quota;
            snapshot.account_label = snapshot.account_label.or(cached_provider.account_label);
            snapshot.plan_label = snapshot.plan_label.or(cached_provider.plan_label);
            snapshot.source_label = snapshot.source_label.or(cached_provider.source_label);
            if snapshot.detail_lines.is_empty() {
                snapshot.detail_lines = cached_provider.detail_lines;
            }
            snapshot.status = ProviderStatus::Stale;
            snapshot.stale = true;
        }
    }

    snapshot
}

fn snapshot_from_backoff(
    metadata: &ProviderMetadata,
    cached_provider: Option<&ProviderSnapshot>,
    backoff: &ProviderBackoffEntry,
) -> ProviderSnapshot {
    if let Some(cached) = cached_provider
        .filter(|cached| cached.primary_quota.is_some() || cached.secondary_quota.is_some())
        .cloned()
    {
        let mut snapshot = cached;
        snapshot.status = ProviderStatus::Stale;
        snapshot.stale = true;
        snapshot.error_message = Some(backoff_message(backoff));
        snapshot.remediation =
            Some("Using cached data until the provider cooldown expires.".to_string());
        return snapshot;
    }

    status_snapshot(
        metadata,
        ProviderStatus::Error,
        Some(backoff_message(backoff)),
        Some("Wait for the provider cooldown to expire before retrying.".to_string()),
    )
}

fn backoff_message(backoff: &ProviderBackoffEntry) -> String {
    let duration = format_backoff_duration(backoff.blocked_until);
    let reason = format_backoff_reason(backoff.last_error.as_deref());
    format!("Provider temporarily backed off for {duration} before retry after {reason}")
}

fn format_backoff_duration(value: DateTime<Utc>) -> String {
    let remaining = value.signed_duration_since(Utc::now());
    let total_seconds = remaining.num_seconds().max(60);
    let total_minutes = (total_seconds + 59) / 60;
    if total_minutes >= 60 && total_minutes % 60 == 0 {
        let hours = total_minutes / 60;
        if hours == 1 {
            "1 hour".to_string()
        } else {
            format!("{hours} hours")
        }
    } else if total_minutes == 1 {
        "1 minute".to_string()
    } else {
        format!("{total_minutes} minutes")
    }
}

fn format_backoff_reason(last_error: Option<&str>) -> String {
    match last_error.map(str::trim).filter(|value| !value.is_empty()) {
        Some(reason) => {
            let normalized = reason.to_ascii_lowercase();
            if normalized.contains("rate-limit") || normalized.contains("rate limit") {
                return "rate-limit".to_string();
            }

            reason
                .strip_prefix("Provider ")
                .unwrap_or(reason)
                .to_string()
        }
        None => "recent failures".to_string(),
    }
}

pub fn status_snapshot(
    metadata: &ProviderMetadata,
    status: ProviderStatus,
    error_message: impl Into<Option<String>>,
    remediation: impl Into<Option<String>>,
) -> ProviderSnapshot {
    let mut snapshot = ProviderSnapshot::base(metadata);
    snapshot.status = status;
    snapshot.error_message = error_message.into();
    snapshot.remediation = remediation.into();
    snapshot
}

pub fn parse_jwt_claims(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let decoded =
        base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, payload).ok()?;
    serde_json::from_slice(&decoded).ok()
}

pub fn percent_pair_from_used_limit(
    used: Option<f64>,
    limit: Option<f64>,
) -> (Option<f64>, Option<f64>) {
    match (used, limit) {
        (Some(used), Some(limit)) if limit > 0.0 => {
            let used_percent = (used / limit * 100.0).clamp(0.0, 100.0);
            (Some(used_percent), Some(100.0 - used_percent))
        }
        _ => (None, None),
    }
}

pub fn percent_pair_from_remaining_limit(
    remaining: Option<f64>,
    limit: Option<f64>,
) -> (Option<f64>, Option<f64>) {
    match (remaining, limit) {
        (Some(remaining), Some(limit)) if limit > 0.0 => {
            let remaining_percent = (remaining / limit * 100.0).clamp(0.0, 100.0);
            (Some(100.0 - remaining_percent), Some(remaining_percent))
        }
        _ => (None, None),
    }
}

pub fn value_at_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for segment in path {
        current = current.get(*segment)?;
    }
    Some(current)
}

pub fn value_as_f64(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.parse().ok(),
        _ => None,
    }
}

pub fn value_as_string(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

pub fn error_from_status(status: StatusCode, fallback: &str) -> String {
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            "Authentication expired or missing".to_string()
        }
        StatusCode::TOO_MANY_REQUESTS => "Provider rate-limited the usage request".to_string(),
        _ => fallback.to_string(),
    }
}

pub fn provider_status_from_http_status(status: StatusCode) -> ProviderStatus {
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => ProviderStatus::AuthRequired,
        _ => ProviderStatus::Error,
    }
}

pub fn gh_cli_token() -> Option<String> {
    let output = Command::new("gh").args(["auth", "token"]).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let token = String::from_utf8(output.stdout).ok()?;
    let trimmed = token.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ProviderBackoffEntry, backoff_message, provider_status_from_http_status,
        snapshot_from_backoff,
    };
    use crate::models::ProviderStatus;
    use crate::models::{ProviderMetadata, ProviderSnapshot};
    use chrono::{Duration, Utc};
    use reqwest::StatusCode;

    #[test]
    fn maps_rate_limit_to_error_instead_of_auth() {
        assert!(matches!(
            provider_status_from_http_status(StatusCode::TOO_MANY_REQUESTS),
            ProviderStatus::Error
        ));
    }

    #[test]
    fn keeps_auth_status_for_auth_failures() {
        assert!(matches!(
            provider_status_from_http_status(StatusCode::UNAUTHORIZED),
            ProviderStatus::AuthRequired
        ));
        assert!(matches!(
            provider_status_from_http_status(StatusCode::FORBIDDEN),
            ProviderStatus::AuthRequired
        ));
    }

    #[test]
    fn uses_cached_snapshot_while_provider_is_in_backoff() {
        let metadata = ProviderMetadata {
            id: "claude".to_string(),
            title: "Claude".to_string(),
            description: "test".to_string(),
            icon_name: "test-symbolic".to_string(),
            default_enabled: true,
        };
        let mut cached = ProviderSnapshot::base(&metadata);
        cached.status = ProviderStatus::Ok;
        cached.stale = false;
        cached.error_message = None;
        cached.remediation = None;
        cached.primary_quota = Some(crate::models::QuotaWindow {
            label: "Session".to_string(),
            used_percent: Some(10.0),
            remaining_percent: Some(90.0),
            value_label: None,
            used_display: None,
            remaining_display: None,
            reset_at: None,
            reset_text: None,
        });

        let backoff = ProviderBackoffEntry {
            blocked_until: Utc::now() + Duration::minutes(5),
            failure_count: 2,
            last_error: Some("Provider rate-limited the usage request".to_string()),
        };

        let snapshot = snapshot_from_backoff(&metadata, Some(&cached), &backoff);
        assert!(matches!(snapshot.status, ProviderStatus::Stale));
        assert!(snapshot.stale);
        assert!(snapshot.primary_quota.is_some());
        assert!(snapshot.error_message.as_deref().is_some_and(|message| {
            message.contains("for 5 minutes before retry") && message.contains("after rate-limit")
        }));
    }

    #[test]
    fn backoff_message_mentions_retry_time() {
        let backoff = ProviderBackoffEntry {
            blocked_until: Utc::now() + Duration::minutes(5),
            failure_count: 1,
            last_error: None,
        };
        assert!(
            backoff_message(&backoff).contains("temporarily backed off for 5 minutes before retry")
        );
    }

    #[test]
    fn backoff_message_uses_rate_limit_reason() {
        let backoff = ProviderBackoffEntry {
            blocked_until: Utc::now() + Duration::minutes(5),
            failure_count: 1,
            last_error: Some("Provider rate-limited the usage request".to_string()),
        };
        assert!(backoff_message(&backoff).contains("after rate-limit"));
    }
}
