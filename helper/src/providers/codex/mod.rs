use crate::models::{ProviderId, ProviderSnapshot, ProviderStatus, QuotaWindow};
use crate::providers::{
    BoxFuture, Provider, ProviderContext, parse_jwt_claims, percent_pair_from_remaining_limit,
    status_snapshot, value_as_f64, value_as_string, value_at_path,
};
use crate::sessions::{first_existing, home_dir, read_json_file};
use chrono::{TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

#[derive(Debug, Default)]
pub struct CodexProvider;

#[derive(Debug, Deserialize, Serialize)]
struct CodexAuthFile {
    tokens: Option<CodexTokens>,
}

#[derive(Debug, Deserialize, Serialize)]
struct CodexTokens {
    access_token: Option<String>,
    id_token: Option<String>,
    refresh_token: Option<String>,
}

impl Provider for CodexProvider {
    fn fetch<'a>(&'a self, ctx: &'a ProviderContext) -> BoxFuture<'a, ProviderSnapshot> {
        Box::pin(async move {
            let Some(path) = discover_auth_path() else {
                return status_snapshot(
                    ProviderId::Codex,
                    ProviderStatus::Unconfigured,
                    Some("No local Codex session found".to_string()),
                    Some("Sign in with the Codex CLI to enable quota monitoring.".to_string()),
                );
            };

            let auth: CodexAuthFile = match read_json_file(&path) {
                Ok(value) => value,
                Err(error) => {
                    return status_snapshot(
                        ProviderId::Codex,
                        ProviderStatus::Error,
                        Some(error.to_string()),
                        Some("Inspect ~/.codex/auth.json permissions and content.".to_string()),
                    );
                }
            };

            let mut token = auth
                .tokens
                .as_ref()
                .and_then(|tokens| tokens.access_token.clone());

            let Some(mut token_value) = token.take() else {
                return status_snapshot(
                    ProviderId::Codex,
                    ProviderStatus::AuthRequired,
                    Some("Codex auth file exists but has no access token".to_string()),
                    Some("Run `codex login` again to refresh the local session.".to_string()),
                );
            };

            let mut claims = auth
                .tokens
                .as_ref()
                .and_then(|tokens| tokens.id_token.as_deref())
                .and_then(parse_jwt_claims)
                .or_else(|| parse_jwt_claims(&token_value));

            let mut response = match ctx
                .client
                .get("https://chatgpt.com/backend-api/wham/usage")
                .bearer_auth(&token_value)
                .send()
                .await
            {
                Ok(value) => value,
                Err(error) => {
                    return status_snapshot(
                        ProviderId::Codex,
                        ProviderStatus::Error,
                        Some(format!("Codex request failed: {error}")),
                        Some("Check network access or try again later.".to_string()),
                    );
                }
            };

            if response.status().as_u16() == 401 {
                if let Some(refreshed) = refresh_access_token(ctx, &path, &auth).await {
                    token_value = refreshed.0;
                    claims = refreshed.1.or(claims);
                    response = match ctx
                        .client
                        .get("https://chatgpt.com/backend-api/wham/usage")
                        .bearer_auth(&token_value)
                        .send()
                        .await
                    {
                        Ok(value) => value,
                        Err(error) => {
                            return status_snapshot(
                                ProviderId::Codex,
                                ProviderStatus::Error,
                                Some(format!("Codex retry failed after refresh: {error}")),
                                Some("Check network access or try again later.".to_string()),
                            );
                        }
                    };
                }
            }

            if !response.status().is_success() {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                let rpc_result = fetch_via_rpc().await;
                if let Ok(snapshot) = rpc_result {
                    return snapshot;
                }

                let parsed_error = parse_error_response(&body);
                let rpc_error = rpc_result.err();
                let combined_error = rpc_error.or(parsed_error.clone());
                let message = combined_error.unwrap_or_else(|| {
                    crate::providers::error_from_status(
                        status,
                        "Codex usage endpoint returned an unexpected status",
                    )
                });
                return status_snapshot(
                    ProviderId::Codex,
                    if status.is_client_error() {
                        ProviderStatus::AuthRequired
                    } else {
                        ProviderStatus::Error
                    },
                    Some(message.clone()),
                    Some(remediation_for_error(Some(&message))),
                );
            }

            let payload: Value = match response.json().await {
                Ok(value) => value,
                Err(error) => {
                    return status_snapshot(
                        ProviderId::Codex,
                        ProviderStatus::Error,
                        Some(format!("Codex payload parse failed: {error}")),
                        Some("The provider response format may have changed.".to_string()),
                    );
                }
            };

            let mut snapshot = ProviderSnapshot::base(ProviderId::Codex);
            snapshot.status = ProviderStatus::Ok;
            snapshot.source_label = Some("Local session + OpenAI usage API".to_string());
            snapshot.account_label = claims
                .as_ref()
                .and_then(|value| {
                    value_at_path(value, &["https://api.openai.com/profile", "email"])
                })
                .or_else(|| claims.as_ref().and_then(|value| value.get("email")))
                .and_then(|value| value.as_str())
                .map(ToString::to_string);
            snapshot.plan_label = claims
                .as_ref()
                .and_then(|value| {
                    value_at_path(value, &["https://api.openai.com/auth", "chatgpt_plan_type"])
                })
                .or_else(|| claims.as_ref().and_then(|value| value.get("plan")))
                .and_then(|value| value.as_str())
                .map(|value| value.to_ascii_uppercase());
            snapshot.primary_quota =
                extract_rate_limit_window(&payload, "Session", "primary_window")
                    .or_else(|| extract_named_window(&payload, "Session", PRIMARY_PATHS.as_slice()))
                    .or_else(|| extract_first_window(&payload, "Session"));
            snapshot.secondary_quota =
                extract_rate_limit_window(&payload, "Weekly", "secondary_window")
                    .or_else(|| {
                        extract_named_window(&payload, "Weekly", SECONDARY_PATHS.as_slice())
                    })
                    .or_else(|| extract_second_window(&payload, "Weekly"));
            snapshot.detail_lines = collect_detail_lines(&payload);
            snapshot.refreshed_at = Some(Utc::now());

            if snapshot.primary_quota.is_none() && snapshot.secondary_quota.is_none() {
                snapshot.status = ProviderStatus::Error;
                snapshot.error_message =
                    Some("Codex response did not include recognizable quota windows".to_string());
                snapshot.remediation =
                    Some("Inspect the helper output to update the parser.".to_string());
            }

            snapshot
        })
    }
}

const PRIMARY_PATHS: [[&str; 1]; 4] = [["five_hour"], ["fiveHour"], ["primary"], ["session"]];
const SECONDARY_PATHS: [[&str; 1]; 4] = [["seven_day"], ["weekly"], ["secondary"], ["week"]];

fn discover_auth_path() -> Option<PathBuf> {
    let home = home_dir().ok()?;
    first_existing(&[home.join(".codex/auth.json")])
}

fn extract_named_window(payload: &Value, label: &str, paths: &[[&str; 1]]) -> Option<QuotaWindow> {
    for path in paths {
        if let Some(value) = value_at_path(payload, path) {
            if let Some(window) = extract_window_from_value(label, value) {
                return Some(window);
            }
        }
    }
    None
}

fn extract_rate_limit_window(payload: &Value, label: &str, key: &str) -> Option<QuotaWindow> {
    let value = payload.get("rate_limit")?.get(key)?;
    let used_percent = value_as_f64(value.get("used_percent"));
    let reset_at = value
        .get("reset_at")
        .and_then(Value::as_i64)
        .and_then(|timestamp| Utc.timestamp_opt(timestamp, 0).single());
    let reset_text = value
        .get("reset_after_seconds")
        .and_then(Value::as_i64)
        .map(format_duration_seconds);

    Some(QuotaWindow {
        label: label.to_string(),
        used_percent,
        remaining_percent: used_percent.map(|percent| (100.0 - percent).clamp(0.0, 100.0)),
        value_label: None,
        used_display: used_percent.map(|percent| format!("{percent:.0}% used")),
        remaining_display: used_percent
            .map(|percent| format!("{:.0}% left", (100.0 - percent).clamp(0.0, 100.0))),
        reset_at,
        reset_text,
    })
}

fn extract_first_window(payload: &Value, label: &str) -> Option<QuotaWindow> {
    extract_window_from_arrayish(label, payload, 0)
}

fn extract_second_window(payload: &Value, label: &str) -> Option<QuotaWindow> {
    extract_window_from_arrayish(label, payload, 1)
}

fn extract_window_from_arrayish(label: &str, payload: &Value, index: usize) -> Option<QuotaWindow> {
    let array = payload
        .get("windows")
        .and_then(Value::as_array)
        .or_else(|| payload.get("quota_windows").and_then(Value::as_array))?;
    extract_window_from_value(label, array.get(index)?)
}

fn extract_window_from_value(label: &str, value: &Value) -> Option<QuotaWindow> {
    let remaining = value_as_f64(value.get("remaining"))
        .or_else(|| value_as_f64(value.get("remaining_amount")));
    let limit = value_as_f64(value.get("limit"))
        .or_else(|| value_as_f64(value.get("max")))
        .or_else(|| value_as_f64(value.get("quota")));
    let used = value_as_f64(value.get("used"))
        .or_else(|| value_as_f64(value.get("consumed")))
        .or_else(|| match (remaining, limit) {
            (Some(remaining), Some(limit)) => Some(limit - remaining),
            _ => None,
        });
    let (used_percent, remaining_percent) = if value.get("used_percentage").is_some() {
        let used_percent = value_as_f64(value.get("used_percentage"));
        (used_percent, used_percent.map(|percent| 100.0 - percent))
    } else if value.get("remaining_percentage").is_some() {
        let remaining_percent = value_as_f64(value.get("remaining_percentage"));
        (
            remaining_percent.map(|percent| 100.0 - percent),
            remaining_percent,
        )
    } else {
        percent_pair_from_remaining_limit(remaining, limit)
    };

    if used_percent.is_none() && remaining_percent.is_none() {
        return None;
    }

    Some(QuotaWindow {
        label: label.to_string(),
        used_percent,
        remaining_percent,
        value_label: None,
        used_display: used
            .map(|value| format_number(value))
            .or_else(|| value_as_string(value.get("used_text"))),
        remaining_display: remaining
            .map(|value| format_number(value))
            .or_else(|| value_as_string(value.get("remaining_text"))),
        reset_at: value
            .get("resets_at")
            .or_else(|| value.get("reset_at"))
            .and_then(Value::as_str)
            .and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok())
            .map(|value| value.with_timezone(&Utc)),
        reset_text: value_as_string(value.get("resets_in"))
            .or_else(|| value_as_string(value.get("reset_in")))
            .or_else(|| value_as_string(value.get("reset_text"))),
    })
}

