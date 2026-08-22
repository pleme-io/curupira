//! `curupira-akeyless` — drive our akeyless tenant's API from the command line.
//!
//! Reads-only by default; the one mutating verb (`create-api-key`) demands an
//! explicit `--grant "<what the operator said>"` so the borrowed-ground grant is
//! recorded in the invocation itself. The access key is read from
//! `AKEYLESS_ACCESS_KEY` (or stdin with `--access-key-stdin`), never a flag.

use std::io::Read as _;

use clap::{Parser, Subcommand};
use curupira_akeyless::{AkeylessClient, Authorization};

#[derive(Parser)]
#[command(name = "curupira-akeyless", about = "Typed, gated client for the akeyless API")]
struct Cli {
    /// akeyless API base URL, e.g. https://api.akeyless.example
    #[arg(long, env = "AKEYLESS_API_URL", hide_env_values = true)]
    url: String,

    /// The access id (an identifier, not a secret).
    #[arg(long, env = "AKEYLESS_ACCESS_ID", hide_env_values = true)]
    access_id: String,

    /// Read the access key from stdin instead of the AKEYLESS_ACCESS_KEY env var.
    #[arg(long)]
    access_key_stdin: bool,

    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Observe: authenticate and print the token's expiry (never the token).
    Whoami,
    /// Observe: list the tenant's auth methods.
    ListAuthMethods,
    /// Observe: list the tenant's items.
    ListItems,
    /// Mutate: create an API-key auth method (the autonomous account). Requires
    /// --grant recording the operator's go-ahead.
    CreateApiKey {
        /// The new auth method's name.
        #[arg(long)]
        name: String,
        /// The operator's own words authorizing this mutation. Required.
        #[arg(long)]
        grant: String,
    },
}

/// The access key is a secret: env var or stdin, never a flag.
fn read_access_key(from_stdin: bool) -> Result<String, String> {
    if from_stdin {
        let mut s = String::new();
        std::io::stdin().read_to_string(&mut s).map_err(|e| e.to_string())?;
        let s = s.trim().to_string();
        if s.is_empty() {
            return Err("stdin was empty; expected the access key".into());
        }
        Ok(s)
    } else {
        std::env::var("AKEYLESS_ACCESS_KEY")
            .map_err(|_| "set AKEYLESS_ACCESS_KEY, or pass --access-key-stdin (never a flag)".to_string())
    }
}

#[tokio::main]
async fn main() -> std::process::ExitCode {
    let cli = Cli::parse();
    match run(cli).await {
        Ok(out) => {
            println!("{out}");
            std::process::ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("error: {e}");
            std::process::ExitCode::FAILURE
        }
    }
}

async fn run(cli: Cli) -> Result<String, String> {
    let access_key = read_access_key(cli.access_key_stdin)?;
    let client = AkeylessClient::new(&cli.url);
    let session = client
        .authenticate(&cli.access_id, &access_key)
        .await
        .map_err(|e| e.to_string())?;

    match cli.cmd {
        Cmd::Whoami => Ok(format!(
            "authenticated as {} — token expires: {}",
            cli.access_id,
            session.expiration.as_deref().unwrap_or("(no expiry returned)")
        )),
        Cmd::ListAuthMethods => {
            let out = client.list_auth_methods(&session).await.map_err(|e| e.to_string())?;
            serde_json::to_string_pretty(&out).map_err(|e| e.to_string())
        }
        Cmd::ListItems => {
            let out = client.list_items(&session).await.map_err(|e| e.to_string())?;
            serde_json::to_string_pretty(&out).map_err(|e| e.to_string())
        }
        Cmd::CreateApiKey { name, grant } => {
            // The grant is required by the type below; recording it here is what
            // turns "the operator said go ahead" into an auditable fact.
            let auth = Authorization::grant(format!("akeyless.create-api-key:{name}"), grant);
            let id = client
                .create_api_key_auth_method(&session, &name, &auth)
                .await
                .map_err(|e| e.to_string())?;
            // access_key is a secret printed ONCE for the operator to capture; it
            // is not retrievable again from akeyless.
            Ok(format!(
                "created auth method '{}'\n  access_id:  {}\n  access_key: {}",
                id.name,
                id.access_id.as_deref().unwrap_or("(none)"),
                id.access_key.as_deref().unwrap_or("(none)")
            ))
        }
    }
}
