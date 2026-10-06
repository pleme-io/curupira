#![cfg(target_os = "macos")]

use curupira_ax::exec::{self, Response, TestsRequest};
use curupira_ax::system::{SystemHost, running_pid};
use curupira_sites::Profile;

#[test]
#[ignore = "needs a logged-in macOS session"]
fn finder_is_found_by_bundle_id_without_any_grant() {
    let pid = running_pid("com.apple.finder").expect("Finder runs in every logged-in session");
    assert!(pid > 0);
    assert!(running_pid("invalid.example.not-an-app").is_none());
}

#[test]
#[ignore = "needs the Accessibility grant for the responsible app; run with --ignored"]
fn the_example_profile_suite_passes_against_the_real_calculator() {
    let host = SystemHost::default();
    let trust = exec::trusted(&host);
    assert!(
        matches!(trust, Response::Trusted { .. }),
        "not trusted, so this test cannot run: {}",
        serde_json::to_string(&trust).unwrap()
    );
    let Profile::MacosApp(p) =
        Profile::from_yaml(include_str!("../../../sites/example-macos-app.yaml")).unwrap()
    else {
        panic!("the example is a macos-app profile");
    };
    let req = TestsRequest {
        bundle_id: p.bundle_id.clone(),
        tests: curupira_sites::testplan::compile_app(&p),
        launch: true,
        timeout_ms: None,
    };
    let res = exec::run_tests(&host, &req);
    let json = serde_json::to_string_pretty(&res).unwrap();
    assert!(matches!(&res, Response::Tests(t) if t.failed == 0 && t.total > 0), "{json}");
}
