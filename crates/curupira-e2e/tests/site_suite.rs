//! A site's qualifying suite, compiled from its profile and run end-to-end in a
//! real browser against a fixture — proving the compile→execute→judge path the
//! MCP server will run per-site.

use curupira_e2e::{run_case_on_page, with_fixture};
use curupira_sites::profile::{
    ConsoleProfile, Locator, Outcome, Page, PageTest, Read, ReadExpect, ReadKind, ReadySignal,
};
use curupira_sites::testplan;

const SIGNIN_FIXTURE: &str = r#"
<!doctype html><html><body>
  <button>Sign in</button>
  <button>Access Key</button>
  <a href="/registration">Register</a>
  <h1 id="head">Manage secrets</h1>
  <div id="blank"></div>
</body></html>
"#;

fn signin_profile() -> ConsoleProfile {
    // A minimal profile whose one page carries a couple of reads and a qualifying
    // test that asserts the sign-in structure.
    let page = Page {
        name: "sign-in".into(),
        route: "/".into(),
        tab: None,
        ready: vec![ReadySignal::SelectorPresent("body".into())],
        reads: vec![
            Read { name: "heading".into(), locator: Locator::Selector("#head".into()), kind: ReadKind::Text },
            Read { name: "blank".into(), locator: Locator::Selector("#blank".into()), kind: ReadKind::Text },
        ],
        actions: vec![],
    };
    let test = PageTest {
        name: "sign-in surface".into(),
        page: "sign-in".into(),
        expect_controls: vec!["Sign in".into(), "Access Key".into()],
        expect_routes: vec!["/registration".into()],
        expect_reads: vec![
            ReadExpect { read: "heading".into(), outcome: Outcome::Found },
            ReadExpect { read: "blank".into(), outcome: Outcome::Empty },
        ],
        must_settle: true,
    };
    let yaml = serde_yaml::to_string(&serde_json::json!({
        "id": "fixture", "base_url": "http://x", "match": [], "pages": [], "tests": []
    })).unwrap();
    let mut p: ConsoleProfile = serde_yaml::from_str(&yaml).unwrap();
    p.pages = vec![page];
    p.tests = vec![test];
    p
}

#[tokio::test]
async fn a_site_suite_compiles_runs_and_passes_against_its_fixture() {
    let profile = signin_profile();
    let compiled = testplan::compile(&profile).expect("compile suite");
    assert_eq!(compiled.len(), 1);
    let case = &compiled[0];
    let result = with_fixture(SIGNIN_FIXTURE, |page| async move {
        run_case_on_page(&page, case).await
    })
    .await;
    assert!(result.passed, "suite should pass its own fixture: {:?}", result.failures);
}

#[tokio::test]
async fn a_wrong_expectation_is_reported_not_swallowed() {
    // If the fixture omits a control the suite requires, the case must FAIL with
    // a named reason — a suite that green-lights a broken page is worse than none.
    let mut profile = signin_profile();
    profile.tests[0].expect_controls.push("Nonexistent Button".into());
    let compiled = testplan::compile(&profile).unwrap();
    let case = compiled[0].clone();
    let result = with_fixture(SIGNIN_FIXTURE, |page| async move {
        run_case_on_page(&page, &case).await
    })
    .await;
    assert!(!result.passed);
    assert!(result.failures.iter().any(|f| f.contains("Nonexistent Button")), "{:?}", result.failures);
}
