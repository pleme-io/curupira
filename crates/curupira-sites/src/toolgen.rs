//! Compile a [`ConsoleProfile`] into MCP tool definitions.
//!
//! This is the author-time half of the plugin system: a profile goes in, and a
//! self-contained [`Bundle`] comes out carrying every tool's name, description,
//! JSON Schema and the **already-emitted JavaScript** it evaluates. curupira's
//! TypeScript server loads the bundle at startup and spawns nothing — no Rust
//! runs at request time.
//!
//! # Two constraints from the host, both load-bearing
//!
//! **Tools must be registered at startup.** curupira registers every provider
//! statically because the MCP client does not refresh its tool list after the
//! initial connection. So "become aware of the context" cannot mean swapping
//! tools when the tab changes: all sites' tools exist from the start, and which
//! profile is *live* is resolved per call. [`Bundle::site_for_url`] is that
//! resolution.
//!
//! **The registry is one flat map, and a duplicate name silently overwrites.**
//! Not an error — an overwrite. So every generated name is namespaced by the
//! profile id, and [`Bundle::validate`] refuses a bundle with a collision rather
//! than letting one site's tool quietly shadow another's.
//!
//! # Always emit a JSON Schema
//!
//! curupira's `BaseToolProvider.listTools` falls back to
//! `{type:'object', additionalProperties:true}` when a definition has no
//! `jsonSchema`, and only logs it. That fallback is worse than useless: the tool
//! appears to take anything, so a caller's wrong arguments arrive as a runtime
//! failure instead of a schema rejection. Every tool here carries a real schema.

use serde::{Deserialize, Serialize};

use crate::emit;
use crate::error::{Result, SitesError};
use crate::profile::{ConsoleProfile, Effect, Page};

/// What driving a generated tool does, mirrored from the profile so the TS side
/// can enforce the borrowed-ground gate without re-reading the profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToolKind {
    /// Navigate to a page. Carries the ready probe.
    Goto,
    /// Read data from the current page.
    Read,
    /// Click a control.
    Act,
}

/// One generated MCP tool, fully baked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolSpec {
    /// Globally-unique MCP tool name, namespaced by profile id.
    pub name: String,
    pub description: String,
    pub kind: ToolKind,
    /// Profile-local page this tool belongs to.
    pub page: String,
    /// JSON Schema for the tool's arguments. Never omitted — see the module doc.
    pub json_schema: serde_json::Value,
    /// The JavaScript expression to evaluate in the page.
    pub js: String,
    /// For `Goto`: the absolute URL template, placeholders unresolved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url_template: Option<String>,
    /// For `Goto`: an in-page tab to activate after load.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab: Option<String>,
    /// For `Act`: whether a grant is required before this may be driven.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effect: Option<Effect>,
    /// For `Act`: what the control does, shown to whoever is asked to grant it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub describes: Option<String>,
}

/// One console's compiled surface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SiteBundle {
    pub id: String,
    pub base_url: String,
    #[serde(rename = "match")]
    pub match_urls: Vec<String>,
    pub tools: Vec<ToolSpec>,
    /// The site's compiled qualifying suite — carried IN the bundle so the MCP
    /// server can run it per-site on demand with no reference back to the profile.
    /// Empty for a site with no suite.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tests: Vec<crate::testplan::CompiledTest>,
}

/// Every compiled console, as the TS server loads it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bundle {
    /// Bumped when the shape changes, so a server reading an older bundle can
    /// say so rather than silently mis-reading fields.
    pub schema_version: u32,
    pub sites: Vec<SiteBundle>,
}

/// Current bundle schema version.
pub const SCHEMA_VERSION: u32 = 1;

/// How long a generated `goto` waits for its page to become ready.
/// Generous on purpose: a console behind a slow backend is normal, and the
/// waiter reports WHICH signal never held, so a long wait still ends in a
/// diagnosis rather than a bare timeout.
pub const READY_TIMEOUT_MS: u64 = 15_000;
pub const READY_POLL_MS: u64 = 150;

