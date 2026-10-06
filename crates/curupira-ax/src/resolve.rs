use curupira_sites::app::{AxLocator, TextMatch};

use crate::tree::{AxTree, Walk};

#[derive(Debug, Clone)]
pub struct Resolution<N> {
    pub matches: Vec<N>,
    pub visited: usize,
    pub truncated: bool,
}

pub fn step_matches<T: AxTree>(tree: &T, node: &T::Node, step: &AxLocator) -> bool {
    let exact = |want: &Option<String>, attr: &str| match want {
        None => true,
        Some(w) => tree.text_attr(node, attr).as_deref() == Some(w.as_str()),
    };
    let text = |want: &Option<TextMatch>, attr: &str| match want {
        None => true,
        Some(m) => tree.text_attr(node, attr).is_some_and(|v| m.matches(&v)),
    };
    exact(&step.role, "AXRole")
        && exact(&step.subrole, "AXSubrole")
        && text(&step.identifier, "AXIdentifier")
        && text(&step.title, "AXTitle")
        && text(&step.description, "AXDescription")
        && text(&step.value, "AXValue")
}

pub fn resolve<T: AxTree>(tree: &T, locator: &AxLocator, walk: Walk) -> Resolution<T::Node> {
    let chain = locator.chain();
    let last = chain.len() - 1;
    let mut matches = Vec::new();
    let mut visited = 0usize;
    let mut truncated = false;
    let mut stack = vec![(tree.root(), 0usize, 0usize)];
    while let Some((node, depth, progress)) = stack.pop() {
        if visited >= walk.max_nodes {
            truncated = true;
            break;
        }
        visited += 1;
        if progress == last && step_matches(tree, &node, chain[last]) {
            matches.push(node.clone());
        }
        let next = if progress < last && step_matches(tree, &node, chain[progress]) {
            progress + 1
        } else {
            progress
        };
        let kids = tree.children(&node);
        if kids.is_empty() {
            continue;
        }
        if depth >= walk.max_depth {
            truncated = true;
            continue;
        }
        for k in kids.into_iter().rev() {
            stack.push((k, depth + 1, next));
        }
    }
    Resolution { matches, visited, truncated }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::{El, FakeTree};

    fn loc(json: &str) -> AxLocator {
        serde_json::from_str(json).unwrap()
    }

    fn calc() -> FakeTree {
        FakeTree::new(
            El::app("Calculator").children([
                El::new("AXMenuBar").child(El::new("AXMenuBarItem").title("Edit")),
                El::window("Calculator").children([
                    El::new("AXGroup").child(El::new("AXScrollArea").child(El::new("AXStaticText").value("42"))),
                    El::new("AXGroup").children([
                        El::new("AXButton").description("All Clear"),
                        El::new("AXButton").description("1"),
                        El::new("AXButton").description("2"),
                    ]),
                ]),
                El::window("History").child(El::new("AXButton").description("All Clear")),
            ]),
        )
    }

    #[test]
    fn a_role_and_text_locator_finds_every_match_in_tree_order() {
        let t = calc();
        let r = resolve(&t, &loc(r#"{"role":"AXButton","description":{"exact":"all clear"}}"#), Walk::default());
        assert_eq!(r.matches.len(), 2);
        assert!(!r.truncated);
    }

    #[test]
    fn an_ancestor_scope_makes_the_locator_unambiguous() {
        let t = calc();
        let l = loc(r#"{"role":"AXButton","description":{"exact":"All Clear"},"within":{"role":"AXWindow","title":{"exact":"Calculator"}}}"#);
        let r = resolve(&t, &l, Walk::default());
        assert_eq!(r.matches.len(), 1);
    }

    #[test]
    fn scopes_need_not_be_direct_parents_but_must_be_in_order() {
        let t = calc();
        let ok = loc(r#"{"role":"AXStaticText","within":{"role":"AXScrollArea","within":{"role":"AXWindow"}}}"#);
        assert_eq!(resolve(&t, &ok, Walk::default()).matches.len(), 1);
        let inverted = loc(r#"{"role":"AXStaticText","within":{"role":"AXWindow","within":{"role":"AXScrollArea"}}}"#);
        assert!(resolve(&t, &inverted, Walk::default()).matches.is_empty());
    }

    #[test]
    fn prefix_and_contains_follow_the_profile_matchers() {
        let t = calc();
        assert_eq!(resolve(&t, &loc(r#"{"description":{"prefix":"all"}}"#), Walk::default()).matches.len(), 2);
        assert_eq!(resolve(&t, &loc(r#"{"description":{"contains":"clear"}}"#), Walk::default()).matches.len(), 2);
        assert_eq!(resolve(&t, &loc(r#"{"description":{"exact":"clear"}}"#), Walk::default()).matches.len(), 0);
    }

    #[test]
    fn a_node_cap_stops_the_walk_and_says_so() {
        let t = calc();
        let r = resolve(&t, &loc(r#"{"role":"AXButton"}"#), Walk { max_nodes: 4, max_depth: 64 });
        assert!(r.truncated);
        assert_eq!(r.visited, 4);
    }

    #[test]
    fn a_depth_cap_stops_the_walk_and_says_so() {
        let t = calc();
        let r = resolve(&t, &loc(r#"{"role":"AXStaticText"}"#), Walk { max_nodes: 100, max_depth: 2 });
        assert!(r.matches.is_empty());
        assert!(r.truncated);
    }
}