fn collect_detail_lines(payload: &Value) -> Vec<String> {
    let mut lines = Vec::new();
    if let Some(credits) = payload.get("credits") {
        if let Some(balance) = value_as_f64(credits.get("balance")) {
            lines.push(format!("Credits: {}", format_number(balance)));
        }
    }
    lines
}

fn format_number(value: f64) -> String {
    if (value.fract()).abs() < f64::EPSILON {
        format!("{value:.0}")
    } else {
        format!("{value:.2}")
    }
}

fn format_duration_seconds(seconds: i64) -> String {
    let seconds = seconds.max(0);
    let days = seconds / 86_400;
    let hours = (seconds % 86_400) / 3_600;
    let minutes = (seconds % 3_600) / 60;
    if days > 0 {
        format!("Resets in {days}d {hours}h")
    } else if hours > 0 {
        format!("Resets in {hours}h {minutes}m")
    } else {
        format!("Resets in {minutes}m")
    }
}

async fn refresh_access_token(
    ctx: &ProviderContext,
    path: &PathBuf,
    auth: &CodexAuthFile,
) -> Option<(String, Option<Value>)> {
    let refresh_token = auth
        .tokens
        .as_ref()
        .and_then(|tokens| tokens.refresh_token.clone())?;

    let response = ctx
        .client
        .post("https://auth.openai.com/oauth/token")
        .json(&serde_json::json!({
            "client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "scope": "openid profile email"
        }))
        .send()
        .await
        .ok()?;

    if !response.status().is_success() {
        return None;
    }

    let refresh_payload: Value = response.json().await.ok()?;
    let access_token = refresh_payload.get("access_token")?.as_str()?.to_string();
    let id_token = refresh_payload
        .get("id_token")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let new_refresh = refresh_payload
        .get("refresh_token")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| {
            auth.tokens
                .as_ref()
                .and_then(|tokens| tokens.refresh_token.clone())
        });

    let mut updated = serde_json::to_value(auth).ok()?;
    updated["tokens"]["access_token"] = Value::String(access_token.clone());
    if let Some(id_token) = id_token.clone() {
        updated["tokens"]["id_token"] = Value::String(id_token.clone());
    }
    if let Some(new_refresh) = new_refresh {
        updated["tokens"]["refresh_token"] = Value::String(new_refresh);
    }
    updated["last_refresh"] = Value::String(Utc::now().to_rfc3339());

    let _ = fs::write(path, serde_json::to_vec_pretty(&updated).ok()?);
    let claims = id_token
        .as_deref()
        .and_then(parse_jwt_claims)
        .or_else(|| parse_jwt_claims(&access_token));

    Some((access_token, claims))
}

