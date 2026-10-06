use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum AttrValue {
    Absent,
    Text(String),
    Number(f64),
    Bool(bool),
    Other(String),
}

impl AttrValue {
    #[must_use]
    pub fn text(&self) -> Option<String> {
        match self {
            AttrValue::Absent => None,
            AttrValue::Text(s) | AttrValue::Other(s) => Some(s.clone()),
            AttrValue::Number(n) => Some(format_number(*n)),
            AttrValue::Bool(b) => Some(b.to_string()),
        }
    }

    #[must_use]
    pub fn json(&self) -> serde_json::Value {
        match self {
            AttrValue::Absent => serde_json::Value::Null,
            AttrValue::Text(s) | AttrValue::Other(s) => serde_json::Value::String(s.clone()),
            AttrValue::Number(n) => serde_json::Number::from_f64(*n)
                .map_or(serde_json::Value::Null, serde_json::Value::Number),
            AttrValue::Bool(b) => serde_json::Value::Bool(*b),
        }
    }
}

#[must_use]
pub fn format_number(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{n:.0}")
    } else {
        n.to_string()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Fault {
    pub code: i32,
    pub message: String,
}

pub const AX_API_DISABLED: i32 = -25211;

impl Fault {
    #[must_use]
    pub fn from_code(code: i32) -> Self {
        let message = match code {
            -25200 => "the accessibility call failed",
            -25201 => "illegal argument",
            -25202 => "the element no longer exists",
            -25204 => "the app did not answer in time (busy or hung)",
            -25205 => "the element does not support that attribute",
            -25206 => "the element does not support that action",
            -25208 => "not implemented by the app",
            AX_API_DISABLED => "accessibility access is not granted to the responsible process",
            -25212 => "the attribute has no value",
            _ => "unrecognised accessibility error",
        };
        Self { code, message: message.to_string() }
    }

    #[must_use]
    pub fn is_api_disabled(&self) -> bool {
        self.code == AX_API_DISABLED
    }
}

pub trait AxTree {
    type Node: Clone;

    fn root(&self) -> Self::Node;
    fn attr(&self, node: &Self::Node, name: &str) -> AttrValue;
    fn elements(&self, node: &Self::Node, name: &str) -> Vec<Self::Node>;
    fn press(&self, node: &Self::Node) -> Result<(), Fault>;
    fn set_value(&self, node: &Self::Node, value: &str) -> Result<(), Fault>;
    fn activate(&self) -> Result<(), Fault>;

    fn text_attr(&self, node: &Self::Node, name: &str) -> Option<String> {
        self.attr(node, name).text()
    }

    fn children(&self, node: &Self::Node) -> Vec<Self::Node> {
        self.elements(node, "AXChildren")
    }

    fn windows(&self) -> Vec<Self::Node> {
        self.elements(&self.root(), "AXWindows")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Walk {
    pub max_nodes: usize,
    pub max_depth: usize,
}

impl Default for Walk {
    fn default() -> Self {
        Self { max_nodes: 8_000, max_depth: 64 }
    }
}

pub fn text_of<T: AxTree>(tree: &T, node: &T::Node) -> Option<String> {
    let mut seen_empty = false;
    for name in ["AXValue", "AXTitle", "AXDescription"] {
        match tree.text_attr(node, name) {
            Some(s) if !s.trim().is_empty() => return Some(s.trim().to_string()),
            Some(_) => seen_empty = true,
            None => {}
        }
    }
    seen_empty.then(String::new)
}

pub fn label_of<T: AxTree>(tree: &T, node: &T::Node) -> Option<String> {
    ["AXTitle", "AXDescription"]
        .into_iter()
        .filter_map(|n| tree.text_attr(node, n))
        .map(|s| s.trim().to_string())
        .find(|s| !s.is_empty())
}