impl Bundle {
    /// Compile a set of profiles.
    pub fn compile(profiles: &[ConsoleProfile]) -> Result<Self> {
        let mut sites = Vec::with_capacity(profiles.len());
        for p in profiles {
            p.validate()?;
            sites.push(SiteBundle {
                id: p.id.clone(),
                base_url: p.base_url.clone(),
                match_urls: p.match_urls.clone(),
                tools: generate(p)?,
                tests: crate::testplan::compile(p)?,
            });
        }
        let b = Self { schema_version: SCHEMA_VERSION, sites };
        b.validate()?;
        Ok(b)
    }

    /// Refuse a bundle whose tool names collide.
    ///
    /// The host registry would accept it and silently keep the last one, so the
    /// only place this can be caught is here.
    pub fn validate(&self) -> Result<()> {
        let mut seen = std::collections::BTreeMap::new();
        for s in &self.sites {
            for t in &s.tools {
                if let Some(prev) = seen.insert(t.name.clone(), s.id.clone()) {
                    return Err(SitesError::Config(format!(
                        "tool name collision: '{}' generated by both site '{prev}' and site \
                         '{}' — the host registry would silently keep only one",
                        t.name, s.id
                    )));
                }
            }
        }
        Ok(())
    }

    /// Which site claims this tab URL, if any.
    ///
    /// Returns the FIRST match in load order and does not attempt to rank
    /// candidates: two profiles claiming one URL is an authoring mistake, and
    /// picking a "best" one would hide it behind plausible behaviour. Callers
    /// that care should surface [`Bundle::sites_for_url`] instead.
    #[must_use]
    pub fn site_for_url(&self, url: &str) -> Option<&SiteBundle> {
        self.sites.iter().find(|s| s.match_urls.iter().any(|m| !m.is_empty() && url.contains(m)))
    }

    /// Every site claiming this URL — so an ambiguous match is visible rather
    /// than silently resolved.
    #[must_use]
    pub fn sites_for_url(&self, url: &str) -> Vec<&SiteBundle> {
        self.sites
            .iter()
            .filter(|s| s.match_urls.iter().any(|m| !m.is_empty() && url.contains(m)))
            .collect()
    }
}

/// Generate every tool for one profile.
pub fn generate(profile: &ConsoleProfile) -> Result<Vec<ToolSpec>> {
    let mut out = Vec::new();
    for page in &profile.pages {
        out.push(goto_tool(profile, page)?);
        for r in &page.reads {
            out.push(ToolSpec {
                name: tool_name(&profile.id, &page.name, "read", &r.name),
                description: format!("Read '{}' on the '{}' page", r.name, page.name),
                kind: ToolKind::Read,
                page: page.name.clone(),
                json_schema: no_args_schema(),
                js: emit::emit_read_checked(r)?,
                url_template: None,
                tab: None,
                effect: None,
                describes: None,
            });
        }
        for a in &page.actions {
            let mutating = a.effect == Effect::Mutate;
            out.push(ToolSpec {
                name: tool_name(&profile.id, &page.name, "act", &a.name),
                // The description is what a model reads when deciding whether to
                // call this. A mutating control says so first, in words, rather
                // than only in a field the model may not surface.
                description: if mutating {
                    format!(
                        "MUTATES the host: {} (control '{}' on the '{}' page). Requires an \
                         explicit operator grant naming this action.",
                        if a.describes.is_empty() { "changes state" } else { &a.describes },
                        a.name,
                        page.name
                    )
                } else {
                    format!("Click '{}' on the '{}' page (read-only)", a.name, page.name)
                },
                kind: ToolKind::Act,
                page: page.name.clone(),
                json_schema: if mutating { grant_schema() } else { no_args_schema() },
                js: emit::emit_click(&a.locator)?,
                url_template: None,
                tab: None,
                effect: Some(a.effect),
                describes: Some(a.describes.clone()),
            });
        }
    }
    Ok(out)
}

fn goto_tool(profile: &ConsoleProfile, page: &Page) -> Result<ToolSpec> {
    let params = route_params(&page.route);
    Ok(ToolSpec {
        name: tool_name(&profile.id, &page.name, "goto", ""),
        description: format!("Navigate to the '{}' page", page.name),
        kind: ToolKind::Goto,
        page: page.name.clone(),
        json_schema: params_schema(&params),
        // A waiter, not a probe. Round F1 measured why: a probe nobody acts
        // on let reads run against the previous page's DOM.
        js: emit::emit_ready_wait(&page.ready, READY_TIMEOUT_MS, READY_POLL_MS)?,
        url_template: Some(join_url(&profile.base_url, &page.route)),
        tab: page.tab.clone(),
        effect: None,
        describes: None,
    })
}