async fn fetch_via_rpc() -> Result<ProviderSnapshot, String> {
    let mut child = Command::new("codex")
        .args(["-s", "read-only", "-a", "untrusted", "app-server"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Failed to start Codex CLI: {error}"))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Codex CLI stdin unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Codex CLI stdout unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Codex CLI stderr unavailable".to_string())?;

    for payload in [
        serde_json::json!({
            "id": 1,
            "method": "initialize",
            "params": {"clientInfo": {"name": "linux-usage", "version": "0.1.0"}}
        }),
        serde_json::json!({"method": "initialized", "params": {}}),
        serde_json::json!({"id": 2, "method": "account/rateLimits/read", "params": {}}),
        serde_json::json!({"id": 3, "method": "account/read", "params": {}}),
    ] {
        let line = format!("{}\n", payload);
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|error| format!("Failed to talk to Codex CLI: {error}"))?;
    }
    drop(stdin);

    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        let mut lines = Vec::new();
        while let Ok(Some(line)) = reader.next_line().await {
            lines.push(line);
        }
        lines
    });

    let mut stdout_lines = BufReader::new(stdout).lines();
    let mut rate_limits: Option<Value> = None;
    let mut account: Option<Value> = None;
    let mut rpc_error: Option<String> = None;

    while let Ok(Some(line)) = stdout_lines.next_line().await {
        let value: Value = serde_json::from_str(&line)
            .map_err(|error| format!("Malformed Codex RPC output: {error}"))?;
        match value.get("id").and_then(Value::as_i64) {
            Some(2) => {
                if let Some(error_message) = value
                    .get("error")
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
                {
                    rpc_error = Some(error_message.to_string());
                } else {
                    rate_limits = value.get("result").cloned();
                }
            }
            Some(3) => {
                account = value.get("result").cloned();
            }
            _ => {}
        }

        if rate_limits.is_some() && account.is_some() {
            break;
        }
        if rpc_error.is_some() && account.is_some() {
            break;
        }
    }

    let _ = child.kill().await;
    let stderr_lines = stderr_task.await.unwrap_or_default();

    if let Some(rate_limits) = rate_limits {
        let mut snapshot = ProviderSnapshot::base(ProviderId::Codex);
        snapshot.status = ProviderStatus::Ok;
        snapshot.source_label = Some("Codex CLI app-server".to_string());
        snapshot.account_label = account
            .as_ref()
            .and_then(|value| value.get("account"))
            .and_then(|value| value.get("email"))
            .and_then(Value::as_str)
            .map(ToString::to_string);
        snapshot.plan_label = account
            .as_ref()
            .and_then(|value| value.get("account"))
            .and_then(|value| value.get("planType"))
            .and_then(Value::as_str)
            .map(|value| value.to_ascii_uppercase());

        let limits = rate_limits.get("rateLimits").unwrap_or(&rate_limits);
        snapshot.primary_quota = rpc_window("Session", limits.get("primary"));
        snapshot.secondary_quota = rpc_window("Weekly", limits.get("secondary"));
        if let Some(balance) = limits
            .get("credits")
            .and_then(|credits| credits.get("balance"))
            .and_then(Value::as_str)
        {
            snapshot.detail_lines.push(format!("Credits: {balance}"));
        }
        snapshot.refreshed_at = Some(Utc::now());
        return Ok(snapshot);
    }

    let cleaned_stderr = stderr_lines
        .into_iter()
        .map(|line| strip_ansi(&line))
        .collect::<Vec<_>>();
    let stderr_hint = cleaned_stderr.iter().find_map(|line| {
        if line.contains("refresh token has already been used")
            || line.contains("refresh token was already used")
            || line.contains("refresh_token_reused")
        {
            Some(
                "Your Codex refresh token was already used. Run `codex logout` then `codex login`."
                    .to_string(),
            )
        } else if line.contains("token could not be refreshed") {
            Some(line.clone())
        } else {
            None
        }
    });
    Err(stderr_hint.or(rpc_error).unwrap_or_else(|| {
        "Codex CLI did not return rate limits. Try `codex logout` then `codex login`.".to_string()
    }))
}

