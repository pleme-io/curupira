//! The embedded-terminal surface: the page payload and the commands sent through it.
//!
//! Some consoles expose a terminal (xterm over a WebSocket) as one of their
//! affordances. Driving it is a different problem from clicking a button — the
//! page owns a socket, the socket drops on idle, and output arrives as binary
//! frames with no framing of its own. [`DRIVER_JS`] is the payload that solves
//! that inside the page; this module owns it and the commands that go through it.
//!
//! Everything here is pure: strings in, strings out. The payload is *emitted*,
//! never executed — evaluating it is curupira's TypeScript CDP client's job.

use std::fmt::Write as _;

use serde::{Deserialize, Serialize};

use crate::error::Result;

/// The canonical driver payload, single-sourced from `driver.js` and compiled
/// in, so there is no runtime file dependency.
///
/// It installs `window.WT` and is idempotent — it no-ops if its own version is
/// already present, which matters because a stateless tool call re-sends it on
/// every invocation. Session state lives in the *page* (`window.WT.sock`), not
/// in any process here.
pub const DRIVER_JS: &str = include_str!("../driver.js");

/// A terminal command's structured result.
///
/// A non-zero `exit` is a **value**, not an error — the caller decides whether
/// it is fatal. Conflating the two is how a legitimate `kubectl` "not found"
/// becomes an exception that hides the actual output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CmdOut {
    pub exit: i64,
    pub out: String,
}

/// Site-specific knobs the payload reads. Injected as `window.__CURUPIRA_SITES`
/// before the payload runs, never baked into the JS — the payload is generic and
/// the site supplies the readiness banner, the connect control and the cadence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct TerminalConfig {
    /// Regex the terminal's first frames must match before `connect` resolves —
    /// the site's readiness banner. Empty means "ready as soon as the socket
    /// opens", which is permitted and weak.
    pub ready_banner_match: String,

    /// Case-insensitive match against on-page button text to find the connect
    /// control.
    pub connect_button_match: String,

    /// Resize-heartbeat cadence in milliseconds, which is what keeps the socket
    /// alive against the backend's idle close. Traffic is the only thing that
    /// defeats an idle timeout; a timer that merely waits does not.
    pub heartbeat_ms: u64,
}

impl Default for TerminalConfig {
    fn default() -> Self {
        Self {
            ready_banner_match: String::new(),
            connect_button_match: "Connect".to_string(),
            heartbeat_ms: 8_000,
        }
    }
}

/// The single global the prelude writes and [`DRIVER_JS`] reads.
///
/// It is a named constant because the two halves live in different LANGUAGES
/// and nothing else binds them. Measured 2026-08-21: the migration renamed the
/// Rust side to `__CURUPIRA_SITES` while `driver.js` kept reading `__ROJI`, and
/// **every test still passed** — because each side was internally consistent.
///
/// The failure that would have caused is worth stating, since it is silent in
/// exactly the wrong direction: with the config never arriving, the payload
/// falls back to its defaults, so `connect` resolves on socket-open instead of
/// on the site's readiness banner. A half-open socket then reads as ready, and
/// the heartbeat that defeats the backend's ~13s idle close reverts to a value
/// nobody chose. Nothing errors; the terminal just behaves subtly wrong.
///
/// `prelude_and_payload_agree_on_the_config_global` now asserts both sides
/// against this constant, so the *class* is caught rather than this instance.
pub const CONFIG_GLOBAL: &str = "__CURUPIRA_SITES";

/// Render the prelude that parameterizes the payload for one site.
///
/// Every value goes through `serde_json::to_string` rather than being
/// interpolated — the same rule as [`crate::emit`], and for the same reason: a
/// banner regex or button label is operator-authored text that may contain
/// quotes or backslashes.
pub fn emit_config_prelude(cfg: &TerminalConfig) -> Result<String> {
    Ok(format!(
        "window.{CONFIG_GLOBAL} = {{ driver: {{ readyBanner: {}, connectButton: {}, heartbeatMs: {} }} }};",
        serde_json::to_string(&cfg.ready_banner_match)?,
        serde_json::to_string(&cfg.connect_button_match)?,
        cfg.heartbeat_ms,
    ))
}