/// `{site}_{page}_{verb}[_{leaf}]`, sanitized to what an MCP tool name allows.
fn tool_name(site: &str, page: &str, verb: &str, leaf: &str) -> String {
    let mut n = format!("{}_{}_{}", slug(site), slug(page), verb);
    if !leaf.is_empty() {
        n.push('_');
        n.push_str(&slug(leaf));
    }
    n
}

/// Lowercase, and anything outside `[a-z0-9_]` becomes `_`.
///
/// Collapsing runs matters: `delete-cluster` and `delete_cluster` must not both
/// become distinct-looking names that differ only by a character the host may
/// normalize, and `a--b` should not yield `a__b` while `a-b` yields `a_b`.
fn slug(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_us = false;
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            last_us = false;
        } else if !last_us {
            out.push('_');
            last_us = true;
        }
    }
    out.trim_matches('_').to_string()
}

/// `{param}` placeholders in a route, in order, deduplicated.
fn route_params(route: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut rest = route;
    while let Some(i) = rest.find('{') {
        rest = &rest[i + 1..];
        let Some(j) = rest.find('}') else { break };
        let name = &rest[..j];
        if !name.is_empty() && !out.iter().any(|e| e == name) {
            out.push(name.to_string());
        }
        rest = &rest[j + 1..];
    }
    out
}

fn params_schema(params: &[String]) -> serde_json::Value {
    let mut props = serde_json::Map::new();
    for p in params {
        props.insert(
            p.clone(),
            serde_json::json!({ "type": "string", "description": format!("route parameter '{p}'") }),
        );
    }
    serde_json::json!({
        "type": "object",
        "properties": props,
        "required": params,
        "additionalProperties": false,
    })
}

fn no_args_schema() -> serde_json::Value {
    serde_json::json!({ "type": "object", "properties": {}, "additionalProperties": false })
}

/// A mutating tool takes the operator's grant as a required argument.
///
/// Making it required and free-text is the point: it cannot be defaulted, and
/// what the operator actually said travels with the call into the log rather
/// than being asserted after the fact.
fn grant_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "authorized_by": {
                "type": "string",
                "description": "The operator's explicit go-ahead for THIS action, in their own words. Required: this control mutates the host.",
                "minLength": 1
            }
        },
        "required": ["authorized_by"],
        "additionalProperties": false,
    })
}

