use curupira_ax::exec::{self, Request, Response, TestsRequest, Trust, Verb};
use curupira_ax::fake::{El, FakeHost, FakeTree};
use curupira_ax::tree::AX_API_DISABLED;
use curupira_sites::Profile;
use curupira_sites::app::AppProfile;
use curupira_sites::toolgen::{Bundle, SiteTarget};
use serde_json::json;

fn calculator() -> FakeTree {
    FakeTree::new(El::app("Calculator").children([
        El::new("AXMenuBar").child(El::new("AXMenuBarItem").title("Edit")),
        El::window("Calculator").children([
            El::new("AXGroup").child(El::new("AXStaticText").value("0")),
            El::new("AXGroup").children([
                El::new("AXButton").description("All Clear"),
                El::new("AXButton").description("1"),
                El::new("AXButton").description("Add"),
            ]),
        ]),
    ]))
}

fn example() -> AppProfile {
    match Profile::from_yaml(include_str!("../../../sites/example-macos-app.yaml")).unwrap() {
        Profile::MacosApp(p) => p,
        Profile::Browser(_) => panic!("the example is a macos-app profile"),
    }
}

fn op(view: &str, kind: &str, leaf: &str) -> serde_json::Value {
    let b = Bundle::compile(&[example().into()]).unwrap();
    let name = format!("example_calculator_{view}_{kind}{}", if leaf.is_empty() { String::new() } else { format!("_{leaf}") });
    let tool = b.sites[0].tools.iter().find(|t| t.name == name).unwrap_or_else(|| panic!("{name}"));
    serde_json::to_value(tool.program.ax().unwrap()).unwrap()
}

fn request(op: &serde_json::Value, extra: &serde_json::Value) -> Request {
    let mut v = json!({ "bundle_id": "com.apple.calculator", "op": op });
    for (k, x) in extra.as_object().unwrap() {
        v[k] = x.clone();
    }
    serde_json::from_value(v).unwrap()
}

fn outcome(r: &Response) -> serde_json::Value {
    serde_json::to_value(r).unwrap()
}

#[test]
fn a_mutating_act_without_a_grant_is_refused_before_the_app_is_touched() {
    let tree = calculator();
    let host = FakeHost::running(tree.clone());
    let r = exec::execute(&host, Verb::Act, &request(&op("keypad", "act", "clear"), &json!({})), None);
    let j = outcome(&r);
    assert_eq!(j["outcome"], "refused");
    assert!(j["reason"].as_str().unwrap().contains("discards the current calculation"));
    assert!(host.opened().is_empty(), "the gate runs before the app is opened");
    assert_eq!(tree.attr_reads(), 0);
    let blank = exec::execute(&host, Verb::Act, &request(&op("keypad", "act", "clear"), &json!({})), Some("   "));
    assert_eq!(outcome(&blank)["outcome"], "refused");
}

#[test]
fn a_mutating_act_with_a_grant_presses_the_one_matching_control() {
    let tree = calculator();
    let host = FakeHost::running(tree.clone());
    let r = exec::execute(&host, Verb::Act, &request(&op("keypad", "act", "clear"), &json!({})), Some("operator: clear it"));
    assert_eq!(
        outcome(&r),
        json!({"outcome":"acted","action":"clear","performed":"press","authorized_by":"operator: clear it"})
    );
    assert_eq!(tree.log(), vec!["press AXButton:All Clear".to_string()]);
}

#[test]
fn an_ambiguous_locator_presses_nothing_and_says_how_many_matched() {
    let tree = FakeTree::new(El::app("Calculator").child(El::window("Calculator").children([
        El::new("AXButton").description("All Clear"),
        El::new("AXButton").description("Clear"),
    ])));
    let host = FakeHost::running(tree.clone());
    let r = exec::execute(&host, Verb::Act, &request(&op("keypad", "act", "clear"), &json!({})), Some("yes"));
    let j = outcome(&r);
    assert_eq!(j["outcome"], "ambiguous");
    assert_eq!(j["matches"], 2);
    assert!(tree.log().is_empty());
}

#[test]
fn an_act_whose_control_is_gone_is_absent() {
    let host = FakeHost::running(FakeTree::new(El::app("Calculator").child(El::window("Calculator"))));
    let r = exec::execute(&host, Verb::Act, &request(&op("keypad", "act", "clear"), &json!({})), Some("yes"));
    assert_eq!(outcome(&r)["outcome"], "absent");
}

#[test]
fn a_set_value_act_needs_a_value_and_then_writes_it() {
    let tree = FakeTree::new(El::app("Notes").child(El::window("Notes").child(El::new("AXTextField").identifier("search").value(""))));
    let host = FakeHost::running(tree.clone());
    let act = json!({"op":"act","action":{"name":"search","locator":{"role":"AXTextField"},"effect":"observe","perform":"set-value"}});
    let none = exec::execute(&host, Verb::Act, &request(&act, &json!({})), None);
    assert_eq!(outcome(&none)["outcome"], "refused");
    let ok = exec::execute(&host, Verb::Act, &request(&act, &json!({"value":"groceries"})), None);
    assert_eq!(outcome(&ok)["performed"], "set-value");
    assert_eq!(tree.log(), vec!["set AXTextField: = groceries".to_string()]);
}

#[test]
fn an_app_that_refuses_the_press_for_lack_of_trust_is_reported_as_not_trusted() {
    let tree = FakeTree::new(El::app("Calculator").child(
        El::window("Calculator").child(El::new("AXButton").description("All Clear").refusing(AX_API_DISABLED)),
    ));
    let host = FakeHost::running(tree);
    let r = exec::execute(&host, Verb::Act, &request(&op("keypad", "act", "clear"), &json!({})), Some("yes"));
    assert_eq!(outcome(&r)["outcome"], "not-trusted");
}

