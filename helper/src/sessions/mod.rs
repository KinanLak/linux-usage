use anyhow::{Context, Result};
use serde::de::DeserializeOwned;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

pub fn home_dir() -> Result<PathBuf> {
    dirs::home_dir().context("missing home directory")
}

pub fn config_dir() -> Result<PathBuf> {
    Ok(env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or(home_dir()?.join(".config")))
}

pub fn read_json_file<T: DeserializeOwned>(path: &Path) -> Result<T> {
    let raw =
        fs::read_to_string(path).with_context(|| format!("failed to read {}", path.display()))?;
    let parsed = serde_json::from_str(&raw)
        .with_context(|| format!("failed to parse {}", path.display()))?;
    Ok(parsed)
}

pub fn first_existing(paths: &[PathBuf]) -> Option<PathBuf> {
    paths.iter().find(|path| path.exists()).cloned()
}
