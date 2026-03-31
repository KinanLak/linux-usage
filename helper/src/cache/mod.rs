pub mod backoff;

use crate::models::AppSnapshot;
use anyhow::{Context, Result};
use std::fs;
use std::path::PathBuf;

pub struct SnapshotCache {
    path: PathBuf,
}

impl SnapshotCache {
    pub fn new() -> Result<Self> {
        let mut root = dirs::cache_dir().context("missing cache directory")?;
        root.push("linux-usage");
        fs::create_dir_all(&root)?;
        Ok(Self {
            path: root.join("snapshot.json"),
        })
    }

    pub fn load(&self) -> Option<AppSnapshot> {
        let raw = fs::read_to_string(&self.path).ok()?;
        serde_json::from_str(&raw).ok()
    }

    pub fn store(&self, snapshot: &AppSnapshot) -> Result<()> {
        fs::write(&self.path, serde_json::to_vec_pretty(snapshot)?)?;
        Ok(())
    }
}
