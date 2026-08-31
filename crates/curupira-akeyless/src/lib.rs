//! curupira-akeyless — a typed, borrowed-ground-gated client for the akeyless API.
//!
//! This is the RUNTIME sibling of curupira-sites. Where curupira-sites compiles a
//! web console into read-only MCP tools, this drives our akeyless tenant's API
//! directly through the generated [`akeyless_api`] SDK, so identities can be
//! created and endpoints exercised WITHOUT the browser and its reCAPTCHA-gated
//! web forms. The borrowed-ground gate ([`curupira_sites::Effect`] /
//! [`curupira_sites::Authorization`]) is reused, not re-defined: a create is a
//! mutation whether it is a console click or a `POST /auth-method`.
//!
//! ## Credentials never touch argv
//! The access KEY is a secret and is read from the environment or stdin, never a
//! command-line flag (a flag lands in `ps` output and shell history). The access
//! ID is an identifier and may be a flag. See [`error::AkeylessError::MissingSecret`].

pub mod client;
pub mod error;

pub use client::{AkeylessClient, Credential, NewIdentity, Session};
pub use error::{AkeylessError, Result};

// Re-export the shared gate so consumers get ONE Effect/Authorization, not a copy.
pub use curupira_sites::{Authorization, Effect};
