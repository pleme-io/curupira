use serde::Serialize;
use serde_json::Value;

use curupira_sites::app::AxRead;
use curupira_sites::profile::{Outcome, ReadKind};

use crate::resolve::resolve;
use crate::tree::{AxTree, Walk, text_of};

const CELL_DEPTH: usize = 4;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadReport {
    pub status: Outcome,
    pub value: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_len: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub returned_len: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_items: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub returned_items: Option<usize>,
    pub matches: usize,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub walk_truncated: bool,
}

impl ReadReport {
    fn new(status: Outcome, value: Value, matches: usize, walk_truncated: bool) -> Self {
        Self {
            status,
            value,
            truncated: None,
            total_len: None,
            returned_len: None,
            total_items: None,
            returned_items: None,
            matches,
            walk_truncated,
        }
    }
}

pub fn read<T: AxTree>(tree: &T, spec: &AxRead, limit: usize, walk: Walk) -> ReadReport {
    let res = resolve(tree, &spec.locator, walk);
    let n = res.matches.len();
    let first = res.matches.first();
    let (present, value) = match &spec.kind {
        ReadKind::Count => (true, Value::from(n)),
        ReadKind::Text => (n > 0, first.and_then(|f| text_of(tree, f)).map_or(Value::Null, Value::String)),
        ReadKind::TextAll => (
            n > 0,
            Value::Array(
                res.matches
                    .iter()
                    .map(|m| Value::String(text_of(tree, m).unwrap_or_default()))
                    .collect(),
            ),
        ),
        ReadKind::Attribute(name) => (n > 0, first.map_or(Value::Null, |f| tree.attr(f, name).json())),
        ReadKind::Table => (n > 0, first.map_or(Value::Null, |f| table(tree, f))),
    };
    shape(present, value, limit, n, res.truncated)
}

#[must_use]
pub fn shape(present: bool, value: Value, limit: usize, matches: usize, walk_truncated: bool) -> ReadReport {
    if !present {
        return ReadReport::new(Outcome::Absent, Value::Null, matches, walk_truncated);
    }
    let empty = match &value {
        Value::Null => true,
        Value::String(s) => s.is_empty(),
        Value::Array(a) => a.is_empty(),
        _ => false,
    };
    if empty {
        return ReadReport::new(Outcome::Empty, value, matches, walk_truncated);
    }
    let mut r = ReadReport::new(Outcome::Found, Value::Null, matches, walk_truncated);
    match value {
        Value::String(s) if s.chars().count() > limit => {
            r.truncated = Some(true);
            r.total_len = Some(s.chars().count());
            r.returned_len = Some(limit);
            r.value = Value::String(s.chars().take(limit).collect());
        }
        Value::Array(items) if json_len(&Value::Array(items.clone())) > limit => {
            let total = items.len();
            let mut used = 0usize;
            let mut keep = Vec::new();
            for row in items {
                let l = json_len(&row);
                if used + l > limit {
                    break;
                }
                used += l;
                keep.push(row);
            }
            r.truncated = Some(true);
            r.total_items = Some(total);
            r.returned_items = Some(keep.len());
            r.value = Value::Array(keep);
        }
        other => {
            r.truncated = Some(false);
            r.value = other;
        }
    }
    r
}

fn json_len(v: &Value) -> usize {
    serde_json::to_string(v).map_or(0, |s| s.chars().count())
}

fn table<T: AxTree>(tree: &T, node: &T::Node) -> Value {
    let mut rows = tree.elements(node, "AXRows");
    if rows.is_empty() {
        rows = tree
            .children(node)
            .into_iter()
            .filter(|c| tree.text_attr(c, "AXRole").as_deref() == Some("AXRow"))
            .collect();
    }
    let out: Vec<Value> = rows
        .iter()
        .map(|r| {
            Value::Array(
                tree.children(r)
                    .iter()
                    .map(|cell| Value::String(cell_text(tree, cell, CELL_DEPTH)))
                    .collect(),
            )
        })
        .filter(|r| r.as_array().is_some_and(|a| !a.is_empty()))
        .collect();
    Value::Array(out)
}

