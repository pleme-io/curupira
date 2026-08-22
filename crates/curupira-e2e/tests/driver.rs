//! The terminal driver payload installs cleanly and is idempotent — the two
//! properties a stateless tool relies on when it re-sends the payload every call.

use curupira_e2e::{eval_json, with_fixture};
use curupira_sites::terminal::DRIVER_JS;

const BARE: &str = "<!doctype html><body></body>";

#[tokio::test]
async fn driver_installs_and_is_idempotent() {
    with_fixture(BARE, |page| async move {
        // First injection installs window.WT and reports its version.
        let first = eval_json(&page, &format!("({DRIVER_JS})")).await;
        assert!(first.as_str().unwrap_or("").contains("installed") || first.as_str().unwrap_or("").contains("WT"),
                "first injection should install: {first}");
        let has_wt = eval_json(&page, "!!(window.WT && window.WT.version)").await;
        assert_eq!(has_wt, true, "window.WT must be installed");
        // Re-injection is a no-op (idempotent), the stateless-tool guarantee.
        let second = eval_json(&page, &format!("({DRIVER_JS})")).await;
        assert!(second.as_str().unwrap_or("").contains("already"),
                "re-injection must no-op, got: {second}");
    })
    .await;
}
