//! Typed navigation over a foreign web console.
//!
//! roji's terminal surface drives ONE affordance — the embedded xterm. This
//! module generalises the same discipline to the rest of a console: its pages,
//! the data on them, and the controls they expose. A console is described as
//! DATA (a [`ConsoleProfile`]), and the engine here is generic — exactly the
//! split that keeps a specific platform's routes and selectors out of this
//! repository and in an operator's private profile.
//!
//! # Why a profile instead of code
//!
//! A page-object written in Rust bakes a vendor's DOM into a public binary and
//! forces a release for every UI change. A profile is config: a new page is a
//! YAML entry, a moved selector is a one-line edit, and the published engine
//! names no host. The generic defaults here point at `example.invalid`, the
//! reserved-invalid domain, for the same reason [`crate::config`] does.
//!
//! # The borrowed-ground gate is a TYPE, not a comment
//!
//! Driving someone else's console is borrowed ground: reads are in-bounds,
//! mutations need an explicit operator grant every time. That rule is normally
//! prose in a runbook, which means it is enforced by whoever remembers it.
//!
//! Here it is the API's shape. An [`Action`] carries an [`Effect`], and there
//! are two planners:
//!
//! - [`plan_observe`] accepts only [`Effect::Observe`] and takes no grant.
//! - [`plan_mutate`] requires an [`Authorization`] by signature.
//!
//! So "mutate without a grant" has **no call path** — it is not a branch that
//! returns an error, it is a function that cannot be called. A caller that tries
//! to drive a mutating control through [`plan_observe`] gets
//! [`SitesError::RefusedMutation`] naming the action.
//!
//! **Tier-honest:** this is *API-level rejection*, not unrepresentability. An
//! [`Authorization`] is constructible by any caller via [`Authorization::grant`];
//! the type does not prove a human spoke. What it removes is the *accidental*
//! mutation — the path where an observe-shaped call quietly clicks a destructive
//! control — and it makes every deliberate one appear in a diff as the word
//! `grant`, which is greppable in review. Do not round this up.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::error::{Result, SitesError};

/// Whether driving a control only reads the console or changes the host's state.
///
/// There is deliberately no `Unknown` arm. An unclassified control would be
/// treated as one or the other by default, and either default is wrong: assume
/// observe and we mutate borrowed ground by accident, assume mutate and every
/// read needs a grant until someone reclassifies it. A profile author must
/// decide, and the decision is visible in the profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Effect {
    /// Reads only. Free to drive on borrowed ground.
    Observe,
    /// Changes state on the host's system. Requires an [`Authorization`].
    Mutate,
}

/// An explicit operator grant to perform one mutating action.
///
/// Constructed only through [`Authorization::grant`], whose argument is the
/// operator's own words. It is carried by value into [`plan_mutate`] so a
/// mutating plan cannot be built without one being written at the call site.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Authorization {
    granted_for: String,
    note: String,
}

impl Authorization {
    /// Record an operator's go-ahead for `action_name`.
    ///
    /// `note` is what the operator actually said, kept so a later reader of a
    /// log or a diff can see the authority rather than infer it.
    #[must_use]
    pub fn grant(action_name: impl Into<String>, note: impl Into<String>) -> Self {
        Self { granted_for: action_name.into(), note: note.into() }
    }

    /// The action this grant was issued for.
    #[must_use]
    pub fn granted_for(&self) -> &str {
        &self.granted_for
    }

    /// The operator's words.
    #[must_use]
    pub fn note(&self) -> &str {
        &self.note
    }
}

/// How an element is located on the page.
///
/// `ButtonText` exists because console controls are frequently unlabelled in the
/// DOM and identified only by their visible text, and because a text match
/// survives a CSS-module class rename that a selector does not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Locator {
    /// A CSS selector, used verbatim.
    Selector(String),
    /// Case-insensitive match against a button's trimmed text content.
    ButtonText(String),
    /// Case-insensitive match against the START of a button's text.
    ///
    /// Consoles put live data in control labels. Measured on a real console
    /// 2026-08-21: 11 of 89 controls were labelled `Pods · 179`,
    /// `Deployments · 75`, `ConfigMaps · 188` and so on — an exact text match
    /// on any of them breaks the moment the count changes, and breaks
    /// *silently*, as "control not found".
    ///
    /// The stable part is the prefix, so this matches on it. Deliberately not a
    /// regex: an unanchored pattern that matches the wrong control is how an
    /// automation clicks something nobody intended, and on borrowed ground that
    /// is the failure mode with no undo.
    ButtonTextPrefix(String),
}

