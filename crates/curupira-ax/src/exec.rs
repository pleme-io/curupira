use serde::{Deserialize, Serialize};

use curupira_sites::app::{AxAction, AxOp, AxPerform, AxReady};
use curupira_sites::profile::Effect;
use curupira_sites::testplan::{CaseResult, CompiledAppTest, judge_case};
use curupira_sites::toolgen::{READY_POLL_MS, READY_TIMEOUT_MS};

use crate::read::{ReadReport, read};
use crate::resolve::resolve;
use crate::survey::{SurveyReport, controls, survey};
use crate::tree::{AxTree, Fault, Walk};

pub const GRANT_PATH: &str = "System Settings › Privacy & Security › Accessibility";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Trust {
    Trusted,
    NotTrusted,
    Unsupported(String),
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Responsible {
    pub process: Option<String>,
    pub app: Option<String>,
}

impl Responsible {
    #[must_use]
    pub fn from_process(path: Option<String>) -> Self {
        let app = path.as_deref().and_then(|p| {
            p.find(".app/").map(|i| p[..i + 4].to_string())
        });
        Self { process: path, app }
    }

    fn named(&self) -> String {
        self.app
            .clone()
            .or_else(|| self.process.clone())
            .unwrap_or_else(|| "the app that launched this process (it could not be identified)".to_string())
    }
}

pub enum Opened<T> {
    App(T),
    NotRunning,
    Unsupported(String),
    Fault(String),
}

pub trait Host {
    type Tree: AxTree;

    fn trust(&self) -> Trust;
    fn responsible(&self) -> Responsible;
    fn open(&self, bundle_id: &str, launch: bool) -> Opened<Self::Tree>;
    fn now_ms(&self) -> u64;
    fn sleep_ms(&self, ms: u64);
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "outcome", rename_all = "kebab-case")]
pub enum Response {
    Trusted {
        responsible: Responsible,
    },
    NotTrusted {
        grant: String,
        responsible: Responsible,
        remedy: String,
    },
    Unsupported {
        reason: String,
    },
    AppNotRunning {
        bundle_id: String,
        remedy: String,
    },
    Ready {
        ready: bool,
        #[serde(rename = "waitedMs")]
        waited_ms: u64,
        unmet: Vec<String>,
    },
    Read(ReadReport),
    Acted {
        action: String,
        performed: AxPerform,
        #[serde(skip_serializing_if = "Option::is_none")]
        authorized_by: Option<String>,
    },
    Absent {
        action: String,
        locator: String,
        walk_truncated: bool,
    },
    Ambiguous {
        action: String,
        locator: String,
        matches: usize,
    },
    Refused {
        reason: String,
    },
    Survey(SurveyReport),
    Tests(TestsReport),
    Fault {
        code: i32,
        message: String,
    },
    InvalidRequest {
        message: String,
    },
}

