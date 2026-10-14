use serde::{Deserialize, Serialize};

use crate::error::{Result, SitesError};
use crate::profile::{Effect, dup_check, validate_id};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Tier {
    Read,
    Click,
    Full,
}

impl Tier {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Tier::Read => "read",
            Tier::Click => "click",
            Tier::Full => "full",
        }
    }
}

pub const STEP_VERBS: [&str; 7] = ["key", "type", "click", "scroll", "wait", "screenshot", "open"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopRead {
    pub name: String,
    pub region: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopAction {
    pub name: String,
    pub effect: Effect,
    pub steps: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub params: Vec<String>,
    #[serde(default)]
    pub describes: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopView {
    pub name: String,
    pub ready: Vec<String>,
    #[serde(default)]
    pub reads: Vec<DesktopRead>,
    #[serde(default)]
    pub actions: Vec<DesktopAction>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopProfile {
    pub id: String,
    pub app: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
    pub tier: Tier,
    pub why: String,
    pub views: Vec<DesktopView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub promote: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
pub enum DesktopOp {
    Ready { ready: Vec<String> },
    Read { region: String },
    Act { steps: Vec<String>, params: Vec<String> },
}

fn placeholders(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = s;
    while let Some(i) = rest.find('{') {
        rest = &rest[i + 1..];
        let Some(j) = rest.find('}') else { break };
        out.push(&rest[..j]);
        rest = &rest[j + 1..];
    }
    out
}

impl DesktopProfile {
    #[must_use]
    pub fn view(&self, name: &str) -> Option<&DesktopView> {
        self.views.iter().find(|v| v.name == name)
    }

    pub fn validate(&self) -> Result<()> {
        validate_id(&self.id)?;
        let err = |m: String| Err(SitesError::Config(format!("desktop profile '{}': {m}", self.id)));
        if self.app.trim().is_empty() {
            return err("`app` is empty; name the app as macOS shows it (computer-use request_access and open_application take that name)".to_string());
        }
        if self.why.trim().is_empty() {
            return err("`why` is empty; say why neither a browser nor a macos-app profile covers this surface".to_string());
        }
        if let Some(b) = &self.bundle_id
            && (!b.contains('.') || !b.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-'))
        {
            return err(format!("bundle_id '{b}' is not a bundle identifier (reverse-DNS, e.g. com.apple.systempreferences)"));
        }
        if let Some(p) = &self.promote {
            validate_id(p)?;
        }
        if self.views.is_empty() {
            return err("no views; a desktop profile needs at least one".to_string());
        }
        dup_check("view", self.views.iter().map(|v| v.name.as_str()))?;
        for v in &self.views {
            if v.ready.iter().all(|r| r.trim().is_empty()) {
                return err(format!("view '{}' has no ready text; name visible text that proves the view is up", v.name));
            }
            dup_check(&format!("read on view '{}'", v.name), v.reads.iter().map(|r| r.name.as_str()))?;
            dup_check(&format!("action on view '{}'", v.name), v.actions.iter().map(|a| a.name.as_str()))?;
            for r in &v.reads {
                if r.region.trim().is_empty() {
                    return err(format!("view '{}' read '{}' has no region", v.name, r.name));
                }
            }
            for a in &v.actions {
                self.validate_action(v, a)?;
            }
        }
        Ok(())
    }

    fn validate_action(&self, v: &DesktopView, a: &DesktopAction) -> Result<()> {
        let at = format!("desktop profile '{}' view '{}' action '{}'", self.id, v.name, a.name);
        if a.steps.is_empty() {
            return Err(SitesError::Config(format!("{at}: no steps")));
        }
        for s in &a.steps {
            let verb = s.split_whitespace().next().unwrap_or("");
            if !STEP_VERBS.contains(&verb) {
                return Err(SitesError::Config(format!(
                    "{at}: step '{s}' starts with '{verb}'; legal step verbs: {}",
                    STEP_VERBS.join(", ")
                )));
            }
            let blocked: &[&str] = match self.tier {
                Tier::Read => &["type", "click", "key"],
                Tier::Click => &["type", "key"],
                Tier::Full => &[],
            };
            if blocked.contains(&verb) {
                return Err(SitesError::Config(format!(
                    "{at}: step '{s}' needs more than tier '{}' grants; computer-use blocks {} at that tier",
                    self.tier.as_str(),
                    blocked.join(", ")
                )));
            }
            for p in placeholders(s) {
                if !a.params.iter().any(|d| d == p) {
                    return Err(SitesError::Config(format!(
                        "{at}: step '{s}' uses {{{p}}}, which is not in params"
                    )));
                }
            }
        }
        for p in &a.params {
            if !a.steps.iter().any(|s| placeholders(s).contains(&p.as_str())) {
                return Err(SitesError::Config(format!("{at}: param '{p}' is declared but no step uses it")));
            }
        }
        Ok(())
    }

    #[must_use]
    pub fn mutating_actions(&self) -> Vec<String> {
        self.views
            .iter()
            .flat_map(|v| {
                v.actions
                    .iter()
                    .filter(|a| a.effect == Effect::Mutate)
                    .map(move |a| format!("{}.{}", v.name, a.name))
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::{Profile, TargetKind};

    const SETTINGS: &str = include_str!("../../../sites/example-desktop.yaml");

    fn desk(yaml: &str) -> Result<DesktopProfile> {
        match Profile::from_yaml(yaml)? {
            Profile::Desktop(p) => Ok(p),
            other => panic!("parsed as {:?}", other.kind()),
        }
    }

    fn refused(yaml: &str) -> String {
        desk(yaml).unwrap_err().to_string()
    }

    #[test]
    fn the_example_parses_as_a_desktop_target() {
        let p = desk(SETTINGS).unwrap();
        assert_eq!(Profile::from_yaml(SETTINGS).unwrap().kind(), TargetKind::Desktop);
        assert_eq!(p.app, "System Settings");
        assert_eq!(p.bundle_id.as_deref(), Some("com.apple.systempreferences"));
        assert_eq!(p.tier, Tier::Full);
        assert!(p.mutating_actions().is_empty());
    }

    #[test]
    fn an_empty_why_is_refused() {
        let y = "target: desktop\nid: d\napp: A\ntier: full\nwhy: ' '\nviews:\n  - name: v\n    ready: [A]\n";
        assert!(refused(y).contains("`why` is empty"));
    }

    #[test]
    fn a_missing_why_is_refused() {
        let y = "target: desktop\nid: d\napp: A\ntier: full\nviews:\n  - name: v\n    ready: [A]\n";
        assert!(refused(y).contains("why"));
    }

    #[test]
    fn an_empty_app_is_refused() {
        let y = "target: desktop\nid: d\napp: ''\ntier: full\nwhy: w\nviews:\n  - name: v\n    ready: [A]\n";
        assert!(refused(y).contains("`app` is empty"));
    }

    #[test]
    fn a_bad_id_is_refused_by_the_shared_rule() {
        let y = "target: desktop\nid: 'a b'\napp: A\ntier: full\nwhy: w\nviews:\n  - name: v\n    ready: [A]\n";
        assert!(refused(y).contains("must be ASCII"));
    }

    #[test]
    fn no_views_is_refused() {
        let y = "target: desktop\nid: d\napp: A\ntier: full\nwhy: w\nviews: []\n";
        assert!(refused(y).contains("at least one"));
    }

    #[test]
    fn a_view_without_ready_text_is_refused() {
        let y = "target: desktop\nid: d\napp: A\ntier: full\nwhy: w\nviews:\n  - name: v\n    ready: []\n";
        assert!(refused(y).contains("no ready text"));
    }

    fn with_step(tier: &str, step: &str) -> String {
        format!(
            "target: desktop\nid: d\napp: A\ntier: {tier}\nwhy: w\nviews:\n  - name: v\n    ready: [A]\n    actions:\n      - name: go\n        effect: observe\n        steps: [\"{step}\"]\n"
        )
    }

    #[test]
    fn an_unknown_step_verb_names_the_legal_ones() {
        let e = refused(&with_step("full", "drag 'x' to 'y'"));
        assert!(e.contains("legal step verbs: key, type, click, scroll, wait, screenshot, open"), "{e}");
    }

    #[test]
    fn tier_read_refuses_type_and_click() {
        assert!(refused(&with_step("read", "type hello")).contains("tier 'read'"));
        assert!(refused(&with_step("read", "click 'Join'")).contains("tier 'read'"));
        assert!(desk(&with_step("read", "scroll down")).is_ok());
    }

    #[test]
    fn tier_click_refuses_type_and_key() {
        assert!(refused(&with_step("click", "type hello")).contains("tier 'click'"));
        assert!(refused(&with_step("click", "key cmd+k")).contains("tier 'click'"));
        assert!(desk(&with_step("click", "click 'Run'")).is_ok());
    }

    #[test]
    fn an_undeclared_placeholder_is_refused() {
        assert!(refused(&with_step("full", "type {query}")).contains("not in params"));
    }

    #[test]
    fn a_declared_unused_param_is_refused() {
        let y = with_step("full", "key cmd+k").replace("        steps:", "        params: [query]\n        steps:");
        assert!(refused(&y).contains("no step uses it"));
    }

    #[test]
    fn an_unknown_tier_is_refused() {
        assert!(desk(&with_step("admin", "wait 1")).is_err());
    }

    #[test]
    fn browser_fields_are_refused_in_a_desktop_profile() {
        let y = with_step("full", "wait 1").replace("app: A", "app: A\nbase_url: https://x.example.invalid");
        assert!(refused(&y).contains("base_url"));
    }
}