/// What a named read extracts from the page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReadKind {
    /// `textContent` of the first match, trimmed.
    Text,
    /// Every match's trimmed `textContent`, in document order.
    TextAll,
    /// A `<table>` (or ARIA grid) as rows of cell strings.
    Table,
    /// How many elements match. Cheap existence/count probe.
    Count,
    /// One attribute of the first match.
    Attribute(String),
}

/// Evidence that a page finished loading.
///
/// A console is a single-page app: the URL changes before the content does, so
/// a route match alone proves nothing. A profile should name a signal that is
/// only true once the page's own data has rendered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReadySignal {
    /// The address bar contains this substring.
    UrlContains(String),
    /// At least one element matches this selector.
    SelectorPresent(String),
    /// This text appears anywhere in the rendered body.
    TextPresent(String),
}

/// A named extraction available on a page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Read {
    /// Profile-local name, used as `page.read`.
    pub name: String,
    /// Where to look.
    pub locator: Locator,
    /// What to take.
    pub kind: ReadKind,
}

/// A named control on a page, classified by what driving it does.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Action {
    /// Profile-local name, used as `page.action`.
    pub name: String,
    /// Where to click.
    pub locator: Locator,
    /// Read vs write. See [`Effect`].
    pub effect: Effect,
    /// Operator-facing description of what this does, shown when a grant is
    /// required so the person granting knows what they are approving.
    #[serde(default)]
    pub describes: String,
}

/// One page of a console.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Page {
    /// Profile-local name.
    pub name: String,
    /// Route relative to [`ConsoleProfile::base_url`]. May contain `{param}`
    /// placeholders resolved by [`Page::render_route`].
    pub route: String,
    /// An in-page tab to activate after navigating, matched by visible text.
    #[serde(default)]
    pub tab: Option<String>,
    /// What proves the page is loaded. Empty means "navigation alone" — allowed
    /// but weak; a profile should normally name at least one.
    #[serde(default)]
    pub ready: Vec<ReadySignal>,
    #[serde(default)]
    pub reads: Vec<Read>,
    #[serde(default)]
    pub actions: Vec<Action>,
}

impl Page {
    /// Substitute `{param}` placeholders in the route.
    ///
    /// An unresolved placeholder is an **error**, never an empty string: a
    /// console route with a hole in it navigates somewhere real and wrong
    /// (`/clusters//terminal` is a 404 at best and another tenant's page at
    /// worst), and the failure would surface as a confusing ready-signal
    /// timeout rather than as the missing parameter it is.
    pub fn render_route(&self, params: &BTreeMap<String, String>) -> Result<String> {
        let mut out = self.route.clone();
        for (k, v) in params {
            out = out.replace(&format!("{{{k}}}"), v);
        }
        if let Some(missing) = first_placeholder(&out) {
            return Err(SitesError::Config(format!(
                "page '{}': route '{}' still has unresolved placeholder '{{{missing}}}' — \
                 pass it with --param {missing}=<value>",
                self.name, self.route
            )));
        }
        Ok(out)
    }

    /// Look up a named read.
    #[must_use]
    pub fn read(&self, name: &str) -> Option<&Read> {
        self.reads.iter().find(|r| r.name == name)
    }

    /// Look up a named action.
    #[must_use]
    pub fn action(&self, name: &str) -> Option<&Action> {
        self.actions.iter().find(|a| a.name == name)
    }
}

