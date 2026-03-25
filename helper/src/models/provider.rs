use serde::Deserialize;

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderMetadata {
    pub id: String,
    pub title: String,
    pub description: String,
    pub icon_name: String,
    #[serde(default = "default_true")]
    pub default_enabled: bool,
}

fn default_true() -> bool {
    true
}
