use serde::Serialize;

use crate::tree::{AxTree, Walk, label_of};

const VALUE_PREVIEW: usize = 200;

pub const PRESSABLE: [&str; 8] = [
    "AXButton",
    "AXCheckBox",
    "AXRadioButton",
    "AXPopUpButton",
    "AXMenuButton",
    "AXLink",
    "AXDisclosureTriangle",
    "AXSegment",
];

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SurveyNode {
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subrole: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identifier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<SurveyNode>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub cut: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SurveyReport {
    pub bundle_id: String,
    pub windows: Vec<String>,
    pub nodes: usize,
    pub truncated: bool,
    pub tree: SurveyNode,
}

pub fn survey<T: AxTree>(tree: &T, bundle_id: &str, walk: Walk) -> SurveyReport {
    let mut count = 0usize;
    let mut truncated = false;
    let root = node(tree, &tree.root(), 0, walk, &mut count, &mut truncated);
    SurveyReport {
        bundle_id: bundle_id.to_string(),
        windows: tree
            .windows()
            .iter()
            .map(|w| tree.text_attr(w, "AXTitle").unwrap_or_default())
            .collect(),
        nodes: count,
        truncated,
        tree: root,
    }
}

fn nonempty<T: AxTree>(tree: &T, n: &T::Node, attr: &str) -> Option<String> {
    tree.text_attr(n, attr).filter(|s| !s.trim().is_empty())
}

fn node<T: AxTree>(
    tree: &T,
    n: &T::Node,
    depth: usize,
    walk: Walk,
    count: &mut usize,
    truncated: &mut bool,
) -> SurveyNode {
    *count += 1;
    let mut out = SurveyNode {
        role: tree.text_attr(n, "AXRole").unwrap_or_else(|| "?".to_string()),
        subrole: nonempty(tree, n, "AXSubrole"),
        title: nonempty(tree, n, "AXTitle"),
        description: nonempty(tree, n, "AXDescription"),
        identifier: nonempty(tree, n, "AXIdentifier"),
        value: nonempty(tree, n, "AXValue").map(|v| v.chars().take(VALUE_PREVIEW).collect()),
        children: Vec::new(),
        cut: false,
    };
    let kids = tree.children(n);
    if kids.is_empty() {
        return out;
    }
    if depth >= walk.max_depth {
        out.cut = true;
        *truncated = true;
        return out;
    }
    for k in &kids {
        if *count >= walk.max_nodes {
            out.cut = true;
            *truncated = true;
            break;
        }
        out.children.push(node(tree, k, depth + 1, walk, count, truncated));
    }
    out
}

pub fn controls<T: AxTree>(tree: &T, walk: Walk) -> (Vec<String>, bool) {
    let mut out = Vec::new();
    let mut visited = 0usize;
    let mut stack: Vec<(T::Node, usize)> = tree.windows().into_iter().rev().map(|w| (w, 0)).collect();
    while let Some((n, depth)) = stack.pop() {
        if visited >= walk.max_nodes {
            return (out, true);
        }
        visited += 1;
        let role = tree.text_attr(&n, "AXRole").unwrap_or_default();
        if PRESSABLE.contains(&role.as_str())
            && let Some(l) = label_of(tree, &n)
        {
            out.push(l);
        }
        if depth < walk.max_depth {
            for k in tree.children(&n).into_iter().rev() {
                stack.push((k, depth + 1));
            }
        }
    }
    (out, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::{El, FakeTree};

    fn app() -> FakeTree {
        FakeTree::new(El::app("Calculator").children([
            El::new("AXMenuBar").child(El::new("AXMenuBarItem").title("File")),
            El::window("Calculator").children([
                El::new("AXStaticText").value(&"9".repeat(500)),
                El::new("AXButton").description("All Clear"),
                El::new("AXButton").title("=").description("equals"),
                El::new("AXButton"),
                El::new("AXCheckBox").title("Scientific"),
            ]),
        ]))
    }

    #[test]
    fn a_survey_names_windows_counts_nodes_and_clips_long_values() {
        let s = survey(&app(), "com.apple.calculator", Walk::default());
        assert_eq!(s.windows, vec!["Calculator".to_string()]);
        assert_eq!(s.nodes, 9);
        assert!(!s.truncated);
        let text = &s.tree.children[1].children[0];
        assert_eq!(text.value.as_ref().unwrap().len(), VALUE_PREVIEW);
    }

    #[test]
    fn a_survey_cut_by_the_node_cap_says_where() {
        let s = survey(&app(), "x.y", Walk { max_nodes: 3, max_depth: 64 });
        assert!(s.truncated);
        assert_eq!(s.nodes, 3);
        let j = serde_json::to_value(&s).unwrap();
        assert!(j.to_string().contains("\"cut\":true"));
    }

    #[test]
    fn controls_are_labelled_pressables_inside_windows_only() {
        let (c, cut) = controls(&app(), Walk::default());
        assert_eq!(c, vec!["All Clear", "=", "Scientific"]);
        assert!(!cut);
    }
}