fn cell_text<T: AxTree>(tree: &T, node: &T::Node, depth: usize) -> String {
    if let Some(t) = text_of(tree, node).filter(|t| !t.is_empty()) {
        return t;
    }
    if depth == 0 {
        return String::new();
    }
    tree.children(node)
        .iter()
        .map(|c| cell_text(tree, c, depth - 1))
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::{El, FakeTree};
    use crate::tree::AttrValue;

    fn spec(json: &str) -> AxRead {
        serde_json::from_str(json).unwrap()
    }

    fn finder() -> FakeTree {
        FakeTree::new(El::app("Finder").child(El::window("Downloads").children([
            El::new("AXStaticText").value("3 items"),
            El::new("AXStaticText").value(""),
            El::new("AXTextField").identifier("search").value("").attr("AXEnabled", AttrValue::Bool(true)),
            El::new("AXOutline").children([
                El::new("AXRow").children([
                    El::new("AXCell").child(El::new("AXStaticText").value("a.txt")),
                    El::new("AXCell").child(El::new("AXStaticText").value("4 KB")),
                ]),
                El::new("AXRow").children([
                    El::new("AXCell").child(El::new("AXStaticText").value("b.txt")),
                    El::new("AXCell").child(El::new("AXStaticText").value("8 KB")),
                ]),
                El::new("AXRow"),
            ]),
        ])))
    }

    #[test]
    fn text_is_found_empty_or_absent_never_null_for_all_three() {
        let t = finder();
        let found = read(&t, &spec(r#"{"name":"n","locator":{"role":"AXStaticText","value":{"contains":"items"}},"kind":"text"}"#), 100, Walk::default());
        assert_eq!(found.status, Outcome::Found);
        assert_eq!(found.value, "3 items");
        assert_eq!(found.truncated, Some(false));
        let empty = read(&t, &spec(r#"{"name":"n","locator":{"role":"AXTextField","identifier":{"exact":"search"}},"kind":"text"}"#), 100, Walk::default());
        assert_eq!(empty.status, Outcome::Empty);
        let absent = read(&t, &spec(r#"{"name":"n","locator":{"role":"AXSheet"},"kind":"text"}"#), 100, Walk::default());
        assert_eq!(absent.status, Outcome::Absent);
        assert_eq!(absent.value, Value::Null);
        assert_eq!(absent.matches, 0);
    }

    #[test]
    fn a_count_is_never_absent_because_zero_is_the_answer() {
        let t = finder();
        let r = read(&t, &spec(r#"{"name":"n","locator":{"role":"AXSheet"},"kind":"count"}"#), 100, Walk::default());
        assert_eq!(r.status, Outcome::Found);
        assert_eq!(r.value, 0);
        let r = read(&t, &spec(r#"{"name":"n","locator":{"role":"AXRow"},"kind":"count"}"#), 100, Walk::default());
        assert_eq!(r.value, 3);
    }

    #[test]
    fn text_all_keeps_tree_order_and_reports_the_match_count() {
        let t = finder();
        let r = read(&t, &spec(r#"{"name":"n","locator":{"role":"AXStaticText","within":{"role":"AXRow"}},"kind":"text-all"}"#), 1000, Walk::default());
        assert_eq!(r.status, Outcome::Found);
        assert_eq!(r.value, serde_json::json!(["a.txt", "4 KB", "b.txt", "8 KB"]));
        assert_eq!(r.matches, 4);
    }

    #[test]
    fn a_table_reads_rows_of_cell_text_and_drops_empty_rows() {
        let t = finder();
        let r = read(&t, &spec(r#"{"name":"n","locator":{"role":"AXOutline"},"kind":"table"}"#), 1000, Walk::default());
        assert_eq!(r.value, serde_json::json!([["a.txt", "4 KB"], ["b.txt", "8 KB"]]));
    }

    #[test]
    fn an_attribute_that_is_missing_is_empty_not_absent() {
        let t = finder();
        let on = read(&t, &spec(r#"{"name":"n","locator":{"role":"AXTextField"},"kind":{"attribute":"AXEnabled"}}"#), 100, Walk::default());
        assert_eq!(on.status, Outcome::Found);
        assert_eq!(on.value, true);
        let missing = read(&t, &spec(r#"{"name":"n","locator":{"role":"AXTextField"},"kind":{"attribute":"AXHelp"}}"#), 100, Walk::default());
        assert_eq!(missing.status, Outcome::Empty);
    }

    #[test]
    fn a_long_text_is_cut_to_the_cap_and_says_how_long_it_was() {
        let long = "x".repeat(250);
        let t = FakeTree::new(El::app("A").child(El::new("AXTextArea").value(&long)));
        let r = read(&t, &spec(r#"{"name":"n","locator":{"role":"AXTextArea"},"kind":"text"}"#), 100, Walk::default());
        assert_eq!(r.truncated, Some(true));
        assert_eq!(r.total_len, Some(250));
        assert_eq!(r.returned_len, Some(100));
        assert_eq!(r.value.as_str().unwrap().len(), 100);
    }

    #[test]
    fn a_long_list_keeps_whole_items_up_to_the_cap() {
        let t = finder();
        let r = read(&t, &spec(r#"{"name":"n","locator":{"role":"AXOutline"},"kind":"table"}"#), 20, Walk::default());
        assert_eq!(r.truncated, Some(true));
        assert_eq!(r.total_items, Some(2));
        assert_eq!(r.returned_items, Some(1));
        assert_eq!(r.value, serde_json::json!([["a.txt", "4 KB"]]));
    }

    #[test]
    fn the_report_serializes_with_the_browser_reads_field_names() {
        let r = shape(true, Value::String("x".repeat(5)), 3, 1, true);
        let j = serde_json::to_value(&r).unwrap();
        assert_eq!(j["status"], "found");
        assert_eq!(j["truncated"], true);
        assert_eq!(j["totalLen"], 5);
        assert_eq!(j["returnedLen"], 3);
        assert_eq!(j["walkTruncated"], true);
        let absent = serde_json::to_value(shape(false, Value::Null, 3, 0, false)).unwrap();
        assert_eq!(absent, serde_json::json!({"status":"absent","value":null,"matches":0}));
    }
}