/// A whole console, as data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ConsoleProfile {
    /// Stable identifier for this console. Namespaces every tool this profile
    /// generates, because the MCP tool registry is a single flat map in which a
    /// duplicate name silently overwrites rather than erroring — so two profiles
    /// that both call a page `cluster` must not both emit `cluster_pods`.
    pub id: String,

    /// Origin of the console, e.g. `https://platform.example.invalid`.
    pub base_url: String,

    /// Substrings that identify this console in a tab's URL. This is what makes
    /// curupira *context-aware*: the active tab's URL is matched against every
    /// loaded profile's patterns to decide which one is live.
    ///
    /// Substring rather than glob or regex, deliberately. A host match is the
    /// only thing that needs to be true, the URLs are operator-authored, and a
    /// regex here would be a silent foot-gun — an unanchored pattern matching
    /// the wrong console is the kind of error that only shows up as an action
    /// driven against the wrong host.
    ///
    /// Empty means the profile matches nothing and is loadable but never
    /// auto-selected — useful for a draft the mapper produced and nobody has
    /// reviewed yet.
    #[serde(default, rename = "match")]
    pub match_urls: Vec<String>,

    pub pages: Vec<Page>,

    /// Settings for a console that embeds a terminal, if it has one.
    ///
    /// `None` means "this console has no terminal", which is different from
    /// "it has one with default settings" — and the distinction is load-bearing.
    /// The defaults resolve `connect` on socket-open rather than on a readiness
    /// banner, which is exactly the half-open-socket-reads-as-ready failure
    /// [`crate::terminal::CONFIG_GLOBAL`] documents. A console that really has a
    /// terminal should say so and name its banner.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal: Option<crate::terminal::TerminalConfig>,
}

impl Default for ConsoleProfile {
    fn default() -> Self {
        Self {
            id: "example".to_string(),
            base_url: "https://platform.example.invalid".to_string(),
            match_urls: Vec::new(),
            pages: Vec::new(),
            terminal: None,
        }
    }
}

impl ConsoleProfile {
    /// Parse a profile from YAML.
    pub fn from_yaml(text: &str) -> Result<Self> {
        let p: Self = serde_yaml::from_str(text)
            .map_err(|e| SitesError::Config(format!("console profile: {e}")))?;
        p.validate()?;
        Ok(p)
    }

    /// Look up a page by name.
    #[must_use]
    pub fn page(&self, name: &str) -> Option<&Page> {
        self.pages.iter().find(|p| p.name == name)
    }

    /// Reject a profile that cannot be driven unambiguously.
    ///
    /// Duplicate names are the interesting case: `page.read` is the address of a
    /// read, so two reads sharing a name means one is unreachable, and which one
    /// wins depends on vector order — a silent, order-dependent wrong answer
    /// rather than a failure.
    pub fn validate(&self) -> Result<()> {
        if self.id.trim().is_empty() {
            return Err(SitesError::Config(
                "profile has no 'id' — it namespaces every generated tool, and without it two \
                 profiles sharing a page name would silently overwrite each other's tools"
                    .to_string(),
            ));
        }
        if !self.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err(SitesError::Config(format!(
                "profile id '{}' must be ASCII alphanumeric, '-' or '_' — it becomes part of an \
                 MCP tool name",
                self.id
            )));
        }
        dup_check("page", self.pages.iter().map(|p| p.name.as_str()))?;
        for p in &self.pages {
            dup_check(&format!("read on page '{}'", p.name), p.reads.iter().map(|r| r.name.as_str()))?;
            dup_check(
                &format!("action on page '{}'", p.name),
                p.actions.iter().map(|a| a.name.as_str()),
            )?;
        }
        Ok(())
    }

    /// Authoring problems that are not hard errors but are almost always bugs.
    ///
    /// Kept separate from [`Self::validate`] on purpose: these describe a
    /// profile that will *load and run* and then quietly do the wrong thing,
    /// which is a different failure from one that cannot be represented.
    ///
    /// The rule that earned this, measured in fixture Round F2 (2026-08-21): a
    /// page whose only ready signals are URL-based, but which declares reads.
    /// A `url-contains` signal is true the instant the address bar changes —
    /// **before any content exists** — so on a single-page console the waiter
    /// returns `ready` in 0ms and the reads run against the previous page's
    /// DOM. Measured exactly that: `ready:true, waitedMs:0` while the heading
    /// still said "loading…" and both data reads came back `absent`.
    ///
    /// A URL signal is therefore never sufficient ALONE for a page that reads
    /// data; it needs at least one DOM-based signal that is only true once the
    /// page's own content has rendered.
    #[must_use]
    pub fn lints(&self) -> Vec<String> {
        let mut out = Vec::new();
        for p in &self.pages {
            if p.reads.is_empty() {
                continue;
            }
            let has_dom_signal = p
                .ready
                .iter()
                .any(|s| !matches!(s, ReadySignal::UrlContains(_)));
            if !has_dom_signal {
                out.push(format!(
                    "page '{}' declares {} read(s) but has no DOM-based ready signal{} — a \
                     url-contains signal is true before any content renders, so reads will run \
                     against the previous page. Add a selector-present or text-present signal.",
                    p.name,
                    p.reads.len(),
                    if p.ready.is_empty() { " at all" } else { " (only url-contains)" }
                ));
            }
        }
        out
    }

    /// Whether this profile claims the given tab URL.
    ///
    /// A profile with no patterns matches nothing — never everything. Treating
    /// "unspecified" as "matches all" would make an unreviewed draft profile
    /// silently claim every tab, which is the wrong direction to fail on
    /// borrowed ground.
    #[must_use]
    pub fn matches_url(&self, url: &str) -> bool {
        self.match_urls.iter().any(|m| !m.is_empty() && url.contains(m.as_str()))
    }

    /// Every mutating action in the profile, as `page.action`.
    ///
    /// The review surface: what this profile *could* change on the host if
    /// granted. A profile whose mutating set is empty is read-only by
    /// construction, and that is worth being able to state.
    #[must_use]
    pub fn mutating_actions(&self) -> Vec<String> {
        let mut out = Vec::new();
        for p in &self.pages {
            for a in &p.actions {
                if a.effect == Effect::Mutate {
                    out.push(format!("{}.{}", p.name, a.name));
                }
            }
        }
        out
    }
}

