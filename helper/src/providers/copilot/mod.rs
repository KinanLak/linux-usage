use crate::models::{ProviderId, ProviderSnapshot, ProviderStatus, QuotaWindow};
use crate::providers::{
    BoxFuture, Provider, ProviderContext, gh_cli_token, status_snapshot, value_as_f64,
};
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::env;

#[derive(Debug, Default)]
pub struct CopilotProvider;

impl Provider for CopilotProvider {
    fn fetch<'a>(&'a self, ctx: &'a ProviderContext) -> BoxFuture<'a, ProviderSnapshot> {
        Box::pin(async move {
            let token = env::var("GITHUB_TOKEN")
                .ok()
                .or_else(|| env::var("GH_TOKEN").ok())
                .or_else(gh_cli_token);

            let Some(token) = token else {
                return status_snapshot(
                    ProviderId::Copilot,
                    ProviderStatus::AuthRequired,
                    Some("No GitHub token available for Copilot".to_string()),
                    Some(
                        "Log in with `gh auth login` or add a GitHub token before enabling Copilot usage."
                            .to_string(),
                    ),
                );
            };

            let response = match ctx
                .client
                .get("https://api.github.com/copilot_internal/user")
                .header("Authorization", format!("token {token}"))
                .header("Accept", "application/json")
                .header("Editor-Version", "vscode/1.96.2")
                .header("Editor-Plugin-Version", "copilot-chat/0.26.7")
                .header("User-Agent", "GitHubCopilotChat/0.26.7")
                .header("X-Github-Api-Version", "2025-04-01")
                .send()
                .await
            {
                Ok(value) => value,
                Err(error) => {
                    return status_snapshot(
                        ProviderId::Copilot,
                        ProviderStatus::Error,
                        Some(format!("Copilot request failed: {error}")),
                        Some("Check network access or retry later.".to_string()),
                    );
                }
            };

            if !response.status().is_success() {
                let message = crate::providers::error_from_status(
                    response.status(),
                    "Copilot usage endpoint returned an unexpected status",
                );
                return status_snapshot(
                    ProviderId::Copilot,
                    if response.status().is_client_error() {
                        ProviderStatus::AuthRequired
                    } else {
                        ProviderStatus::Error
                    },
                    Some(message),
                    Some(
                        "Refresh your GitHub login or use a token with access to Copilot usage."
                            .to_string(),
                    ),
                );
            }

            let payload: Value = match response.json().await {
                Ok(value) => value,
                Err(error) => {
                    return status_snapshot(
                        ProviderId::Copilot,
                        ProviderStatus::Error,
                        Some(format!("Copilot payload parse failed: {error}")),
                        Some("The provider response format may have changed.".to_string()),
                    );
                }
            };

            let mut snapshot = ProviderSnapshot::base(ProviderId::Copilot);
            snapshot.status = ProviderStatus::Ok;
            snapshot.source_label = Some("GitHub token + Copilot usage API".to_string());
            snapshot.account_label = payload
                .get("userLogin")
                .or_else(|| payload.get("login"))
                .and_then(Value::as_str)
                .map(ToString::to_string);
            snapshot.plan_label = payload
                .get("copilotPlan")
                .or_else(|| payload.get("copilot_plan"))
                .and_then(Value::as_str)
                .map(ToString::to_string);
            snapshot.primary_quota = payload
                .get("quotaSnapshots")
                .or_else(|| payload.get("quota_snapshots"))
                .and_then(|value| value.get("premiumInteractions"))
                .or_else(|| {
                    payload
                        .get("quota_snapshots")
                        .and_then(|value| value.get("premium_interactions"))
                })
                .and_then(|value| quota_from_remaining("Premium interactions", value));
            snapshot.secondary_quota = payload
                .get("quotaSnapshots")
                .or_else(|| payload.get("quota_snapshots"))
                .and_then(|value| value.get("chat"))
                .and_then(|value| quota_from_remaining("Chat", value));
            if let Some(reset_date) = payload
                .get("quotaResetDateUtc")
                .or_else(|| payload.get("quota_reset_date_utc"))
                .and_then(Value::as_str)
            {
                if let Some((reset_at, reset_text)) = parse_reset_date(reset_date) {
                    if let Some(primary) = snapshot.primary_quota.as_mut() {
                        primary.reset_at = Some(reset_at);
                        primary.reset_text = Some(reset_text.clone());
                    }
                    if let Some(secondary) = snapshot.secondary_quota.as_mut() {
                        secondary.reset_at = Some(reset_at);
                        secondary.reset_text = Some(reset_text);
                    }
                }
            }
            snapshot.refreshed_at = Some(Utc::now());

            if snapshot.primary_quota.is_none() && snapshot.secondary_quota.is_none() {
                snapshot.status = ProviderStatus::Error;
                snapshot.error_message =
                    Some("Copilot response did not include recognizable quota windows".to_string());
                snapshot.remediation =
                    Some("Inspect the helper output to update the parser.".to_string());
            }

            snapshot
        })
    }
}

fn quota_from_remaining(label: &str, value: &Value) -> Option<QuotaWindow> {
    let unlimited = value
        .get("unlimited")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let remaining_percent = value_as_f64(value.get("percentRemaining"))
        .or_else(|| value_as_f64(value.get("remainingPercent")))
        .or_else(|| value_as_f64(value.get("percent_remaining")))
        .map(|percent| percent.clamp(0.0, 100.0));
    let used_percent = if unlimited {
        None
    } else {
        remaining_percent.map(|percent| (100.0 - percent).clamp(0.0, 100.0))
    };

    Some(QuotaWindow {
        label: label.to_string(),
        used_percent,
        remaining_percent,
        value_label: if unlimited {
            Some("Included".to_string())
        } else {
            None
        },
        used_display: used_percent.map(|percent| format!("{percent:.0}% used")),
        remaining_display: None,
        reset_at: None,
        reset_text: None,
    })
}

fn parse_reset_date(text: &str) -> Option<(DateTime<Utc>, String)> {
    let reset_at = DateTime::parse_from_rfc3339(text).ok()?.with_timezone(&Utc);
    let remaining = reset_at.signed_duration_since(Utc::now());
    let total_minutes = remaining.num_minutes().max(0);
    let days = total_minutes / (24 * 60);
    let hours = (total_minutes % (24 * 60)) / 60;
    let minutes = total_minutes % 60;
    let label = if days > 0 {
        format!("Resets in {days}d {hours}h")
    } else if hours > 0 {
        format!("Resets in {hours}h {minutes}m")
    } else {
        format!("Resets in {minutes}m")
    };
    Some((reset_at, label))
}
