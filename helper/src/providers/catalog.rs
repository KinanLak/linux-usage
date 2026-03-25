use crate::models::ProviderMetadata;
use std::sync::OnceLock;

const PROVIDER_CATALOG_JSON: &str = include_str!("../../../extension/providers.json");

static PROVIDER_CATALOG: OnceLock<Vec<ProviderMetadata>> = OnceLock::new();

pub fn provider_catalog() -> &'static [ProviderMetadata] {
    PROVIDER_CATALOG
        .get_or_init(|| {
            serde_json::from_str(PROVIDER_CATALOG_JSON).expect("invalid provider catalog")
        })
        .as_slice()
}

pub fn provider_metadata(id: &str) -> Option<&'static ProviderMetadata> {
    provider_catalog().iter().find(|metadata| metadata.id == id)
}

pub fn required_provider_metadata(id: &str) -> &'static ProviderMetadata {
    provider_metadata(id).unwrap_or_else(|| panic!("missing provider metadata for `{id}`"))
}
