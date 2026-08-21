//! curupira-sites — the typed core that turns a console into tools.
//!
//! A web console is described as **data**: a [`profile::ConsoleProfile`] of
//! pages, the reads available on them, and the controls they expose. This crate
//! owns that model, plans actions against it, and *emits* the JavaScript a CDP
//! client evaluates in the page. It never opens a browser — curupira's
//! TypeScript server owns the connection, and this crate is an author-time
//! compiler with no runtime presence.
//!
//! # Why the split is this way
//!
//! Driving a browser needs a CDP client; curupira already has one, in
//! TypeScript, along with session and target management. Bringing a second one
//! along in Rust would have meant `chromiumoxide` + `tokio` + `rustls` + `ring`
//! — around 120 crates duplicating what already works. What is genuinely worth
//! owning in Rust is the *meaning*: which controls exist, what driving one does,
//! and what JavaScript expresses that safely. All of it is pure, string-in
//! string-out, and unit-testable without a browser.
//!
//! # The borrowed-ground gate
//!
//! Driving someone else's console is borrowed ground: reads are in-bounds,
//! mutations need an explicit operator grant every time. That rule is a **type**
//! here rather than a comment in a runbook — see [`profile`] for the two
//! planners and the honest statement of what the type does and does not prove.

pub mod emit;
pub mod error;
pub mod mapper;
pub mod profile;
pub mod terminal;
pub mod toolgen;

pub use error::{Result, SitesError};
pub use profile::{Authorization, ConsoleProfile, Effect};
pub use terminal::{CmdOut, DRIVER_JS, TerminalConfig};
pub use toolgen::{Bundle, SiteBundle, ToolSpec};