/// `kubectl -n <ns> get <resource> -o <output>`.
#[must_use]
pub fn get_cmd(ns: &str, resource: &str, output: &str) -> String {
    format!("kubectl -n {ns} get {resource} -o {output}")
}

/// `kubectl -n <ns> logs <workload> [--since=…] [--tail=…]`.
#[must_use]
pub fn logs_cmd(ns: &str, workload: &str, since: Option<&str>, tail: Option<u32>) -> String {
    let mut c = format!("kubectl -n {ns} logs {workload}");
    if let Some(s) = since {
        let _ = write!(c, " --since={s}");
    }
    if let Some(t) = tail {
        let _ = write!(c, " --tail={t}");
    }
    c
}

/// The identity/liveness probe — proves the tab, the payload and the service
/// account in one round-trip.
#[must_use]
pub fn whoami_cmd() -> String {
    "kubectl auth whoami 2>&1 | grep -i Username || id -un".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_builds_o_yaml() {
        assert_eq!(
            get_cmd("default", "deploy/app", "yaml"),
            "kubectl -n default get deploy/app -o yaml"
        );
    }

    #[test]
    fn logs_appends_only_given_flags() {
        assert_eq!(logs_cmd("default", "deploy/x", None, None), "kubectl -n default logs deploy/x");
        assert_eq!(
            logs_cmd("default", "deploy/x", Some("10m"), Some(100)),
            "kubectl -n default logs deploy/x --since=10m --tail=100"
        );
    }

    #[test]
    fn driver_payload_is_compiled_in_and_self_installing() {
        assert!(DRIVER_JS.contains("DRIVER_VERSION"), "payload must carry its version");
        assert!(!DRIVER_JS.is_empty());
    }

    #[test]
    fn prelude_and_payload_agree_on_the_config_global() {
        // The regression this pins, found 2026-08-21 by recon rather than by a
        // test: the Rust side wrote `window.__CURUPIRA_SITES` while driver.js
        // still read `window.__ROJI`. Both files were internally consistent, so
        // nothing failed — the config simply never arrived and the payload used
        // its defaults, which reads as "connected" on a half-open socket.
        //
        // Asserting BOTH sides against one constant is what makes this a class
        // check rather than a spot fix: renaming the global in either language
        // alone now fails here.
        let prelude = emit_config_prelude(&TerminalConfig::default()).unwrap();
        assert!(
            prelude.contains(CONFIG_GLOBAL),
            "the prelude must write the shared global, got: {prelude}"
        );
        assert!(
            DRIVER_JS.contains(CONFIG_GLOBAL),
            "driver.js must READ the same global the prelude writes ({CONFIG_GLOBAL}) — \
             a mismatch is silent: the payload falls back to defaults and a half-open \
             socket reads as ready"
        );
        assert!(
            !DRIVER_JS.contains("__ROJI"),
            "driver.js still references the pre-migration global"
        );
    }

    #[test]
    fn prelude_injects_the_three_site_fields() {
        let js = emit_config_prelude(&TerminalConfig::default()).unwrap();
        assert!(js.contains("readyBanner"));
        assert!(js.contains("connectButton"));
        assert!(js.contains("heartbeatMs"));
    }

    #[test]
    fn prelude_escapes_operator_authored_values() {
        // A banner regex containing a quote must not terminate the JS string.
        let cfg = TerminalConfig {
            ready_banner_match: r#"say "hi""#.to_string(),
            ..TerminalConfig::default()
        };
        let js = emit_config_prelude(&cfg).unwrap();
        assert!(js.contains(r#"\"hi\""#), "value must be escaped: {js}");
    }

    #[test]
    fn default_names_no_site() {
        let d = TerminalConfig::default();
        assert!(d.ready_banner_match.is_empty());
        assert_eq!(d.connect_button_match, "Connect");
    }
}