impl Response {
    #[must_use]
    pub fn exit_code(&self) -> i32 {
        match self {
            Response::Trusted { .. }
            | Response::Read(_)
            | Response::Acted { .. }
            | Response::Survey(_)
            | Response::Ready { ready: true, .. } => 0,
            Response::Tests(t) if t.failed == 0 => 0,
            Response::Tests(_) => 3,
            Response::InvalidRequest { .. } => 64,
            _ => 2,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TestsReport {
    pub bundle_id: String,
    pub total: usize,
    pub passed: usize,
    pub failed: usize,
    pub cases: Vec<CaseResult>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verb {
    Goto,
    Read,
    Act,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub bundle_id: String,
    pub op: AxOp,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub launch: bool,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TestsRequest {
    pub bundle_id: String,
    pub tests: Vec<CompiledAppTest>,
    #[serde(default)]
    pub launch: bool,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

fn not_trusted(host: &impl Host) -> Response {
    let responsible = host.responsible();
    let remedy = format!(
        "Open {GRANT_PATH} and enable {}. macOS attributes Accessibility use to the responsible \
         process — the app at the top of the launch chain — not to curupira-ax itself, so that is \
         the entry that needs the switch. Restart it afterwards.",
        responsible.named()
    );
    Response::NotTrusted { grant: GRANT_PATH.to_string(), responsible, remedy }
}

fn fault(f: &Fault, host: &impl Host) -> Response {
    if f.is_api_disabled() {
        not_trusted(host)
    } else {
        Response::Fault { code: f.code, message: f.message.clone() }
    }
}

fn with_app<H: Host>(
    host: &H,
    bundle_id: &str,
    launch: bool,
    f: impl FnOnce(&H::Tree) -> Response,
) -> Response {
    match host.trust() {
        Trust::Trusted => {}
        Trust::NotTrusted => return not_trusted(host),
        Trust::Unsupported(reason) => return Response::Unsupported { reason },
    }
    match host.open(bundle_id, launch) {
        Opened::App(t) => f(&t),
        Opened::NotRunning => Response::AppNotRunning {
            bundle_id: bundle_id.to_string(),
            remedy: format!(
                "{bundle_id} is not running; start it (open -b {bundle_id}) or pass launch: true to goto"
            ),
        },
        Opened::Unsupported(reason) => Response::Unsupported { reason },
        Opened::Fault(message) => Response::Fault { code: 0, message },
    }
}

#[must_use]
pub fn trusted(host: &impl Host) -> Response {
    match host.trust() {
        Trust::Trusted => Response::Trusted { responsible: host.responsible() },
        Trust::NotTrusted => not_trusted(host),
        Trust::Unsupported(reason) => Response::Unsupported { reason },
    }
}

pub fn execute<H: Host>(host: &H, verb: Verb, req: &Request, authorized_by: Option<&str>) -> Response {
    let grant = authorized_by.map(str::trim).filter(|g| !g.is_empty());
    match (verb, &req.op) {
        (Verb::Goto, AxOp::Ready { ready }) => {
            let timeout = req.timeout_ms.unwrap_or(READY_TIMEOUT_MS);
            with_app(host, &req.bundle_id, req.launch, |t| {
                let _ = t.activate();
                wait_ready(host, t, ready, timeout)
            })
        }
        (Verb::Read, AxOp::Read { read: spec, limit }) => {
            with_app(host, &req.bundle_id, false, |t| Response::Read(read(t, spec, *limit, Walk::default())))
        }
        (Verb::Act, AxOp::Act { action }) => {
            if let Some(refusal) = gate(action, grant, req.value.as_deref()) {
                return refusal;
            }
            with_app(host, &req.bundle_id, false, |t| act(host, t, action, grant, req.value.as_deref()))
        }
        (v, op) => Response::InvalidRequest {
            message: format!(
                "the {} verb cannot run a '{}' op",
                match v {
                    Verb::Goto => "goto",
                    Verb::Read => "read",
                    Verb::Act => "act",
                },
                match op {
                    AxOp::Ready { .. } => "ready",
                    AxOp::Read { .. } => "read",
                    AxOp::Act { .. } => "act",
                }
            ),
        },
    }
}

fn gate(action: &AxAction, grant: Option<&str>, value: Option<&str>) -> Option<Response> {
    if action.effect == Effect::Mutate && grant.is_none() {
        return Some(Response::Refused {
            reason: format!(
                "'{}' MUTATES the host ({}). Pass --authorized-by with the operator's explicit \
                 go-ahead for this specific action.",
                action.name,
                if action.describes.is_empty() { "changes state" } else { &action.describes }
            ),
        });
    }
    if action.perform == AxPerform::SetValue && value.is_none() {
        return Some(Response::Refused {
            reason: format!("'{}' sets a value and needs one: pass value in the request", action.name),
        });
    }
    None
}

fn act<H: Host>(
    host: &H,
    tree: &H::Tree,
    action: &AxAction,
    grant: Option<&str>,
    value: Option<&str>,
) -> Response {
    let res = resolve(tree, &action.locator, Walk::default());
    let locator = action.locator.to_string();
    match res.matches.as_slice() {
        [] => Response::Absent { action: action.name.clone(), locator, walk_truncated: res.truncated },
        [one] => {
            let done = match action.perform {
                AxPerform::Press => tree.press(one),
                AxPerform::SetValue => tree.set_value(one, value.unwrap_or_default()),
            };
            match done {
                Ok(()) => Response::Acted {
                    action: action.name.clone(),
                    performed: action.perform,
                    authorized_by: grant.map(str::to_string),
                },
                Err(f) => fault(&f, host),
            }
        }
        many => Response::Ambiguous { action: action.name.clone(), locator, matches: many.len() },
    }
}

pub fn unmet<T: AxTree>(tree: &T, ready: &[AxReady]) -> Vec<String> {
    ready
        .iter()
        .filter(|s| match s {
            AxReady::WindowTitle(m) => !tree
                .windows()
                .iter()
                .any(|w| tree.text_attr(w, "AXTitle").is_some_and(|t| m.matches(&t))),
            AxReady::ElementPresent(l) => resolve(tree, l, Walk::default()).matches.is_empty(),
        })
        .map(AxReady::label)
        .collect()
}

pub fn wait_ready<H: Host>(host: &H, tree: &H::Tree, ready: &[AxReady], timeout_ms: u64) -> Response {
    let t0 = host.now_ms();
    loop {
        let missing = unmet(tree, ready);
        let waited = host.now_ms().saturating_sub(t0);
        if missing.is_empty() {
            return Response::Ready { ready: true, waited_ms: waited, unmet: missing };
        }
        if waited >= timeout_ms {
            return Response::Ready { ready: false, waited_ms: waited, unmet: missing };
        }
        host.sleep_ms(READY_POLL_MS);
    }
}

pub fn survey_app<H: Host>(host: &H, bundle_id: &str, launch: bool, walk: Walk) -> Response {
    with_app(host, bundle_id, launch, |t| Response::Survey(survey(t, bundle_id, walk)))
}

pub fn run_tests<H: Host>(host: &H, req: &TestsRequest) -> Response {
    let timeout = req.timeout_ms.unwrap_or(READY_TIMEOUT_MS);
    with_app(host, &req.bundle_id, req.launch, |t| {
        let cases: Vec<CaseResult> = req
            .tests
            .iter()
            .map(|case| {
                let _ = t.activate();
                let settled = matches!(wait_ready(host, t, &case.ready, timeout), Response::Ready { ready: true, .. });
                let (found, _) = controls(t, Walk::default());
                let survey = serde_json::json!({
                    "controls": found.iter().map(|c| serde_json::json!({ "text": c })).collect::<Vec<_>>(),
                    "routes": [],
                    "settled": settled,
                });
                let reads: Vec<serde_json::Value> = case
                    .read_checks
                    .iter()
                    .map(|c| serde_json::to_value(read(t, &c.op, c.limit, Walk::default())).unwrap_or_default())
                    .collect();
                judge_case(case, &survey, &reads)
            })
            .collect();
        let passed = cases.iter().filter(|c| c.passed).count();
        Response::Tests(TestsReport {
            bundle_id: req.bundle_id.clone(),
            total: cases.len(),
            passed,
            failed: cases.len() - passed,
            cases,
        })
    })
}