fn rpc_window(label: &str, value: Option<&Value>) -> Option<QuotaWindow> {
    let value = value?;
    let used_percent = value.get("usedPercent").and_then(Value::as_f64);
    let reset_at = value
        .get("resetsAt")
        .and_then(Value::as_i64)
        .and_then(|timestamp| Utc.timestamp_opt(timestamp, 0).single());
    Some(QuotaWindow {
        label: label.to_string(),
        used_percent,
        remaining_percent: used_percent.map(|percent| (100.0 - percent).clamp(0.0, 100.0)),
        value_label: None,
        used_display: used_percent.map(|percent| format!("{percent:.0}% used")),
        remaining_display: used_percent
            .map(|percent| format!("{:.0}% left", (100.0 - percent).clamp(0.0, 100.0))),
        reset_at,
        reset_text: None,
    })
}

fn parse_error_response(body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body).ok()?;
    value
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn remediation_for_error(message: Option<&str>) -> String {
    let message = message.unwrap_or_default();
    if message.contains("refresh token has already been used")
        || message.contains("already used")
        || message.contains("refresh_token_reused")
    {
        return "Run `codex logout`, then `codex login` to generate a fresh local session."
            .to_string();
    }
    if message.contains("token is expired") || message.contains("token_expired") {
        return "Refresh your Codex login and try again.".to_string();
    }
    "Refresh your Codex login or try again later.".to_string()
}

fn strip_ansi(input: &str) -> String {
    let mut output = String::new();
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                while let Some(next) = chars.next() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
                continue;
            }
        }
        output.push(ch);
    }
    output
}
