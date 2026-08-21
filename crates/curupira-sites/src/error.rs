//! Typed errors. Every failure names what went wrong so a caller never has to
//! parse a screen or guess.
//!
//! Trimmed on migration: the CDP-transport variants (`Cdp`, `NoTargetPage`,
//! `WsResolve`, `Driver`) are gone because this crate no longer owns a browser
//! connection — curupira's TypeScript side does, and it has its own error
//! surface for that. What remains is the vocabulary of the pure compiler:
//! bad config, a refused mutation, and a command whose exit the caller chose to
//! treat as fatal.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum SitesError {
    /// A caller chose to treat a non-zero terminal exit as fatal. The exit code
    /// itself is a *value* (`CmdOut.exit`), not an error — this is only for the
    /// verb layer that decides otherwise.
    #[error("terminal command exited {exit}:\n{out}")]
    CommandFailed { exit: i64, out: String },

    /// An observe-only planner was asked to drive a control the profile
    /// classifies as mutating. Borrowed ground: mutations need an explicit
    /// operator grant, so this is a refusal, not a failure.
    #[error("refused: '{action}' is a MUTATING control ({describes}) — borrowed ground, use an explicit Authorization grant")]
    RefusedMutation { action: String, describes: String },

    /// Config or profile load / parse / validation.
    #[error("config: {0}")]
    Config(String),

    #[error(transparent)]
    Json(#[from] serde_json::Error),

    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, SitesError>;
