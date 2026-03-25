use crate::models::{ProviderMetadata, ProviderSnapshot, ProviderStatus, QuotaWindow};
use crate::providers::{
    BoxFuture, Provider, ProviderContext, parse_jwt_claims, percent_pair_from_used_limit,
    required_provider_metadata, status_snapshot, value_as_f64, value_as_string,
};
use crate::sessions::{config_dir, first_existing, home_dir, read_json_file};
use chrono::Utc;
use serde::Deserialize;
use serde_json::Value;
use std::path::PathBuf;

#[derive(Debug, Default)]
pub struct ClaudeProvider;

const PROVIDER_ID: &str = "claude";

#[derive(Debug, Deserialize)]
struct ClaudeCredentials {
    access_token: Option<String>,
    rate_limit_tier: Option<String>,
    email: Option<String>,
}

impl Provider for ClaudeProvider {
    fn metadata(&self) -> &'static ProviderMetadata {
        required_provider_metadata(PROVIDER_ID)
    }

    fn fetch<'a>(&'a self, ctx: &'a ProviderContext) -> BoxFuture<'a, ProviderSnapshot> {
        Box::pin(async move {
            let metadata = self.metadata();

            let Some(path) = discover_credentials_path() else {
                return status_snapshot(
                    metadata,
                    ProviderStatus::Unconfigured,
                    Some("No local Claude credentials found".to_string()),
                    Some("Sign in with Claude Code to enable quota monitoring.".to_string()),
                );
            };

            let creds: ClaudeCredentials = match read_json_file(&path) {
                Ok(value) => value,
                Err(error) => {
                    return status_snapshot(
                        metadata,
                        ProviderStatus::Error,
                        Some(error.to_string()),
                        Some("Inspect the Claude credentials file on disk.".to_string()),
                    );
                }
            };

            let Some(token) = creds.access_token.clone() else {
                return status_snapshot(
                    metadata,
                    ProviderStatus::AuthRequired,
                    Some("Claude credentials exist but no access token is present".to_string()),
                    Some("Run `claude login` again to refresh the token.".to_string()),
                );
            };

            let response = match ctx
                .client
                .get("https://api.anthropic.com/api/oauth/usage")
                .header("Authorization", format!("Bearer {token}"))
                .header("anthropic-beta", "oauth-2025-04-20")
                .send()
                .await
            {
                Ok(value) => value,
                Err(error) => {
                    return status_snapshot(
                        metadata,
                        ProviderStatus::Error,
                        Some(format!("Claude request failed: {error}")),
                        Some("Check network access or retry later.".to_string()),
                    );
                }
            };

            if !response.status().is_success() {
                let message = crate::providers::error_from_status(
                    response.status(),
                    "Claude usage endpoint returned an unexpected status",
                );
                return status_snapshot(
                    metadata,
                    if response.status().is_client_error() {
                        ProviderStatus::AuthRequired
                    } else {
                        ProviderStatus::Error
                    },
                    Some(message),
                    Some("Refresh your Claude Code login or update the scope.".to_string()),
                );
            }

            let payload: Value = match response.json().await {
                Ok(value) => value,
                Err(error) => {
                    return status_snapshot(
                        metadata,
                        ProviderStatus::Error,
                        Some(format!("Claude payload parse failed: {error}")),
                        Some("The provider response format may have changed.".to_string()),
                    );
                }
            };

            let claims = parse_jwt_claims(&token);
            let mut snapshot = ProviderSnapshot::base(metadata);
            snapshot.status = ProviderStatus::Ok;
            snapshot.source_label = Some("Local session + Claude OAuth API".to_string());
            snapshot.account_label = creds.email.or_else(|| {
                claims
                    .as_ref()
                    .and_then(|value| value.get("email"))
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            });
            snapshot.plan_label = creds
                .rate_limit_tier
                .map(|value| value.to_ascii_uppercase());
            snapshot.primary_quota = payload
                .get("five_hour")
                .and_then(|value| quota_from_usage("Session", value));
            snapshot.secondary_quota = payload
                .get("seven_day")
                .and_then(|value| quota_from_usage("Weekly", value));

            if let Some(value) = payload.get("extra_usage") {
                if let (Some(spend), Some(limit)) = (
                    value_as_f64(value.get("spend")),
                    value_as_f64(value.get("limit")),
                ) {
                    snapshot
                        .detail_lines
                        .push(format!("Extra usage: ${spend:.2} / ${limit:.2}"));
                }
            }

            snapshot.refreshed_at = Some(Utc::now());

            if snapshot.primary_quota.is_none() && snapshot.secondary_quota.is_none() {
                snapshot.status = ProviderStatus::Error;
                snapshot.error_message =
                    Some("Claude response did not include recognizable quota windows".to_string());
                snapshot.remediation =
                    Some("Inspect the helper output to update the parser.".to_string());
            }

            snapshot
        })
    }
}

fn discover_credentials_path() -> Option<PathBuf> {
    let home = home_dir().ok()?;
    let config = config_dir().ok()?;
    first_existing(&[
        home.join(".claude/.credentials.json"),
        config.join("claude/.credentials.json"),
    ])
}

fn quota_from_usage(label: &str, value: &Value) -> Option<QuotaWindow> {
    let used = value_as_f64(value.get("used"))
        .or_else(|| value_as_f64(value.get("percent_used")))
        .or_else(|| value_as_f64(value.get("usage")));
    let limit = value_as_f64(value.get("limit")).or_else(|| {
        value_as_f64(value.get("max")).or_else(|| {
            if value.get("percent_used").is_some() {
                Some(100.0)
            } else {
                None
            }
        })
    });
    let (used_percent, remaining_percent) = if value.get("percent_used").is_some() {
        let used_percent = value_as_f64(value.get("percent_used"));
        (used_percent, used_percent.map(|percent| 100.0 - percent))
    } else {
        percent_pair_from_used_limit(used, limit)
    };

    Some(QuotaWindow {
        label: label.to_string(),
        used_percent,
        remaining_percent,
        value_label: None,
        used_display: value_as_string(value.get("used_display"))
            .or_else(|| used.map(|v| format!("{v:.0}"))),
        remaining_display: value_as_string(value.get("remaining_display"))
            .or_else(|| value_as_string(value.get("reset_text"))),
        reset_at: value
            .get("resets_at")
            .or_else(|| value.get("reset_at"))
            .and_then(Value::as_str)
            .and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok())
            .map(|value| value.with_timezone(&Utc)),
        reset_text: value_as_string(value.get("resets_in"))
            .or_else(|| value_as_string(value.get("reset_text"))),
    })
}