fn join_url(base: &str, route: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), route.trim_start_matches('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(id: &str) -> ConsoleProfile {
        ConsoleProfile::from_yaml(&format!(
            r#"
id: {id}
base_url: https://platform.example.invalid
match:
  - platform.example.invalid
pages:
  - name: cluster
    route: /clusters/{{cluster_id}}
    ready:
      - !selector-present ".xterm"
    reads:
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
"#
        ))
        .expect("fixture parses")
    }

    #[test]
    fn generates_goto_read_and_act_tools() {
        let t = generate(&profile("acme")).unwrap();
        let names: Vec<&str> = t.iter().map(|x| x.name.as_str()).collect();
        assert!(names.contains(&"acme_cluster_goto"), "{names:?}");
        assert!(names.contains(&"acme_cluster_read_pods"), "{names:?}");
        assert!(names.contains(&"acme_cluster_act_refresh"), "{names:?}");
        assert!(names.contains(&"acme_cluster_act_delete_cluster"), "{names:?}");
    }

    #[test]
    fn every_tool_carries_a_real_json_schema() {
        // The host silently substitutes {additionalProperties:true} for a missing
        // schema, which makes a tool look like it accepts anything.
        for t in generate(&profile("acme")).unwrap() {
            assert_eq!(t.json_schema["type"], "object", "{}", t.name);
            assert!(t.json_schema.get("properties").is_some(), "{} has no properties", t.name);
            assert_eq!(
                t.json_schema["additionalProperties"], false,
                "{} must not accept arbitrary args",
                t.name
            );
        }
    }

    #[test]
    fn a_mutating_tool_requires_a_grant_argument() {
        let t = generate(&profile("acme")).unwrap();
        let del = t.iter().find(|x| x.name == "acme_cluster_act_delete_cluster").unwrap();
        assert_eq!(del.effect, Some(Effect::Mutate));
        assert_eq!(del.json_schema["required"][0], "authorized_by");
        // and it announces itself in the text a model actually reads
        assert!(del.description.starts_with("MUTATES the host"), "{}", del.description);
        assert!(del.description.contains("permanently destroys"));
    }

    #[test]
    fn an_observing_tool_takes_no_grant() {
        let t = generate(&profile("acme")).unwrap();
        let refresh = t.iter().find(|x| x.name == "acme_cluster_act_refresh").unwrap();
        assert_eq!(refresh.effect, Some(Effect::Observe));
        assert_eq!(refresh.json_schema["properties"], serde_json::json!({}));
    }

    #[test]
    fn goto_requires_its_route_parameters() {
        let t = generate(&profile("acme")).unwrap();
        let g = t.iter().find(|x| x.name == "acme_cluster_goto").unwrap();
        assert_eq!(g.json_schema["required"][0], "cluster_id");
        assert_eq!(
            g.url_template.as_deref(),
            Some("https://platform.example.invalid/clusters/{cluster_id}")
        );
    }

    #[test]
    fn colliding_tool_names_across_sites_are_refused() {
        // Two profiles with the SAME id: the host registry would accept the
        // duplicates and silently keep the last, so this must fail here.
        let err = Bundle::compile(&[profile("same"), profile("same")]).unwrap_err();
        assert!(err.to_string().contains("collision"), "{err}");
    }

    #[test]
    fn distinct_site_ids_do_not_collide() {
        let b = Bundle::compile(&[profile("alpha"), profile("beta")]).unwrap();
        assert_eq!(b.sites.len(), 2);
        assert_eq!(b.schema_version, SCHEMA_VERSION);
    }

    #[test]
    fn url_matching_selects_the_live_site() {
        let b = Bundle::compile(&[profile("alpha")]).unwrap();
        let hit = b.site_for_url("https://platform.example.invalid/clusters/69").unwrap();
        assert_eq!(hit.id, "alpha");
        assert!(b.site_for_url("https://elsewhere.test/x").is_none());
    }

    #[test]
    fn an_ambiguous_url_match_is_visible_rather_than_silently_resolved() {
        let mut a = profile("alpha");
        let mut c = profile("beta");
        a.match_urls = vec!["shared.example".to_string()];
        c.match_urls = vec!["shared.example".to_string()];
        let b = Bundle::compile(&[a, c]).unwrap();
        assert_eq!(b.sites_for_url("https://shared.example/x").len(), 2);
    }

    #[test]
    fn a_profile_with_no_match_patterns_claims_nothing() {
        // Not everything. An unreviewed draft must not silently own every tab.
        let mut p = profile("draft");
        p.match_urls.clear();
        let b = Bundle::compile(&[p]).unwrap();
        assert!(b.site_for_url("https://anything.test/").is_none());
    }

    #[test]
    fn a_profile_without_an_id_is_refused() {
        let mut p = profile("acme");
        p.id = String::new();
        assert!(Bundle::compile(&[p]).unwrap_err().to_string().contains("no 'id'"));
    }

    #[test]
    fn an_id_that_would_not_survive_a_tool_name_is_refused() {
        let mut p = profile("acme");
        p.id = "has spaces/and.dots".to_string();
        assert!(Bundle::compile(&[p]).unwrap_err().to_string().contains("must be ASCII"));
    }

    #[test]
    fn slug_collapses_runs_and_trims() {
        assert_eq!(slug("delete-cluster"), "delete_cluster");
        assert_eq!(slug("a--b"), "a_b");
        assert_eq!(slug("-lead/trail-"), "lead_trail");
        assert_eq!(slug("Mixed Case"), "mixed_case");
    }

    #[test]
    fn route_params_are_ordered_and_deduplicated() {
        assert_eq!(route_params("/a/{x}/b/{y}/c/{x}"), vec!["x", "y"]);
        assert!(route_params("/no/params").is_empty());
    }

    #[test]
    fn the_bundle_round_trips_through_json() {
        let b = Bundle::compile(&[profile("acme")]).unwrap();
        let s = serde_json::to_string(&b).unwrap();
        let back: Bundle = serde_json::from_str(&s).unwrap();
        assert_eq!(b, back, "the TS server reads exactly what was written");
    }
}