/// A resolved, ready-to-drive step. Produced by the planners; consumed by the
/// CDP layer. Pure data, so planning is unit-testable without a browser.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NavPlan {
    /// Absolute URL to navigate to.
    pub url: String,
    /// In-page tab to activate after load.
    pub tab: Option<String>,
    /// Conditions to wait on before the page counts as ready.
    pub ready: Vec<ReadySignal>,
}

/// A planned click.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionPlan {
    pub page: String,
    pub action: String,
    pub locator: Locator,
    pub effect: Effect,
    /// Present only for [`Effect::Mutate`]; carries the operator's words so the
    /// grant travels with the plan into logs rather than being lost at the call
    /// site.
    pub authorized_by: Option<String>,
}

/// Plan navigation to a page.
pub fn plan_nav(
    profile: &ConsoleProfile,
    page: &str,
    params: &BTreeMap<String, String>,
) -> Result<NavPlan> {
    let p = profile
        .page(page)
        .ok_or_else(|| SitesError::Config(format!("no page '{page}' in profile")))?;
    let route = p.render_route(params)?;
    Ok(NavPlan {
        url: join_url(&profile.base_url, &route),
        tab: p.tab.clone(),
        ready: p.ready.clone(),
    })
}

/// Plan a **non-mutating** action. Takes no grant, and refuses anything
/// classified [`Effect::Mutate`].
pub fn plan_observe(profile: &ConsoleProfile, page: &str, action: &str) -> Result<ActionPlan> {
    let (p, a) = lookup(profile, page, action)?;
    if a.effect == Effect::Mutate {
        return Err(SitesError::RefusedMutation {
            action: format!("{page}.{action}"),
            describes: a.describes.clone(),
        });
    }
    Ok(ActionPlan {
        page: p.name.clone(),
        action: a.name.clone(),
        locator: a.locator.clone(),
        effect: a.effect,
        authorized_by: None,
    })
}

/// Plan a **mutating** action. The [`Authorization`] is required by signature,
/// which is the whole point: there is no way to reach this without writing a
/// grant at the call site.
///
/// The grant must name this action. A grant for one control does not authorize
/// another — that is how one approval silently becomes a general licence.
pub fn plan_mutate(
    profile: &ConsoleProfile,
    page: &str,
    action: &str,
    auth: &Authorization,
) -> Result<ActionPlan> {
    let (p, a) = lookup(profile, page, action)?;
    let addr = format!("{page}.{action}");
    if auth.granted_for() != addr {
        return Err(SitesError::Config(format!(
            "authorization names '{}' but the action is '{addr}' — a grant authorizes one action",
            auth.granted_for()
        )));
    }
    Ok(ActionPlan {
        page: p.name.clone(),
        action: a.name.clone(),
        locator: a.locator.clone(),
        effect: a.effect,
        authorized_by: Some(auth.note().to_string()),
    })
}

