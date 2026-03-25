mod cache;
mod dbus;
mod models;
mod providers;
mod sessions;

use anyhow::Result;
use clap::{Parser, Subcommand};
use models::AppSnapshot;
use providers::ProviderRegistry;
use tracing_subscriber::EnvFilter;

#[derive(Parser, Debug)]
#[command(name = "linux-usage-helper")]
#[command(about = "Fetch quota snapshots for Linux Usage")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand, Debug)]
enum Command {
    Snapshot {
        #[arg(long)]
        pretty: bool,
    },
    Probe {
        provider: String,
    },
    ServeDbus,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .without_time()
        .init();

    let cli = Cli::parse();
    let registry = ProviderRegistry::new()?;

    match cli.command.unwrap_or(Command::Snapshot { pretty: false }) {
        Command::Snapshot { pretty } => {
            let snapshot = registry.fetch_all().await;
            print_snapshot(&snapshot, pretty)?;
        }
        Command::Probe { provider } => {
            let snapshot = registry.fetch_one(&provider).await.ok_or_else(|| {
                anyhow::anyhow!(
                    "unknown provider `{provider}`; available providers: {}",
                    registry.known_provider_ids().join(", ")
                )
            })?;
            println!("{}", serde_json::to_string_pretty(&snapshot)?);
        }
        Command::ServeDbus => {
            dbus::service::run(registry).await?;
        }
    }

    Ok(())
}

fn print_snapshot(snapshot: &AppSnapshot, pretty: bool) -> Result<()> {
    if pretty {
        println!("{}", serde_json::to_string_pretty(snapshot)?);
    } else {
        println!("{}", serde_json::to_string(snapshot)?);
    }
    Ok(())
}
