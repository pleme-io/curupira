//! `curupira-akeyless` — drive our akeyless tenant's API from the command line.
//!
//! Reads-only by default; the one mutating verb (`create-api-key`) demands an
//! explicit `--grant "<what the operator said>"` so the borrowed-ground grant is
//! recorded in the invocation itself.
//!
//! ## Two identities, exactly one per invocation
//! Pass `--access-id` to authenticate as an API key, or `--admin-email` to
//! authenticate as an account password.
//!
//! Both accept an env fallback, and an operator commonly has one identity
//! exported for an unrelated endpoint — so resolution is by SOURCE, not by a
//! required ArgGroup: **a value typed on the command line beats one inherited
//! from the environment.** Only a genuine tie (both typed, or both merely
//! inherited) is refused. A required group instead made the exported value
//! collide with the flag just typed and refused to run.
//!
//! The SECRET half never appears in argv — it is read from
//! `AKEYLESS_ACCESS_KEY` or `AKEYLESS_ADMIN_PASSWORD` respectively, or from
//! stdin with `--secret-stdin` (aliased to the older `--access-key-stdin`). A
//! flag would land the secret in `ps` output and shell history.

use std::io::Read as _;

use clap::parser::ValueSource;
use clap::{CommandFactory as _, FromArgMatches as _, Parser, Subcommand};
use curupira_akeyless::{AkeylessClient, Authorization, Credential};

#[derive(Parser)]
#[command(name = "curupira-akeyless", about = "Typed, gated client for the akeyless API")]
struct Cli {
    /// akeyless API base URL, e.g. https://api.akeyless.example
    #[arg(long, env = "AKEYLESS_API_URL", hide_env_values = true)]
    url: String,

    /// Authenticate as an API key: the access id (an identifier, not a secret).
    /// Pair with --admin-email at most once; an explicit flag beats the env var.
    #[arg(long, env = "AKEYLESS_ACCESS_ID", hide_env_values = true)]
    access_id: Option<String>,

    /// Authenticate as an account password: the admin email (an identifier, not
    /// a secret). Takes precedence over an ENV-provided --access-id.
    /// Use this where the deployment issues only an email+password credential.
    #[arg(long, env = "AKEYLESS_ADMIN_EMAIL", hide_env_values = true)]
    admin_email: Option<String>,

