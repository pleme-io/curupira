use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use crate::tree::{AttrValue, AxTree, Fault};

#[derive(Debug, Clone, Default)]
pub struct El {
    attrs: BTreeMap<String, AttrValue>,
    children: Vec<El>,
    refuses: Option<i32>,
}

impl El {
    #[must_use]
    pub fn new(role: &str) -> Self {
        Self::default().attr("AXRole", AttrValue::Text(role.to_string()))
    }

    #[must_use]
    pub fn app(title: &str) -> Self {
        Self::new("AXApplication").title(title)
    }

    #[must_use]
    pub fn window(title: &str) -> Self {
        Self::new("AXWindow").title(title)
    }

    #[must_use]
    pub fn attr(mut self, name: &str, value: AttrValue) -> Self {
        self.attrs.insert(name.to_string(), value);
        self
    }

    #[must_use]
    pub fn title(self, t: &str) -> Self {
        self.attr("AXTitle", AttrValue::Text(t.to_string()))
    }

    #[must_use]
    pub fn description(self, t: &str) -> Self {
        self.attr("AXDescription", AttrValue::Text(t.to_string()))
    }

    #[must_use]
    pub fn identifier(self, t: &str) -> Self {
        self.attr("AXIdentifier", AttrValue::Text(t.to_string()))
    }

    #[must_use]
    pub fn value(self, t: &str) -> Self {
        self.attr("AXValue", AttrValue::Text(t.to_string()))
    }

    #[must_use]
    pub fn refusing(mut self, code: i32) -> Self {
        self.refuses = Some(code);
        self
    }

    #[must_use]
    pub fn child(mut self, c: El) -> Self {
        self.children.push(c);
        self
    }

    #[must_use]
    pub fn children(mut self, cs: impl IntoIterator<Item = El>) -> Self {
        self.children.extend(cs);
        self
    }
}

#[derive(Debug, Default)]
struct Node {
    attrs: BTreeMap<String, AttrValue>,
    children: Vec<usize>,
    refuses: Option<i32>,
}

#[derive(Debug, Default)]
struct State {
    nodes: Vec<Node>,
    log: Vec<String>,
    attr_reads: usize,
}

#[derive(Debug, Clone)]
pub struct FakeTree(Rc<RefCell<State>>);

impl FakeTree {
    #[must_use]
    pub fn new(app: El) -> Self {
        let mut st = State::default();
        flatten(&mut st.nodes, app);
        Self(Rc::new(RefCell::new(st)))
    }

    #[must_use]
    pub fn log(&self) -> Vec<String> {
        self.0.borrow().log.clone()
    }

    #[must_use]
    pub fn attr_reads(&self) -> usize {
        self.0.borrow().attr_reads
    }

    fn describe(&self, node: usize) -> String {
        let st = self.0.borrow();
        let n = &st.nodes[node];
        let pick = |k: &str| n.attrs.get(k).and_then(AttrValue::text).unwrap_or_default();
        format!("{}:{}", pick("AXRole"), [pick("AXTitle"), pick("AXDescription")].concat())
    }

    fn act(&self, node: usize, what: String) -> Result<(), Fault> {
        if let Some(code) = self.0.borrow().nodes[node].refuses {
            return Err(Fault::from_code(code));
        }
        self.0.borrow_mut().log.push(what);
        Ok(())
    }
}

fn flatten(nodes: &mut Vec<Node>, el: El) -> usize {
    let id = nodes.len();
    nodes.push(Node { attrs: el.attrs, children: Vec::new(), refuses: el.refuses });
    let kids: Vec<usize> = el.children.into_iter().map(|c| flatten(nodes, c)).collect();
    nodes[id].children = kids;
    id
}

impl AxTree for FakeTree {
    type Node = usize;

    fn root(&self) -> usize {
        0
    }

    fn attr(&self, node: &usize, name: &str) -> AttrValue {
        let mut st = self.0.borrow_mut();
        st.attr_reads += 1;
        st.nodes[*node].attrs.get(name).cloned().unwrap_or(AttrValue::Absent)
    }

    fn elements(&self, node: &usize, name: &str) -> Vec<usize> {
        let st = self.0.borrow();
        let kids = st.nodes[*node].children.clone();
        let role_is = |id: &usize, role: &str| {
            st.nodes[*id].attrs.get("AXRole") == Some(&AttrValue::Text(role.to_string()))
        };
        match name {
            "AXChildren" => kids,
            "AXWindows" => kids.into_iter().filter(|k| role_is(k, "AXWindow")).collect(),
            "AXRows" => kids.into_iter().filter(|k| role_is(k, "AXRow")).collect(),
            _ => Vec::new(),
        }
    }

    fn press(&self, node: &usize) -> Result<(), Fault> {
        let d = self.describe(*node);
        self.act(*node, format!("press {d}"))
    }

    fn set_value(&self, node: &usize, value: &str) -> Result<(), Fault> {
        let d = self.describe(*node);
        self.act(*node, format!("set {d} = {value}"))?;
        self.0.borrow_mut().nodes[*node]
            .attrs
            .insert("AXValue".to_string(), AttrValue::Text(value.to_string()));
        Ok(())
    }

    fn activate(&self) -> Result<(), Fault> {
        self.0.borrow_mut().log.push("activate".to_string());
        Ok(())
    }
}

pub struct FakeHost {
    pub trust: crate::exec::Trust,
    pub app: Option<FakeTree>,
    pub launchable: bool,
    pub responsible: Option<String>,
    clock: std::cell::Cell<u64>,
    opened: RefCell<Vec<(String, bool)>>,
}

impl FakeHost {
    #[must_use]
    pub fn running(tree: FakeTree) -> Self {
        Self {
            trust: crate::exec::Trust::Trusted,
            app: Some(tree),
            launchable: false,
            responsible: Some("/Users/x/Applications/Mado.app/Contents/MacOS/mado".to_string()),
            clock: std::cell::Cell::new(0),
            opened: RefCell::new(Vec::new()),
        }
    }

    #[must_use]
    pub fn opened(&self) -> Vec<(String, bool)> {
        self.opened.borrow().clone()
    }
}

impl crate::exec::Host for FakeHost {
    type Tree = FakeTree;

    fn trust(&self) -> crate::exec::Trust {
        self.trust.clone()
    }

    fn responsible(&self) -> crate::exec::Responsible {
        crate::exec::Responsible::from_process(self.responsible.clone())
    }

    fn open(&self, bundle_id: &str, launch: bool) -> crate::exec::Opened<FakeTree> {
        self.opened.borrow_mut().push((bundle_id.to_string(), launch));
        match &self.app {
            Some(t) if !self.launchable || launch => crate::exec::Opened::App(t.clone()),
            _ => crate::exec::Opened::NotRunning,
        }
    }

    fn now_ms(&self) -> u64 {
        self.clock.get()
    }

    fn sleep_ms(&self, ms: u64) {
        self.clock.set(self.clock.get() + ms);
    }
}
