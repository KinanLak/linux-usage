use crate::providers::ProviderRegistry;
use anyhow::Result;
use std::sync::Arc;
use zbus::connection::Builder;
use zbus::interface;

pub async fn run(registry: ProviderRegistry) -> Result<()> {
    let api = LinuxUsageApi {
        registry: Arc::new(registry),
    };

    let _connection = Builder::session()?
        .name("org.kinanl.LinuxUsage.Helper")?
        .serve_at("/org/kinanl/LinuxUsage/Helper", api)?
        .build()
        .await?;

    std::future::pending::<()>().await;
    Ok(())
}

struct LinuxUsageApi {
    registry: Arc<ProviderRegistry>,
}

#[interface(name = "org.kinanl.LinuxUsage.Helper")]
impl LinuxUsageApi {
    async fn snapshot_json(&self) -> zbus::fdo::Result<String> {
        let snapshot = self.registry.fetch_cached_or_live().await;
        serde_json::to_string(&snapshot).map_err(map_err)
    }

    async fn refresh_json(&self) -> zbus::fdo::Result<String> {
        let snapshot = self.registry.fetch_all().await;
        serde_json::to_string(&snapshot).map_err(map_err)
    }
}

fn map_err(error: impl std::fmt::Display) -> zbus::fdo::Error {
    zbus::fdo::Error::Failed(error.to_string())
}
