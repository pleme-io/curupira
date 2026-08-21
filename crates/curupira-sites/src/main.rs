//! `curupira-sites` — compile console profiles into an MCP tool bundle.
//!
//! This binary is **author-time**. curupira's server loads the bundle it writes
//! and never runs this; editing a profile means re-running `build`, which is a
//! deliberate, reviewable regeneration step rather than a hidden runtime read.

use std::path::{Path, PathBuf};

use clap::{Parser, Subcommand};
use curupira_sites::{Bundle, ConsoleProfile, DRIVER_JS};

#[derive(Parser)]
#[command(name = "curupira-sites", about = "Compile web-console profiles into MCP tools")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Compile every *.yaml profile in DIRS into a bundle.
    Build {
        /// Directories to scan for `*.yaml` / `*.yml` profiles.
        #[arg(required = true)]
        dirs: Vec<PathBuf>,
        /// Where to write the bundle. `-` writes to stdout.
        #[arg(short, long, default_value = "sites.bundle.json")]
        out: String,
        /// Pretty-print the JSON.
        #[arg(long)]
        pretty: bool,
    },
    /// Parse and validate profiles without writing anything.
    Check {
        #[arg(required = true)]
        dirs: Vec<PathBuf>,
    },
    /// Print the terminal driver payload verbatim.
    EmitDriver,
    /// List what a bundle would expose, for review.
    List {
        #[arg(required = true)]
        dirs: Vec<PathBuf>,
    },
}

fn main() {
    if let Err(e) = run() {
        eprintln!("curupira-sites: {e}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    match Cli::parse().cmd {
        Cmd::EmitDriver => {
            print!("{DRIVER_JS}");
            Ok(())
        }
        Cmd::Check { dirs } => {
            let profiles = load_all(&dirs)?;
            let b = Bundle::compile(&profiles)?;
            let tools: usize = b.sites.iter().map(|s| s.tools.len()).sum();

            // Lints are a GATE here and a warning in `build`. A linted profile
            // loads and runs — it just quietly does the wrong thing — so the
            // place to stop it is the check a human or CI runs deliberately,
            // not the compile step someone runs to get unblocked.
            let mut linted = 0usize;
            for pr in &profiles {
                for l in pr.lints() {
                    eprintln!("lint [{}]: {l}", pr.id);
                    linted += 1;
                }
            }
            if linted > 0 {
                return Err(format!("{linted} lint(s) — see above").into());
            }
            println!("ok: {} site(s), {} tool(s)", b.sites.len(), tools);
            Ok(())
        }
        Cmd::List { dirs } => {
            let b = Bundle::compile(&load_all(&dirs)?)?;
            for s in &b.sites {
                println!("{}  ({})", s.id, s.base_url);
                println!("  match: {}", if s.match_urls.is_empty() {
                    "<none — never auto-selected>".to_string()
                } else {
                    s.match_urls.join(", ")
                });
                for t in &s.tools {
                    // Mutating tools are marked in the listing because this is
                    // the review surface: what could change the host if granted.
                    let mark = match t.effect {
                        Some(curupira_sites::Effect::Mutate) => " [MUTATES]",
                        _ => "",
                    };
                    println!("    {}{mark}", t.name);
                }
            }
            Ok(())
        }
        Cmd::Build { dirs, out, pretty } => {
            let profiles = load_all(&dirs)?;
            for pr in &profiles {
                for l in pr.lints() {
                    eprintln!("warning [{}]: {l}", pr.id);
                }
            }
            let b = Bundle::compile(&profiles)?;
            let json = if pretty {
                serde_json::to_string_pretty(&b)?
            } else {
                serde_json::to_string(&b)?
            };
            if out == "-" {
                println!("{json}");
            } else {
                std::fs::write(&out, json)?;
                let tools: usize = b.sites.iter().map(|s| s.tools.len()).sum();
                let mutating: usize = b
                    .sites
                    .iter()
                    .flat_map(|s| &s.tools)
                    .filter(|t| t.effect == Some(curupira_sites::Effect::Mutate))
                    .count();
                eprintln!(
                    "wrote {out}: {} site(s), {tools} tool(s), {mutating} mutating",
                    b.sites.len()
                );
            }
            Ok(())
        }
    }
}

/// Load every profile under the given directories.
///
/// A directory containing no profiles is an **error**, not an empty result: the
/// overwhelmingly likely cause is a wrong path, and silently compiling an empty
/// bundle would leave the server with no site tools and nothing saying why.
fn load_all(dirs: &[PathBuf]) -> Result<Vec<ConsoleProfile>, Box<dyn std::error::Error>> {
    let mut out = Vec::new();
    for d in dirs {
        let before = out.len();
        collect(d, &mut out)?;
        if out.len() == before {
            return Err(format!(
                "no *.yaml or *.yml profiles found under {} — check the path",
                d.display()
            )
            .into());
        }
    }
    Ok(out)
}

fn collect(dir: &Path, out: &mut Vec<ConsoleProfile>) -> Result<(), Box<dyn std::error::Error>> {
    if !dir.is_dir() {
        return Err(format!("not a directory: {}", dir.display()).into());
    }
    let mut entries: Vec<_> = std::fs::read_dir(dir)?.collect::<Result<_, _>>()?;
    // Sorted so a bundle is byte-stable across machines: readdir order is not
    // guaranteed, and an unstable bundle would show spurious diffs on every
    // rebuild and defeat review.
    entries.sort_by_key(std::fs::DirEntry::path);
    for e in entries {
        let p = e.path();
        if !p.is_file() {
            continue;
        }
        let ext = p.extension().and_then(|s| s.to_str()).unwrap_or_default();
        if ext != "yaml" && ext != "yml" {
            continue;
        }
        let text = std::fs::read_to_string(&p)?;
        let profile = ConsoleProfile::from_yaml(&text)
            .map_err(|err| format!("{}: {err}", p.display()))?;
        out.push(profile);
    }
    Ok(())
}
