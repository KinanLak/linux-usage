use anyhow::{Context, Result};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

const TRANSIENT_BACKOFF_BASE_SECONDS: i64 = 60 * 5;
const TRANSIENT_BACKOFF_MAX_SECONDS: i64 = 60 * 60 * 6;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderBackoffEntry {
    pub blocked_until: DateTime<Utc>,
    pub failure_count: u32,
    pub last_error: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct PersistedBackoffState {
    providers: HashMap<String, ProviderBackoffEntry>,
}

pub struct ProviderBackoffCache {
    path: PathBuf,
}

impl ProviderBackoffCache {
    pub fn new() -> Result<Self> {
        let mut root = dirs::cache_dir().context("missing cache directory")?;
        root.push("linux-usage");
        fs::create_dir_all(&root)?;
        Ok(Self {
            path: root.join("provider-backoff.json"),
        })
    }

    pub fn active(&self, provider_id: &str, now: DateTime<Utc>) -> Option<ProviderBackoffEntry> {
        let mut state = self.load_state().ok()?;
        let mut changed = prune_expired_entries(&mut state, now);
        let active = state
            .providers
            .get(provider_id)
            .cloned()
            .filter(|entry| entry.blocked_until > now);
        if active.is_none() && state.providers.remove(provider_id).is_some() {
            changed = true;
        }
        if changed {
            let _ = self.store_state(&state);
        }
        active
    }

    pub fn clear(&self, provider_id: &str) -> Result<()> {
        let mut state = self.load_state().unwrap_or_default();
        if state.providers.remove(provider_id).is_none() {
            return Ok(());
        }
        self.store_state(&state)
    }

    pub fn record_failure(
        &self,
        provider_id: &str,
        now: DateTime<Utc>,
        last_error: Option<&str>,
    ) -> Result<ProviderBackoffEntry> {
        let mut state = self.load_state().unwrap_or_default();
        prune_expired_entries(&mut state, now);

        let failure_count = state
            .providers
            .get(provider_id)
            .map_or(1, |entry| entry.failure_count.saturating_add(1));
        let blocked_until = now + transient_backoff_interval(failure_count);
        let entry = ProviderBackoffEntry {
            blocked_until,
            failure_count,
            last_error: last_error.map(ToString::to_string),
        };

        state
            .providers
            .insert(provider_id.to_string(), entry.clone());
        self.store_state(&state)?;
        Ok(entry)
    }

    fn load_state(&self) -> Result<PersistedBackoffState> {
        if !self.path.exists() {
            return Ok(PersistedBackoffState::default());
        }
        let raw = fs::read_to_string(&self.path)?;
        serde_json::from_str(&raw).context("failed to parse provider backoff cache")
    }

    fn store_state(&self, state: &PersistedBackoffState) -> Result<()> {
        fs::write(&self.path, serde_json::to_vec_pretty(state)?)?;
        Ok(())
    }
}

fn prune_expired_entries(state: &mut PersistedBackoffState, now: DateTime<Utc>) -> bool {
    let before = state.providers.len();
    state.providers.retain(|_, entry| entry.blocked_until > now);
    state.providers.len() != before
}

fn transient_backoff_interval(failure_count: u32) -> Duration {
    let exponent = failure_count.saturating_sub(1).min(10);
    let seconds = TRANSIENT_BACKOFF_BASE_SECONDS
        .saturating_mul(1_i64.checked_shl(exponent).unwrap_or(i64::MAX))
        .min(TRANSIENT_BACKOFF_MAX_SECONDS);
    Duration::seconds(seconds)
}

#[cfg(test)]
mod tests {
    use super::transient_backoff_interval;
    use chrono::Duration;

    #[test]
    fn backoff_grows_exponentially() {
        assert_eq!(transient_backoff_interval(1), Duration::minutes(5));
        assert_eq!(transient_backoff_interval(2), Duration::minutes(10));
        assert_eq!(transient_backoff_interval(3), Duration::minutes(20));
    }

    #[test]
    fn backoff_is_capped() {
        assert_eq!(transient_backoff_interval(20), Duration::hours(6));
    }
}
