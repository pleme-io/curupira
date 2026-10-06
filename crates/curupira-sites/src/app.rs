use std::fmt::{self, Write as _};

use serde::{Deserialize, Serialize};

use crate::error::{Result, SitesError};
use crate::profile::{Effect, ReadExpect, ReadKind, dup_check, validate_id};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "TextMatchFields", into = "TextMatchFields")]
pub enum TextMatch {
    Exact(String),
    Prefix(String),
    Contains(String),
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TextMatchFields {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    exact: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    prefix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    contains: Option<String>,
}

impl TryFrom<TextMatchFields> for TextMatch {
    type Error = String;

    fn try_from(f: TextMatchFields) -> std::result::Result<Self, Self::Error> {
        match (f.exact, f.prefix, f.contains) {
            (Some(s), None, None) => Ok(TextMatch::Exact(s)),
            (None, Some(s), None) => Ok(TextMatch::Prefix(s)),
            (None, None, Some(s)) => Ok(TextMatch::Contains(s)),
            _ => Err("a text matcher takes exactly one of `exact`, `prefix` or `contains`".to_string()),
        }
    }
}

impl From<TextMatch> for TextMatchFields {
    fn from(m: TextMatch) -> Self {
        match m {
            TextMatch::Exact(s) => Self { exact: Some(s), ..Self::default() },
            TextMatch::Prefix(s) => Self { prefix: Some(s), ..Self::default() },
            TextMatch::Contains(s) => Self { contains: Some(s), ..Self::default() },
        }
    }
}

impl TextMatch {
    #[must_use]
    pub fn needle(&self) -> &str {
        match self {
            TextMatch::Exact(s) | TextMatch::Prefix(s) | TextMatch::Contains(s) => s,
        }
    }

    #[must_use]
    pub fn matches(&self, hay: &str) -> bool {
        let h = fold(hay);
        let n = fold(self.needle());
        match self {
            TextMatch::Exact(_) => h == n,
            TextMatch::Prefix(_) => h.starts_with(&n),
            TextMatch::Contains(_) => h.contains(&n),
        }
    }
}

impl fmt::Display for TextMatch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let op = match self {
            TextMatch::Exact(_) => "=",
            TextMatch::Prefix(_) => "^=",
            TextMatch::Contains(_) => "*=",
        };
        write!(f, "{op}{:?}", self.needle())
    }
}

