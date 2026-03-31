use crate::models::{ProviderMetadata, ProviderSnapshot, ProviderStatus, QuotaWindow};
use crate::providers::{
    BoxFuture, Provider, ProviderContext, parse_jwt_claims, percent_pair_from_used_limit,
    provider_status_from_http_status, required_provider_metadata, status_snapshot, value_as_f64,
    value_as_string,
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
struct ClaudeOauthCredentials {
    #[serde(alias = "accessToken")]
    access_token: Option<String>,
    #[serde(alias = "rateLimitTier")]
    rate_limit_tier: Option<String>,
    #[serde(alias = "subscriptionType")]
    subscription_type: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ClaudeCredentials {
    #[serde(alias = "accessToken")]
    access_token: Option<String>,
    #[serde(alias = "rateLimitTier")]
    rate_limit_tier: Option<String>,
    email: Option<String>,
    #[serde(alias = "claudeAiOauth")]
    claude_ai_oauth: Option<ClaudeOauthCredentials>,
}

#[derive(Debug, Deserialize)]
struct ClaudeAccount {
    display_name: Option<String>,
    full_name: Option<String>,
    email_address: Option<String>,
}

impl ClaudeCredentials {
    fn access_token(&self) -> Option<&str> {
        self.access_token.as_deref().or_else(|| {
            self.claude_ai_oauth
                .as_ref()
                .and_then(|oauth| oauth.access_token.as_deref())
        })
    }

    fn plan_label(&self) -> Option<String> {
        self.rate_limit_tier
            .as_ref()
            .or_else(|| {
                self.claude_ai_oauth
                    .as_ref()
                    .and_then(|oauth| oauth.rate_limit_tier.as_ref())
            })
            .map(|value| format_plan_label(value))
            .or_else(|| {
                self.claude_ai_oauth
                    .as_ref()
                    .and_then(|oauth| oauth.subscription_type.as_ref())
                    .map(|value| format_plan_label(value))
            })
    }
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

            let Some(token) = creds.access_token().map(ToString::to_string) else {
                return status_snapshot(
                    metadata,
                    ProviderStatus::AuthRequired,
                    Some("Claude credentials exist but no access token is present".to_string()),
                    Some("Run `claude auth login` again to refresh the token.".to_string()),
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
                    provider_status_from_http_status(response.status()),
                    Some(message),
                    Some("Refresh Claude Code with `claude auth login` or update the scope."
                        .to_string()),
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
            snapshot.account_label = local_account_label(&creds, claims.as_ref());
            if snapshot.account_label.is_none() {
                snapshot.account_label = fetch_account_label(ctx, &token).await;
            }
            snapshot.plan_label = creds.plan_label();
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

fn local_account_label(creds: &ClaudeCredentials, claims: Option<&Value>) -> Option<String> {
    creds.email.clone().or_else(|| {
        claims
            .and_then(|value| value.get("email"))
            .and_then(Value::as_str)
            .map(ToString::to_string)
    })
}

async fn fetch_account_label(ctx: &ProviderContext, token: &str) -> Option<String> {
    let response = ctx
        .client
        .get("https://api.anthropic.com/api/oauth/account")
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }

    let account: ClaudeAccount = response.json().await.ok()?;
    account
        .display_name
        .or(account.full_name)
        .or(account.email_address)
}

fn quota_from_usage(label: &str, value: &Value) -> Option<QuotaWindow> {
    let used = value_as_f64(value.get("used"))
        .or_else(|| value_as_f64(value.get("usage")));
    let used_percent = value_as_f64(value.get("percent_used"))
        .or_else(|| value_as_f64(value.get("utilization")).map(normalize_percent));
    let limit = value_as_f64(value.get("limit")).or_else(|| {
        value_as_f64(value.get("max")).or_else(|| {
            if used_percent.is_some() {
                Some(100.0)
            } else {
                None
            }
        })
    });
    let (used_percent, remaining_percent) = if let Some(used_percent) = used_percent {
        (
            Some(used_percent),
            Some((100.0 - used_percent).clamp(0.0, 100.0)),
        )
    } else {
        percent_pair_from_used_limit(used, limit)
    };

    Some(QuotaWindow {
        label: label.to_string(),
        used_percent,
        remaining_percent,
        value_label: None,
        used_display: value_as_string(value.get("used_display"))
            .or_else(|| used.map(|v| format!("{v:.0}")))
            .or_else(|| used_percent.map(|percent| format!("{percent:.0}% used"))),
        remaining_display: value_as_string(value.get("remaining_display"))
            .or_else(|| {
                remaining_percent.map(|percent| format!("{percent:.0}% left"))
            })
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

fn normalize_percent(value: f64) -> f64 {
    if (0.0..=1.0).contains(&value) {
        value * 100.0
    } else {
        value
    }
}

fn format_plan_label(value: &str) -> String {
    let mut parts = value
        .split('_')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();

    if parts.first().is_some_and(|part| part.eq_ignore_ascii_case("default")) {
        parts.remove(0);
    }

    parts.into_iter().map(format_plan_token).collect::<Vec<_>>().join(" ")
}

fn format_plan_token(token: &str) -> String {
    let lower = token.to_ascii_lowercase();
    if lower.ends_with('x') && lower[..lower.len() - 1].chars().all(|ch| ch.is_ascii_digit()) {
        return lower;
    }

    let mut chars = lower.chars();
    let Some(first) = chars.next() else {
        return String::new();
    };

    let mut formatted = String::new();
    formatted.push(first.to_ascii_uppercase());
    formatted.extend(chars);
    formatted
}

#[cfg(test)]
mod tests {
    use super::{format_plan_label, normalize_percent, quota_from_usage};
    use serde_json::json;

    #[test]
    fn formats_claude_plan_labels() {
        assert_eq!(format_plan_label("DEFAULT_CLAUDE_MAX_5X"), "Claude Max 5x");
        assert_eq!(format_plan_label("claude_pro"), "Claude Pro");
    }

    #[test]
    fn normalizes_utilization_ratios() {
        assert_eq!(normalize_percent(0.02), 2.0);
        assert_eq!(normalize_percent(2.0), 2.0);
    }

    #[test]
    fn parses_utilization_windows() {
        let window = quota_from_usage(
            "Session",
            &json!({
                "utilization": 2.0,
                "resets_at": "2026-03-31T10:00:00.968603+00:00"
            }),
        )
        .expect("window should parse");

        assert_eq!(window.used_percent, Some(2.0));
        assert_eq!(window.remaining_percent, Some(98.0));
        assert_eq!(window.used_display.as_deref(), Some("2% used"));
        assert_eq!(window.remaining_display.as_deref(), Some("98% left"));
        assert!(window.reset_at.is_some());
    }
}
