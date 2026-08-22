//! The survey emitter, run in a real browser against a fixture that mimics a
//! console: it must detect the visible controls, the in-page routes, and report
//! a settled page.

use curupira_e2e::{eval_json, with_fixture};
use curupira_sites::mapper;

const CONSOLE_FIXTURE: &str = r#"
<!doctype html><html><body>
  <nav>
    <button>Sign in</button>
    <button>Google</button>
    <button>Access Key</button>
    <a href="/registration">Register</a>
    <a href="/forgot-password">Forgot</a>
  </nav>
  <h1>Manage secrets</h1>
</body></html>
"#;

#[tokio::test]
async fn survey_detects_controls_and_routes() {
    with_fixture(CONSOLE_FIXTURE, |page| async move {
        let survey = eval_json(&page, &mapper::emit_survey_when_settled(50, 3000)).await;
        let controls: Vec<String> = survey["controls"]
            .as_array().unwrap_or(&vec![])
            .iter().filter_map(|c| c["text"].as_str().map(str::to_string)).collect();
        assert!(controls.iter().any(|c| c == "Sign in"), "controls: {controls:?}");
        assert!(controls.iter().any(|c| c == "Access Key"), "controls: {controls:?}");
        let routes: Vec<String> = survey["routes"]
            .as_array().unwrap_or(&vec![])
            .iter().filter_map(|r| r.as_str().map(str::to_string)).collect();
        assert!(routes.iter().any(|r| r.contains("/registration")), "routes: {routes:?}");
        assert_eq!(survey["settled"], serde_json::json!(true), "page should settle");
    })
    .await;
}
