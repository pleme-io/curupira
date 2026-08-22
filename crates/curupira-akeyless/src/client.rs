//! The gated akeyless client: typed verbs over the generated SDK, each carrying
//! its borrowed-ground [`Effect`] in its *signature*.
//!
//! The rule is the same one curupira-sites enforces on a web console, applied to
//! an API: an **Observe** verb (`authenticate`, `list_*`) is free to call; a
//! **Mutate** verb (`create_api_key_auth_method`) takes an [`Authorization`] by
//! value, so a state-changing call cannot be written without an operator grant at
//! the call site. akeyless is our own tenant, but "our own" is exactly where an
//! un-gated create is easiest to do by accident, so the type carries the rule.

use akeyless_api::apis::configuration::Configuration;
use akeyless_api::apis::v2_api;
use akeyless_api::models;
use curupira_sites::{Authorization, Effect};

use crate::error::{AkeylessError, Result};

/// A client bound to one akeyless API endpoint.
///
/// Holds no credential — a credential lives only inside a [`Session`], which is
/// obtained by [`AkeylessClient::authenticate`] and never logged.
pub struct AkeylessClient {
    config: Configuration,
}

/// An authenticated session: a short-lived token plus its expiry, if akeyless
/// returned one. The token is a bearer secret — `Debug` is deliberately NOT
/// derived so it cannot be printed into a log by reflex.
pub struct Session {
    token: String,
    /// akeyless's stated expiry, passed through verbatim for the caller to honor.
    pub expiration: Option<String>,
}

impl Session {
    /// The bearer token, exposed only to code that must place it in a request
    /// body. Callers must not log it.
    #[must_use]
    pub fn token(&self) -> &str {
        &self.token
    }
}

/// The identity created by [`AkeylessClient::create_api_key_auth_method`] — the
/// autonomous "account". `access_key` is a secret; print it once to hand it to
/// the operator, then materialize it through cofre, never a log.
pub struct NewIdentity {
    /// The auth-method name in akeyless.
    pub name: String,
    /// The access id (an identifier, not a secret).
    pub access_id: Option<String>,
    /// The access key (a SECRET — treat like a password).
    pub access_key: Option<String>,
}

impl AkeylessClient {
    /// Bind to an akeyless API endpoint, e.g.
    /// `https://api.akeyless.example`.
    #[must_use]
    pub fn new(base_url: &str) -> Self {
        let mut config = Configuration::new();
        config.base_path = base_url.trim_end_matches('/').to_string();
        Self { config }
    }

    /// The effect of each verb, for display/audit — mirrors the fn set below so a
    /// reader can see the gate without reading each body.
    #[must_use]
    pub fn effect_of(verb: &str) -> Option<Effect> {
        match verb {
            "authenticate" | "list-auth-methods" | "list-items" => Some(Effect::Observe),
            "create-api-key" => Some(Effect::Mutate),
            _ => None,
        }
    }

    /// **Observe.** Authenticate with an access-id + access-key and return a
    /// [`Session`]. This reads your own identity; it changes nothing.
    ///
    /// # Errors
    /// [`AkeylessError::Api`] on transport/auth failure, [`AkeylessError::NoToken`]
    /// if akeyless answers without a token.
    pub async fn authenticate(&self, access_id: &str, access_key: &str) -> Result<Session> {
        let mut body = models::Auth::new();
        body.access_id = Some(access_id.to_string());
        body.access_key = Some(access_key.to_string());
        body.access_type = Some("access_key".to_string());
        let out = v2_api::auth(&self.config, body)
            .await
            .map_err(|e| AkeylessError::Api { op: "auth", detail: e.to_string() })?;
        match out.token {
            Some(token) if !token.is_empty() => Ok(Session { token, expiration: out.expiration }),
            _ => Err(AkeylessError::NoToken),
        }
    }

    /// **Observe.** List the tenant's auth methods.
    ///
    /// # Errors
    /// [`AkeylessError::Api`] on failure.
    pub async fn list_auth_methods(&self, session: &Session) -> Result<models::ListAuthMethodsOutput> {
        let mut body = models::AuthMethodList::new();
        body.token = Some(session.token.clone());
        v2_api::auth_method_list(&self.config, body)
            .await
            .map_err(|e| AkeylessError::Api { op: "auth_method_list", detail: e.to_string() })
    }

    /// **Observe.** List the tenant's items (secrets, keys, targets) by path.
    ///
    /// # Errors
    /// [`AkeylessError::Api`] on failure.
    pub async fn list_items(&self, session: &Session) -> Result<models::ListItemsInPathOutput> {
        let mut body = models::ListItems::new();
        body.token = Some(session.token.clone());
        v2_api::list_items(&self.config, body)
            .await
            .map_err(|e| AkeylessError::Api { op: "list_items", detail: e.to_string() })
    }

    /// **Mutate.** Create an API-key auth method — the autonomous "account".
    ///
    /// The [`Authorization`] is required *by signature*: this call cannot be
    /// written without an operator grant recorded at the call site. akeyless is
    /// our tenant, but a create is still a mutation, so the gate holds here
    /// exactly as it does for a console button.
    ///
    /// # Errors
    /// [`AkeylessError::Api`] on failure.
    pub async fn create_api_key_auth_method(
        &self,
        session: &Session,
        name: &str,
        _auth: &Authorization,
    ) -> Result<NewIdentity> {
        let mut body = models::AuthMethodCreateApiKey::new(name.to_string());
        body.token = Some(session.token.clone());
        let out = v2_api::auth_method_create_api_key(&self.config, body)
            .await
            .map_err(|e| AkeylessError::Api { op: "auth_method_create_api_key", detail: e.to_string() })?;
        Ok(NewIdentity { name: name.to_string(), access_id: out.access_id, access_key: out.access_key })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effect_classification_matches_the_verb_set() {
        // The observe verbs are free; the create verb is the only mutation.
        assert_eq!(AkeylessClient::effect_of("authenticate"), Some(Effect::Observe));
        assert_eq!(AkeylessClient::effect_of("list-auth-methods"), Some(Effect::Observe));
        assert_eq!(AkeylessClient::effect_of("list-items"), Some(Effect::Observe));
        assert_eq!(AkeylessClient::effect_of("create-api-key"), Some(Effect::Mutate));
        assert_eq!(AkeylessClient::effect_of("nonsense"), None);
    }

    #[test]
    fn base_url_trailing_slash_is_normalized() {
        // A trailing slash on the base path double-slashes every request path,
        // which some gateways 404 — normalize it once at construction.
        let c = AkeylessClient::new("https://api-akeyless.example/");
        assert_eq!(c.config.base_path, "https://api-akeyless.example");
    }

    #[test]
    fn a_grant_is_required_by_type_to_name_a_mutation() {
        // This does not call the network; it proves the Authorization the mutating
        // verb demands is constructed from the operator's own words and carries
        // them, so an audit reads the authority rather than inferring it.
        let auth = Authorization::grant("akeyless.create-api-key:svc", "operator: create the svc account");
        assert_eq!(auth.granted_for(), "akeyless.create-api-key:svc");
    }
}