#[test]
fn not_trusted_names_the_grant_and_the_responsible_app() {
    let mut host = FakeHost::running(calculator());
    host.trust = Trust::NotTrusted;
    let r = exec::execute(&host, Verb::Read, &request(&op("keypad", "read", "display"), &json!({})), None);
    let j = outcome(&r);
    assert_eq!(j["outcome"], "not-trusted");
    assert_eq!(j["grant"], "System Settings › Privacy & Security › Accessibility");
    assert_eq!(j["responsible"]["app"], "/Users/x/Applications/Mado.app");
    assert!(j["remedy"].as_str().unwrap().contains("/Users/x/Applications/Mado.app"));
    assert_eq!(r.exit_code(), 2);
}

#[test]
fn an_app_that_is_not_running_is_a_typed_absence_not_an_empty_read() {
    let mut host = FakeHost::running(calculator());
    host.app = None;
    let r = exec::execute(&host, Verb::Read, &request(&op("keypad", "read", "display"), &json!({})), None);
    let j = outcome(&r);
    assert_eq!(j["outcome"], "app-not-running");
    assert_eq!(j["bundle_id"], "com.apple.calculator");
}

#[test]
fn unsupported_platforms_say_so() {
    let mut host = FakeHost::running(calculator());
    host.trust = Trust::Unsupported("linux".into());
    assert_eq!(outcome(&exec::trusted(&host))["outcome"], "unsupported");
}

#[test]
fn goto_launches_only_when_asked_then_waits_for_the_ready_signals() {
    let mut host = FakeHost::running(calculator());
    host.launchable = true;
    let no = exec::execute(&host, Verb::Goto, &request(&op("keypad", "goto", ""), &json!({})), None);
    assert_eq!(outcome(&no)["outcome"], "app-not-running");
    let yes = exec::execute(&host, Verb::Goto, &request(&op("keypad", "goto", ""), &json!({"launch": true})), None);
    assert_eq!(outcome(&yes), json!({"outcome":"ready","ready":true,"waitedMs":0,"unmet":[]}));
    assert_eq!(host.opened(), vec![("com.apple.calculator".to_string(), false), ("com.apple.calculator".to_string(), true)]);
}

#[test]
fn a_view_that_never_becomes_ready_names_the_signal_that_never_held() {
    let host = FakeHost::running(FakeTree::new(El::app("Calculator").child(El::window("Calculator"))));
    let r = exec::execute(&host, Verb::Goto, &request(&op("keypad", "goto", ""), &json!({"timeout_ms": 600})), None);
    let j = outcome(&r);
    assert_eq!(j["ready"], false);
    assert!(j["waitedMs"].as_u64().unwrap() >= 600);
    assert_eq!(j["unmet"], json!(["element-present AXWindow > AXButton"]));
    assert_eq!(r.exit_code(), 2);
}

#[test]
fn a_read_answers_with_the_verdict_and_match_count() {
    let host = FakeHost::running(calculator());
    let r = exec::execute(&host, Verb::Read, &request(&op("keypad", "read", "display"), &json!({})), None);
    assert_eq!(outcome(&r), json!({"outcome":"read","status":"found","value":"0","truncated":false,"matches":1}));
    let r = exec::execute(&host, Verb::Read, &request(&op("keypad", "read", "sheet"), &json!({})), None);
    assert_eq!(outcome(&r)["status"], "absent");
}

#[test]
fn a_verb_and_an_op_that_disagree_are_an_invalid_request() {
    let host = FakeHost::running(calculator());
    let r = exec::execute(&host, Verb::Act, &request(&op("keypad", "read", "display"), &json!({})), Some("yes"));
    assert_eq!(outcome(&r)["outcome"], "invalid-request");
    assert_eq!(r.exit_code(), 64);
}

#[test]
fn the_example_suite_passes_on_a_tree_shaped_like_calculator() {
    let host = FakeHost::running(calculator());
    let b = Bundle::compile(&[example().into()]).unwrap();
    let SiteTarget::MacosApp { bundle_id, tests } = &b.sites[0].target else { panic!() };
    let req = TestsRequest { bundle_id: bundle_id.clone(), tests: tests.clone(), launch: false, timeout_ms: Some(300) };
    let r = exec::run_tests(&host, &req);
    let j = outcome(&r);
    assert_eq!(j["outcome"], "tests");
    assert_eq!(j["failed"], 0, "{j}");
    assert_eq!(j["passed"], 1);
    assert_eq!(r.exit_code(), 0);
}

#[test]
fn a_suite_on_an_unready_app_fails_by_name_rather_than_reading_stale_ui() {
    let host = FakeHost::running(FakeTree::new(El::app("Calculator").child(El::window("Calculator").child(El::new("AXSheet").value("x")))));
    let req: TestsRequest = serde_json::from_value(json!({
        "bundle_id": "com.apple.calculator",
        "timeout_ms": 300,
        "tests": [{
            "name": "keypad renders",
            "view": "keypad",
            "ready": [{"element-present": {"role": "AXButton"}}],
            "expect_controls": ["All Clear"],
            "read_checks": [{"read":"sheet","op":{"name":"sheet","locator":{"role":"AXSheet"},"kind":"text"},"limit":100,"expect_status":"absent"}]
        }]
    }))
    .unwrap();
    let j = outcome(&exec::run_tests(&host, &req));
    assert_eq!(j["failed"], 1);
    assert_eq!(
        j["cases"][0]["failures"],
        json!([
            "expected control 'All Clear' not present",
            "page did not settle",
            "read 'sheet': expected absent, got found"
        ])
    );
}
