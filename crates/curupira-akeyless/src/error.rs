//! One error type for the akeyless client, distinguishing the four things that
//! actually go wrong so a caller never has to string-match a message.

use thiserror::Error;

/// What went wrong talking to akeyless.
#[derive(Debug, Error)]
pub enum AkeylessError {
    /// The SDK's transport/HTTP/deserialize failure, kept as a string because the
    /// generated `Error<T>` is generic over each endpoint's error enum and does
    /// not unify — the message is what a human reads anyway.
    #[error("akeyless API call '{op}' failed: {detail}")]
    Api {
        /// The verb that failed, e.g. `auth` or `auth_method_create_api_key`.
        op: &'static str,
        /// The SDK's rendered error.
        detail: String,
    },

    /// Authentication returned no token — a valid response shape that still means
    /// "you are not authenticated", which must not be mistaken for success.
    #[error("authentication returned no token (access_id may be wrong, or the method is not an API key)")]
    NoToken,

    /// A required secret was not supplied through a non-argv channel. The access
    /// KEY is a secret: it is read from the environment or stdin, never a flag,
    /// so it cannot land in a shell history or a process listing.
    #[error("missing {what}: supply it via {how} (never a command-line flag — it would leak to `ps` and shell history)")]
    MissingSecret {
        /// The secret that was absent.
        what: &'static str,
        /// The sanctioned channel to supply it.
        how: &'static str,
    },
}

/// Result specialized to [`AkeylessError`].
pub type Result<T> = std::result::Result<T, AkeylessError>;
