use std::path::PathBuf;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "curupira-stack", about = "Merge system, user and repo site layers into one bundle")]
struct Cli {
    /// Directory the repo-layer walk starts from.
    #[arg(long, global = true)]
    from: Option<PathBuf>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Print every layer that would be merged, lowest priority first.
    Layers,
    /// Compile the merged stack into a bundle.
    Build {
        #[arg(short, long, default_value = "-")]
        out: String,
        #[arg(long)]
        pretty: bool,
    },
    /// Print the workspaces and the URLs each would open.
    Workspaces,
}

fn main() {
    if let Err(e) = run() {
        eprintln!("curupira-stack: {e}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    let start = match cli.from {
        Some(p) => p,
        None => std::env::current_dir()?,
    };
    let layers = curupira_stack::layers(&start)?;
    if matches!(cli.cmd, Cmd::Layers) {
        for l in &layers {
            println!("{}", l.display());
        }
        return Ok(());
    }
    let bundle = curupira_stack::compile(&curupira_stack::load(&layers)?, &layers);
    if let Some(p) = &bundle.stack {
        for r in &p.refused {
            eprintln!("refused: {r}");
        }
    }
    match cli.cmd {
        Cmd::Layers => {}
        Cmd::Build { out, pretty } => {
            let json = if pretty { serde_json::to_string_pretty(&bundle)? } else { serde_json::to_string(&bundle)? };
            if out == "-" {
                println!("{json}");
            } else {
                std::fs::write(&out, json)?;
                eprintln!(
                    "wrote {out}: {} site(s), {} workspace(s) from {} layer(s)",
                    bundle.sites.len(),
                    bundle.workspaces.len(),
                    layers.len()
                );
            }
        }
        Cmd::Workspaces => {
            for ws in &bundle.workspaces {
                println!("{}{}", ws.name, ws.description.as_deref().map(|d| format!("  — {d}")).unwrap_or_default());
                for t in &ws.tabs {
                    println!("  {:<24} {}", t.key, t.url);
                }
            }
        }
    }
    Ok(())
}
