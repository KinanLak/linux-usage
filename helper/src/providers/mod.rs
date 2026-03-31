pub mod catalog;
pub mod claude;
pub mod codex;
pub mod copilot;

use crate::cache::SnapshotCache;
use crate::models::{AppSnapshot, ProviderMetadata, ProviderSnapshot, ProviderStatus};
use anyhow::{Context, Result, anyhow, ensure};
use chrono::Utc;
use futures::future::join_all;
use reqwest::{Client, StatusCode};
use serde_json::Value;
use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::process::Command;
use std::sync::Arc;

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
    cache: Arc<SnapshotCache>,
    providers: Vec<Arc<dyn Provider>>,
}

impl ProviderRegistry {
    pub fn new() -> Result<Self> {
        let client = Client::builder()
            .user_agent("linux-usage/1.0.0 (httops://github.com/KinanLak/linux-usage)")
            .build()
            .context("failed to build HTTP client")?;

        let providers = registered_providers();
        validate_provider_registry(&providers)?;

        Ok(Self {
            ctx: ProviderContext { client },
            cache: Arc::new(SnapshotCache::new()?),
            providers,
        })
    }

    pub async fn fetch_all(&self) -> AppSnapshot {
        let cached = self.cache.load();
        let providers = join_all(self.providers.iter().map(|provider| provider.fetch(&self.ctx)))
            .await
            .into_iter()
            .map(|snapshot| merge_stale(snapshot, cached.as_ref()))
            .collect::<Vec<_>>();

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
        let candidate = self
            .providers
            .iter()
            .find(|entry| entry.metadata().id == provider)?;
        Some(candidate.fetch(&self.ctx).await)
    }

    pub fn known_provider_ids(&self) -> Vec<&str> {
        self.providers
            .iter()
            .map(|provider| provider.metadata().id.as_str())
            .collect()
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

fn merge_stale(mut snapshot: ProviderSnapshot, cached: Option<&AppSnapshot>) -> ProviderSnapshot {
    let cached_provider = cached.and_then(|app| {
        app.providers
            .iter()
            .find(|candidate| candidate.provider_id == snapshot.provider_id)
    });

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