fn lookup<'a>(
    profile: &'a ConsoleProfile,
    page: &str,
    action: &str,
) -> Result<(&'a Page, &'a Action)> {
    let p = profile
        .page(page)
        .ok_or_else(|| SitesError::Config(format!("no page '{page}' in profile")))?;
    let a = p
        .action(action)
        .ok_or_else(|| SitesError::Config(format!("no action '{action}' on page '{page}'")))?;
    Ok((p, a))
}

fn dup_check<'a>(what: &str, names: impl Iterator<Item = &'a str>) -> Result<()> {
    let mut seen = std::collections::BTreeSet::new();
    for n in names {
        if !seen.insert(n) {
            return Err(SitesError::Config(format!("duplicate {what}: '{n}'")));
        }
    }
    Ok(())
}

fn first_placeholder(s: &str) -> Option<&str> {
    let start = s.find('{')?;
    let rest = &s[start + 1..];
    let end = rest.find('}')?;
    Some(&rest[..end])
}

fn join_url(base: &str, route: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), route.trim_start_matches('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(kv: &[(&str, &str)]) -> BTreeMap<String, String> {
        kv.iter().map(|(k, v)| ((*k).to_string(), (*v).to_string())).collect()
    }

    fn profile() -> ConsoleProfile {
        ConsoleProfile::from_yaml(
            r#"
base_url: https://platform.example.invalid
pages:
  - name: cluster
    route: /clusters/{cluster_id}
    tab: Terminal
    ready:
      - !selector-present ".xterm"
    reads:
      - name: title
        locator: !selector "h1"
        kind: !text
      - name: pods
        locator: !selector "table.pods"
        kind: !table
    actions:
      - name: refresh
        locator: !button-text "Refresh"
        effect: observe
      - name: delete-cluster
        locator: !button-text "Delete"
        effect: mutate
        describes: permanently destroys the cluster
"#,
        )
        .expect("fixture profile parses")
    }

    #[test]
    fn url_only_ready_signals_on_a_reading_page_are_linted() {
        // Measured in fixture Round F2: waiter returned ready in 0ms while the
        // page still said "loading…" and every data read came back absent.
        let p = ConsoleProfile::from_yaml(
            r##"
id: l
base_url: https://x.example.invalid
pages:
  - name: p
    route: /p
    ready:
      - !url-contains "/p"
    reads:
      - name: r
        locator: !selector "#r"
        kind: !text
"##,
        )
        .unwrap();
        let l = p.lints();
        assert_eq!(l.len(), 1, "{l:?}");
        assert!(l[0].contains("no DOM-based ready signal"), "{}", l[0]);
    }

    #[test]
    fn a_dom_ready_signal_clears_the_lint() {
        let p = ConsoleProfile::from_yaml(
            r##"
id: l
base_url: https://x.example.invalid
pages:
  - name: p
    route: /p
    ready:
      - !url-contains "/p"
      - !selector-present "#r"
    reads:
      - name: r
        locator: !selector "#r"
        kind: !text
"##,
        )
        .unwrap();
        assert!(p.lints().is_empty());
    }

    #[test]
    fn a_page_with_no_reads_is_not_linted() {
        // Nothing to read means nothing to read too early.
        let p = ConsoleProfile::from_yaml(
            "id: l\nbase_url: https://x.example.invalid\npages:\n  - name: p\n    route: /p\n",
        )
        .unwrap();
        assert!(p.lints().is_empty());
    }

    #[test]
    fn a_console_without_a_terminal_says_so_rather_than_defaulting() {
        // None != "has one with defaults". The defaults resolve connect on
        // socket-open instead of on a readiness banner, so silently defaulting
        // would hand a half-open socket to a caller as "ready".
        let p = ConsoleProfile::default();
        assert!(p.terminal.is_none());
    }

    #[test]
    fn a_terminal_block_round_trips_through_yaml() {
        let y = r#"
id: withterm
base_url: https://platform.example.invalid
terminal:
  ready_banner_match: "Example Terminal"
  connect_button_match: "Connect"
  heartbeat_ms: 8000
pages: []
"#;
        let p = ConsoleProfile::from_yaml(y).unwrap();
        let t = p.terminal.expect("terminal block parses");
        assert_eq!(t.ready_banner_match, "Example Terminal");
        assert_eq!(t.heartbeat_ms, 8000);
    }

    #[test]
    fn defaults_name_no_host() {
        // Same discipline as RojiConfig: the shipped default points at the
        // reserved-invalid domain, so a misconfigured run cannot reach a real
        // console belonging to anyone.
        let d = ConsoleProfile::default();
        assert!(d.base_url.contains("example.invalid"));
        assert!(d.pages.is_empty());
    }

    #[test]
    fn route_placeholders_are_substituted() {
        let p = profile();
        let plan = plan_nav(&p, "cluster", &params(&[("cluster_id", "69")])).unwrap();
        assert_eq!(plan.url, "https://platform.example.invalid/clusters/69");
        assert_eq!(plan.tab.as_deref(), Some("Terminal"));
    }

    #[test]
    fn an_unresolved_placeholder_is_an_error_not_an_empty_segment() {
        // The defect this prevents: `/clusters//terminal` navigates somewhere
        // real and wrong, then fails as a ready-signal timeout that names the
        // wrong cause.
        let p = profile();
        let err = plan_nav(&p, "cluster", &params(&[])).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("cluster_id"), "error must name the missing param: {msg}");
        assert!(!msg.contains("//clusters"), "must not have substituted an empty segment");
    }

    #[test]
    fn observe_planning_refuses_a_mutating_action() {
        let p = profile();
        let err = plan_observe(&p, "cluster", "delete-cluster").unwrap_err();
        match err {
            SitesError::RefusedMutation { action, describes } => {
                assert_eq!(action, "cluster.delete-cluster");
                assert!(describes.contains("destroys"));
            }
            other => panic!("expected RefusedMutation, got {other:?}"),
        }
    }

    #[test]
    fn observe_planning_allows_an_observing_action() {
        let p = profile();
        let plan = plan_observe(&p, "cluster", "refresh").unwrap();
        assert_eq!(plan.effect, Effect::Observe);
        assert!(plan.authorized_by.is_none());
    }

    #[test]
    fn a_grant_authorizes_exactly_one_action() {
        // The failure this prevents: one approval becoming a general licence.
        let p = profile();
        let auth = Authorization::grant("cluster.refresh", "operator said go ahead");
        let err = plan_mutate(&p, "cluster", "delete-cluster", &auth).unwrap_err();
        assert!(err.to_string().contains("a grant authorizes one action"));
    }

    #[test]
    fn a_matching_grant_plans_and_carries_the_operators_words() {
        let p = profile();
        let auth = Authorization::grant("cluster.delete-cluster", "yes, tear it down");
        let plan = plan_mutate(&p, "cluster", "delete-cluster", &auth).unwrap();
        assert_eq!(plan.effect, Effect::Mutate);
        assert_eq!(plan.authorized_by.as_deref(), Some("yes, tear it down"));
    }

    #[test]
    fn mutating_actions_are_enumerable_for_review() {
        let p = profile();
        assert_eq!(p.mutating_actions(), vec!["cluster.delete-cluster".to_string()]);
    }

    #[test]
    fn duplicate_names_are_refused_rather_than_resolved_by_order() {
        let y = r#"
base_url: https://platform.example.invalid
pages:
  - name: a
    route: /a
    reads:
      - name: dup
        locator: !selector "h1"
        kind: !text
      - name: dup
        locator: !selector "h2"
        kind: !text
"#;
        let err = ConsoleProfile::from_yaml(y).unwrap_err();
        assert!(err.to_string().contains("duplicate read"), "{err}");
    }

    #[test]
    fn base_url_and_route_join_without_doubling_the_slash() {
        assert_eq!(join_url("https://h/", "/x"), "https://h/x");
        assert_eq!(join_url("https://h", "x"), "https://h/x");
    }
}