    /// Read the secret from stdin instead of an env var. Applies to whichever
    /// identity was chosen: the access key, or the admin password.
    #[arg(long, alias = "access-key-stdin")]
    secret_stdin: bool,

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

/// Which identity an invocation resolved to.
#[derive(Debug, PartialEq, Eq)]
enum Identity {
    /// Authenticate as an API key.
    AccessKey,
    /// Authenticate as an account password.
    Password,
}

/// Decide WHICH identity an invocation means, from presence plus source alone.
///
/// Pure on purpose: no env reads, no I/O, so every case is testable without
/// depending on the shell the test ran in. An earlier version of the test suite
/// asserted parser behaviour directly and passed or failed based on whether
/// `AKEYLESS_ACCESS_ID` happened to be exported — this function is the fix for
/// that as much as for the UX trap.
///
/// The rule: EXPLICIT BEATS AMBIENT. A tie — both typed, or both merely
/// inherited — is the only ambiguity, and it is refused rather than guessed.
fn resolve_identity(
    have_access_id: bool,
    have_admin_email: bool,
    access_id_explicit: bool,
    admin_email_explicit: bool,
) -> Result<Identity, String> {
    match (have_access_id, have_admin_email) {
        (true, true) => {
            if access_id_explicit == admin_email_explicit {
                Err("both --access-id and --admin-email resolved; pass exactly one \
                     (an exported AKEYLESS_ACCESS_ID / AKEYLESS_ADMIN_EMAIL counts)"
                    .into())
            } else if access_id_explicit {
                Ok(Identity::AccessKey)
            } else {
                Ok(Identity::Password)
            }
        }
        (true, false) => Ok(Identity::AccessKey),
        (false, true) => Ok(Identity::Password),
        (false, false) => {
            Err("pass --access-id (API key) or --admin-email (account password)".into())
        }
    }
}

/// Build the [`Credential`] from the resolved identity plus its secret.
///
/// The secret half is read from an env var or stdin, NEVER a flag — a flag lands
/// in `ps` output and shell history. Which env var applies follows from which
/// identity was resolved, so there is one rule rather than two.
fn build_credential(cli: &Cli, m: &clap::ArgMatches) -> Result<Credential, String> {
    let read_secret = |env_key: &str, what: &str| -> Result<String, String> {
        if cli.secret_stdin {
            let mut s = String::new();
            std::io::stdin().read_to_string(&mut s).map_err(|e| e.to_string())?;
            let s = s.trim().to_string();
            if s.is_empty() {
                return Err(format!("stdin was empty; expected the {what}"));
            }
            Ok(s)
        } else {
            std::env::var(env_key)
                .map_err(|_| format!("set {env_key}, or pass --secret-stdin (never a flag)"))
        }
    };

    let explicit = |name: &str| m.value_source(name) == Some(ValueSource::CommandLine);
    let identity = resolve_identity(
        cli.access_id.is_some(),
        cli.admin_email.is_some(),
        explicit("access_id"),
        explicit("admin_email"),
    )?;

    match identity {
        Identity::AccessKey => Ok(Credential::AccessKey {
            access_id: cli.access_id.clone().expect("resolver proved it present"),
            access_key: read_secret("AKEYLESS_ACCESS_KEY", "access key")?,
        }),
        Identity::Password => Ok(Credential::Password {
            admin_email: cli.admin_email.clone().expect("resolver proved it present"),
            admin_password: read_secret("AKEYLESS_ADMIN_PASSWORD", "admin password")?,
        }),
    }
}

#[tokio::main]
async fn main() -> std::process::ExitCode {
    let matches = Cli::command().get_matches();
    let cli = match Cli::from_arg_matches(&matches) {
        Ok(c) => c,
        Err(e) => { eprintln!("{e}"); return std::process::ExitCode::FAILURE; }
    };
    match run(cli, &matches).await {
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

async fn run(cli: Cli, matches: &clap::ArgMatches) -> Result<String, String> {
    let credential = build_credential(&cli, matches)?;
    let client = AkeylessClient::new(&cli.url);
    let session = client
        .authenticate_with(&credential)
        .await
        .map_err(|e| e.to_string())?;
    // `principal()` is the non-secret half by construction — there is no
    // accessor that would let this line print the secret one.
    let principal = credential.principal().to_string();
    let access_type = credential.access_type();

    match cli.cmd {
        Cmd::Whoami => Ok(format!(
            "authenticated as {principal} (access_type: {access_type}) — token expires: {}",
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

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory as _;

    /// Every combination of (present, explicit) for the two identities, checked
    /// against the pure resolver so the result cannot depend on the ambient
    /// environment.
    ///
    /// This replaced a parser-level test that asserted "omitting both identities
    /// is an error" and "exactly one parses". BOTH assertions failed on a machine
    /// with `AKEYLESS_ACCESS_ID` exported — clap's env fallback satisfied the
    /// first, and made the second look like a conflict. That was a flaky test
    /// AND a real usability trap; the resolver fixes the trap and this table
    /// fixes the flakiness.
    #[test]
    fn identity_resolution_prefers_explicit_over_ambient() {
        use Identity::{AccessKey, Password};
        // (have_id, have_email, id_explicit, email_explicit) -> expected
        let cases: &[(bool, bool, bool, bool, Result<Identity, ()>)] = &[
            // nothing at all
            (false, false, false, false, Err(())),
            // exactly one, from either source
            (true, false, true, false, Ok(AccessKey)),
            (true, false, false, false, Ok(AccessKey)),   // from env
            (false, true, false, true, Ok(Password)),
            (false, true, false, false, Ok(Password)),    // from env
            // THE CASE THAT MATTERS: an env access-id must not beat a typed email
            (true, true, false, true, Ok(Password)),
            // and symmetrically
            (true, true, true, false, Ok(AccessKey)),
            // genuine ties are refused, not guessed
            (true, true, true, true, Err(())),            // both typed
            (true, true, false, false, Err(())),          // both inherited
        ];
        for &(hid, hem, xid, xem, ref want) in cases {
            let got = resolve_identity(hid, hem, xid, xem);
            match (want, &got) {
                (Ok(w), Ok(g)) => assert_eq!(w, g, "case {hid},{hem},{xid},{xem}"),
                (Err(()), Err(_)) => {}
                _ => panic!("case {hid},{hem},{xid},{xem}: wanted {want:?}, got {got:?}"),
            }
        }
    }

    /// The secret must not be expressible as a flag — that is the whole reason
    /// it is read from env/stdin. If someone adds `--access-key` or
    /// `--admin-password` later, this fails and they have to justify it.
    #[test]
    fn the_secret_has_no_command_line_flag() {
        let cmd = Cli::command();
        for forbidden in ["--access-key", "--admin-password", "--password", "--secret"] {
            let r = cmd.clone().try_get_matches_from(vec![
                "curupira-akeyless", "--url", "https://api.example",
                "--access-id", "p-1", forbidden, "hunter2", "whoami",
            ]);
            assert!(
                r.is_err(),
                "{forbidden} must NOT be an accepted flag — a secret in argv lands in ps and shell history"
            );
        }
    }

    /// `--access-key-stdin` was the original spelling; keeping it as an alias
    /// means the rename to `--secret-stdin` does not break an existing caller.
    #[test]
    fn the_old_stdin_flag_still_parses_as_an_alias() {
        let m = Cli::command().try_get_matches_from(vec![
            "curupira-akeyless", "--url", "https://api.example",
            "--access-id", "p-1", "--access-key-stdin", "whoami",
        ]);
        assert!(m.is_ok(), "--access-key-stdin must remain accepted as an alias");
    }
}