fn fold(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AxLocator {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subrole: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<TextMatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<TextMatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identifier: Option<TextMatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<TextMatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub within: Option<Box<AxLocator>>,
}

impl AxLocator {
    #[must_use]
    pub fn role(role: &str) -> Self {
        Self { role: Some(role.to_string()), ..Self::default() }
    }

    #[must_use]
    pub fn chain(&self) -> Vec<&AxLocator> {
        let mut out = vec![self];
        let mut cur = self;
        while let Some(w) = &cur.within {
            out.push(w);
            cur = w;
        }
        out.reverse();
        out
    }

    pub fn validate(&self, at: &str) -> Result<()> {
        for step in self.chain() {
            step.validate_step(at)?;
        }
        Ok(())
    }

    fn validate_step(&self, at: &str) -> Result<()> {
        let texts = [&self.title, &self.description, &self.identifier, &self.value];
        if self.role.is_none() && self.subrole.is_none() && texts.iter().all(|t| t.is_none()) {
            return Err(SitesError::Config(format!(
                "{at}: an AX locator with no role, subrole, title, description, identifier or value \
                 matches every element in the app"
            )));
        }
        for (field, v) in [("role", &self.role), ("subrole", &self.subrole)] {
            if let Some(r) = v
                && (!r.starts_with("AX") || r.len() < 3)
            {
                return Err(SitesError::Config(format!(
                    "{at}: {field} '{r}' is not an AX {field} (they are named AXButton, \
                     AXStaticText, AXTable, ...)"
                )));
            }
        }
        for t in texts.into_iter().flatten() {
            if t.needle().trim().is_empty() {
                return Err(SitesError::Config(format!(
                    "{at}: an empty text matcher matches everything; name the text or drop the field"
                )));
            }
        }
        Ok(())
    }
}

impl fmt::Display for AxLocator {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let steps: Vec<String> = self
            .chain()
            .into_iter()
            .map(|s| {
                let mut out = s.role.clone().unwrap_or_else(|| "*".to_string());
                if let Some(sr) = &s.subrole {
                    let _ = write!(out, "[subrole={sr}]");
                }
                for (k, v) in [
                    ("title", &s.title),
                    ("description", &s.description),
                    ("identifier", &s.identifier),
                    ("value", &s.value),
                ] {
                    if let Some(m) = v {
                        let _ = write!(out, "[{k}{m}]");
                    }
                }
                out
            })
            .collect();
        write!(f, "{}", steps.join(" > "))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AxReady {
    WindowTitle(TextMatch),
    ElementPresent(AxLocator),
}

impl AxReady {
    #[must_use]
    pub fn label(&self) -> String {
        match self {
            AxReady::WindowTitle(m) => format!("window-title {m}"),
            AxReady::ElementPresent(l) => format!("element-present {l}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AxRead {
    pub name: String,
    pub locator: AxLocator,
    pub kind: ReadKind,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AxPerform {
    #[default]
    Press,
    SetValue,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AxAction {
    pub name: String,
    pub locator: AxLocator,
    pub effect: Effect,
    #[serde(default)]
    pub describes: String,
    #[serde(default)]
    pub perform: AxPerform,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct View {
    pub name: String,
    #[serde(default)]
    pub ready: Vec<AxReady>,
    #[serde(default)]
    pub reads: Vec<AxRead>,
    #[serde(default)]
    pub actions: Vec<AxAction>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppTest {
    pub name: String,
    pub view: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub expect_controls: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub expect_reads: Vec<ReadExpect>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppProfile {
    pub id: String,
    pub bundle_id: String,
    pub views: Vec<View>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tests: Vec<AppTest>,
}

impl AppProfile {
    #[must_use]
    pub fn view(&self, name: &str) -> Option<&View> {
        self.views.iter().find(|v| v.name == name)
    }

    pub fn validate(&self) -> Result<()> {
        validate_id(&self.id)?;
        let b = self.bundle_id.trim();
        if b.is_empty()
            || !b.contains('.')
            || !b.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        {
            return Err(SitesError::Config(format!(
                "profile '{}': bundle_id '{}' is not a bundle identifier (reverse-DNS, e.g. \
                 com.apple.calculator)",
                self.id, self.bundle_id
            )));
        }
        dup_check("view", self.views.iter().map(|v| v.name.as_str()))?;
        for v in &self.views {
            dup_check(&format!("read on view '{}'", v.name), v.reads.iter().map(|r| r.name.as_str()))?;
            dup_check(
                &format!("action on view '{}'", v.name),
                v.actions.iter().map(|a| a.name.as_str()),
            )?;
            for s in &v.ready {
                match s {
                    AxReady::ElementPresent(l) => l.validate(&format!("view '{}' ready", v.name))?,
                    AxReady::WindowTitle(m) if m.needle().trim().is_empty() => {
                        return Err(SitesError::Config(format!(
                            "view '{}': an empty window-title matcher is true for any window",
                            v.name
                        )));
                    }
                    AxReady::WindowTitle(_) => {}
                }
            }
            for r in &v.reads {
                r.locator.validate(&format!("view '{}' read '{}'", v.name, r.name))?;
                if let ReadKind::Attribute(a) = &r.kind
                    && !a.starts_with("AX")
                {
                    return Err(SitesError::Config(format!(
                        "view '{}' read '{}': attribute '{a}' is not an AX attribute name \
                         (AXValue, AXTitle, AXEnabled, ...)",
                        v.name, r.name
                    )));
                }
            }
            for a in &v.actions {
                a.locator.validate(&format!("view '{}' action '{}'", v.name, a.name))?;
            }
            let has_element_signal = v.ready.iter().any(|s| matches!(s, AxReady::ElementPresent(_)));
            if (!v.reads.is_empty() || !v.actions.is_empty()) && !has_element_signal {
                return Err(SitesError::Config(format!(
                    "view '{}' declares {} read(s) and {} action(s) but no element-present ready \
                     signal{} — a window title is set before the window's content exists, so \
                     reads and presses would run against whatever was there before",
                    v.name,
                    v.reads.len(),
                    v.actions.len(),
                    if v.ready.is_empty() { " at all" } else { " (only window-title)" }
                )));
            }
        }
        for t in &self.tests {
            let view = self.view(&t.view).ok_or_else(|| {
                SitesError::Config(format!(
                    "test '{}' names view '{}', which the profile has no view for",
                    t.name, t.view
                ))
            })?;
            for er in &t.expect_reads {
                if !view.reads.iter().any(|r| r.name == er.read) {
                    return Err(SitesError::Config(format!(
                        "test '{}' expects read '{}' on view '{}', which has no such read",
                        t.name, er.read, t.view
                    )));
                }
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
pub enum AxOp {
    Ready { ready: Vec<AxReady> },
    Read { read: AxRead, limit: usize },
    Act { action: AxAction },
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::{Outcome, Profile, TargetKind};

    const CALC: &str = r#"
target: macos-app
id: calc
bundle_id: com.apple.calculator
views:
  - name: keypad
    ready:
      - !window-title { contains: Calculator }
      - !element-present
        role: AXButton
        description: { exact: clear }
    reads:
      - name: display
        locator:
          role: AXStaticText
          within:
            role: AXScrollArea
        kind: !text
      - name: buttons
        locator: { role: AXButton }
        kind: !count
    actions:
      - name: clear
        locator:
          role: AXButton
          description: { exact: clear }
          within:
            role: AXWindow
            title: { contains: Calculator }
        effect: mutate
        describes: clears the current calculation
tests:
  - name: keypad renders
    view: keypad
    expect_controls: ["clear"]
    expect_reads:
      - read: display
        outcome: found
"#;

    fn app(yaml: &str) -> Result<AppProfile> {
        match Profile::from_yaml(yaml)? {
            Profile::MacosApp(p) => Ok(p),
            Profile::Browser(_) => panic!("parsed as browser"),
        }
    }

    #[test]
    fn a_macos_app_profile_parses_with_tagged_matchers_and_nested_scopes() {
        let p = app(CALC).unwrap();
        assert_eq!(p.bundle_id, "com.apple.calculator");
        let v = &p.views[0];
        assert_eq!(v.ready.len(), 2);
        assert_eq!(v.ready[0], AxReady::WindowTitle(TextMatch::Contains("Calculator".into())));
        let clear = &v.actions[0];
        assert_eq!(clear.perform, AxPerform::Press);
        let chain = clear.locator.chain();
        assert_eq!(chain.len(), 2);
        assert_eq!(chain[0].role.as_deref(), Some("AXWindow"));
        assert_eq!(chain[1].role.as_deref(), Some("AXButton"));
        assert_eq!(p.tests[0].expect_reads[0].outcome, Outcome::Found);
        assert_eq!(p.mutating_actions(), vec!["keypad.clear".to_string()]);
    }

    #[test]
    fn the_target_kind_is_read_from_the_profile() {
        assert_eq!(Profile::from_yaml(CALC).unwrap().kind(), TargetKind::MacosApp);
    }

    #[test]
    fn a_css_selector_cannot_appear_in_a_macos_app_profile() {
        let bad = CALC.replace(
            "locator: { role: AXButton }",
            "locator: !selector \"button.key\"",
        );
        let err = app(&bad).unwrap_err().to_string();
        assert!(err.contains("macos-app"), "{err}");
    }

    #[test]
    fn a_browser_ready_signal_cannot_appear_in_a_macos_app_profile() {
        let bad = CALC.replace("- !window-title { contains: Calculator }", "- !selector-present \"#app\"");
        let err = app(&bad).unwrap_err().to_string();
        assert!(err.contains("selector-present"), "{err}");
    }

    #[test]
    fn browser_fields_are_refused_in_a_macos_app_profile() {
        let bad = CALC.replace("bundle_id: com.apple.calculator", "bundle_id: com.apple.calculator\nbase_url: https://x.example.invalid");
        let err = app(&bad).unwrap_err().to_string();
        assert!(err.contains("base_url"), "{err}");
    }

    #[test]
    fn a_view_with_reads_and_no_element_signal_is_refused() {
        let bad = CALC.replace(
            "      - !element-present\n        role: AXButton\n        description: { exact: clear }\n",
            "",
        );
        let err = app(&bad).unwrap_err().to_string();
        assert!(err.contains("no element-present ready signal (only window-title)"), "{err}");
    }

    #[test]
    fn a_view_with_no_ready_signal_at_all_is_refused() {
        let y = "target: macos-app\nid: a\nbundle_id: com.example.a\nviews:\n  - name: v\n    reads:\n      - name: r\n        locator: { role: AXStaticText }\n        kind: !text\n";
        let err = app(y).unwrap_err().to_string();
        assert!(err.contains("ready signal at all"), "{err}");
    }

    #[test]
    fn a_view_with_nothing_to_read_or_press_needs_no_element_signal() {
        let y = "target: macos-app\nid: a\nbundle_id: com.example.a\nviews:\n  - name: v\n    ready:\n      - !window-title { exact: A }\n";
        assert!(app(y).is_ok());
    }

    #[test]
    fn an_empty_locator_is_refused() {
        let bad = CALC.replace("locator: { role: AXButton }", "locator: {}");
        let err = app(&bad).unwrap_err().to_string();
        assert!(err.contains("matches every element"), "{err}");
    }

    #[test]
    fn a_role_that_is_not_an_ax_role_is_refused() {
        let bad = CALC.replace("locator: { role: AXButton }", "locator: { role: button }");
        let err = app(&bad).unwrap_err().to_string();
        assert!(err.contains("not an AX role"), "{err}");
    }

    #[test]
    fn a_non_ax_attribute_read_is_refused() {
        let bad = CALC.replace("kind: !count", "kind: !attribute data-id");
        let err = app(&bad).unwrap_err().to_string();
        assert!(err.contains("not an AX attribute"), "{err}");
    }

    #[test]
    fn a_bundle_id_that_is_not_reverse_dns_is_refused() {
        let bad = CALC.replace("bundle_id: com.apple.calculator", "bundle_id: Calculator");
        assert!(app(&bad).unwrap_err().to_string().contains("not a bundle identifier"));
    }

    #[test]
    fn a_test_naming_a_missing_view_or_read_is_refused() {
        let bad = CALC.replace("    view: keypad", "    view: nowhere");
        assert!(app(&bad).unwrap_err().to_string().contains("no view for"));
        let bad = CALC.replace("      - read: display", "      - read: nothing");
        assert!(app(&bad).unwrap_err().to_string().contains("no such read"));
    }

    #[test]
    fn duplicate_view_names_are_refused() {
        let bad = format!("{CALC}\n").replace(
            "tests:",
            "  - name: keypad\n    ready:\n      - !window-title { exact: X }\ntests:",
        );
        assert!(app(&bad).unwrap_err().to_string().contains("duplicate view"));
    }

    #[test]
    fn set_value_is_its_own_action_kind() {
        let y = CALC.replace("        describes: clears the current calculation", "        describes: types\n        perform: set-value");
        assert_eq!(app(&y).unwrap().views[0].actions[0].perform, AxPerform::SetValue);
    }

    #[test]
    fn a_text_matcher_takes_exactly_one_mode() {
        let bad = CALC.replace("{ contains: Calculator }\n      - !element", "{ contains: Calculator, exact: Calculator }\n      - !element");
        let err = app(&bad).unwrap_err().to_string();
        assert!(err.contains("exactly one of"), "{err}");
        let bad = CALC.replace("{ exact: clear }\n    reads", "{ regex: \".*\" }\n    reads");
        assert!(app(&bad).is_err());
    }

    #[test]
    fn text_matching_folds_case_and_whitespace_on_both_sides() {
        assert!(TextMatch::Exact("All  Clear".into()).matches(" all clear "));
        assert!(TextMatch::Prefix("Pods".into()).matches("pods · 179"));
        assert!(!TextMatch::Prefix("179".into()).matches("pods · 179"));
        assert!(TextMatch::Contains("terminal".into()).matches(">_Terminal"));
        assert!(!TextMatch::Exact("Clear".into()).matches("All Clear"));
    }

    #[test]
    fn a_locator_renders_its_scope_chain_outermost_first() {
        let p = app(CALC).unwrap();
        let s = p.views[0].actions[0].locator.to_string();
        assert_eq!(s, "AXWindow[title*=\"Calculator\"] > AXButton[description=\"clear\"]");
    }
}
