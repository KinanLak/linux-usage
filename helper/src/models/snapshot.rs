use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::ProviderMetadata;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderStatus {
    Ok,
    Refreshing,
    Stale,
    Unconfigured,
    AuthRequired,
    Unavailable,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    pub label: String,
    pub used_percent: Option<f64>,
    pub remaining_percent: Option<f64>,
    pub value_label: Option<String>,
    pub used_display: Option<String>,
    pub remaining_display: Option<String>,
    pub reset_at: Option<DateTime<Utc>>,
    pub reset_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSnapshot {
    pub provider_id: String,
    pub title: String,
    pub icon_name: String,
    pub status: ProviderStatus,
    pub source_label: Option<String>,
    pub account_label: Option<String>,
    pub plan_label: Option<String>,
    pub primary_quota: Option<QuotaWindow>,
    pub secondary_quota: Option<QuotaWindow>,
    pub detail_lines: Vec<String>,
    pub error_message: Option<String>,
    pub remediation: Option<String>,
    pub refreshed_at: Option<DateTime<Utc>>,
    pub stale: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSnapshot {
    pub generated_at: DateTime<Utc>,
    pub overall_status: String,
    pub providers: Vec<ProviderSnapshot>,
}

impl ProviderSnapshot {
    pub fn base(metadata: &ProviderMetadata) -> Self {
        Self {
            provider_id: metadata.id.clone(),
            title: metadata.title.clone(),
            icon_name: metadata.icon_name.clone(),
            status: ProviderStatus::Refreshing,
            source_label: None,
            account_label: None,
            plan_label: None,
            primary_quota: None,
            secondary_quota: None,
            detail_lines: Vec::new(),
            error_message: None,
            remediation: None,
            refreshed_at: None,
            stale: false,
        }
    }
}
