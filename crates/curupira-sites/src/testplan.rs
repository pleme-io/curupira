//! Compiling a site's [`crate::profile::PageTest`] suite into a runnable,
//! self-describing plan — and the PURE assertion logic that judges the results.
//!
//! The split is deliberate. Gathering the data needs a browser (navigate, eval),
//! and there are two executors that do it: curupira-e2e (Rust, against fixtures)
//! and the MCP server (TypeScript, against the live site). The JUDGING must be
//! identical in both, so it lives here as pure functions over the gathered JSON —
//! unit-testable without a browser, and the one source of truth for a verdict.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::emit::emit_read_checked;
use crate::mapper::emit_survey_when_settled;
use crate::error::{Result, SitesError};
use crate::app::{AppProfile, AxRead, AxReady};
use crate::emit::DEFAULT_READ_LIMIT;
use crate::profile::ConsoleProfile;

/// A compiled read-check: the JS to run and the status it must produce.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompiledReadCheck {
    /// The read's name, for the report.
    pub read: String,
    /// The JS an executor evaluates to get `{status, value}`.
    pub js: String,
    /// The `status` string the read must return (`found`/`empty`/`absent`).
    pub expect_status: String,
}

/// A compiled test case: everything an executor needs to run it and everything
/// the pure judge needs to score it. Self-contained so the bundle can carry it
/// and either executor can run it with no reference back to the profile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompiledTest {
    /// Case name, shown in the report.
    pub name: String,
    /// Where to navigate before asserting (the page's route).
    pub route: String,
    /// In-page tab to activate after navigating, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab: Option<String>,
    /// The settle-aware survey JS to evaluate.
    pub survey_js: String,
    /// Control texts that must all be present.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub expect_controls: Vec<String>,
    /// Routes that must all appear.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub expect_routes: Vec<String>,
    /// Whether the survey must report `settled`.
    #[serde(default)]
    pub must_settle: bool,
    /// The read-checks to run and score.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub read_checks: Vec<CompiledReadCheck>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompiledAxReadCheck {
    pub read: String,
    pub op: AxRead,
    pub limit: usize,
    pub expect_status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompiledAppTest {
    pub name: String,
    pub view: String,
    pub ready: Vec<AxReady>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub expect_controls: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub read_checks: Vec<CompiledAxReadCheck>,
}

pub trait Expectations {
    fn case_name(&self) -> &str;
    fn expected_controls(&self) -> &[String];
    fn expected_routes(&self) -> &[String];
    fn must_settle(&self) -> bool;
    fn read_expectations(&self) -> Vec<(&str, &str)>;
}

impl Expectations for CompiledTest {
    fn case_name(&self) -> &str {
        &self.name
    }
    fn expected_controls(&self) -> &[String] {
        &self.expect_controls
    }
    fn expected_routes(&self) -> &[String] {
        &self.expect_routes
    }
    fn must_settle(&self) -> bool {
        self.must_settle
    }
    fn read_expectations(&self) -> Vec<(&str, &str)> {
        self.read_checks.iter().map(|c| (c.read.as_str(), c.expect_status.as_str())).collect()
    }
}

impl Expectations for CompiledAppTest {
    fn case_name(&self) -> &str {
        &self.name
    }
    fn expected_controls(&self) -> &[String] {
        &self.expect_controls
    }
    fn expected_routes(&self) -> &[String] {
        &[]
    }
    fn must_settle(&self) -> bool {
        true
    }
    fn read_expectations(&self) -> Vec<(&str, &str)> {
        self.read_checks.iter().map(|c| (c.read.as_str(), c.expect_status.as_str())).collect()
    }
}

#[must_use]
pub fn compile_app(profile: &AppProfile) -> Vec<CompiledAppTest> {
    profile
        .tests
        .iter()
        .filter_map(|t| {
            let view = profile.view(&t.view)?;
            let read_checks = t
                .expect_reads
                .iter()
                .filter_map(|er| {
                    let read = view.reads.iter().find(|r| r.name == er.read)?;
                    Some(CompiledAxReadCheck {
                        read: er.read.clone(),
                        op: read.clone(),
                        limit: DEFAULT_READ_LIMIT,
                        expect_status: er.outcome.as_status().to_string(),
                    })
                })
                .collect();
            Some(CompiledAppTest {
                name: t.name.clone(),
                view: t.view.clone(),
                ready: view.ready.clone(),
                expect_controls: t.expect_controls.clone(),
                read_checks,
            })
        })
        .collect()
}

/// The verdict for one case.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CaseResult {
    /// The case name.
    pub name: String,
    /// True when `failures` is empty.
    pub passed: bool,
    /// One human-readable line per failed expectation; empty when passed.
    pub failures: Vec<String>,
}

/// The default survey quiet/timeout for compiled tests — long enough that a real
/// SPA settles, short enough that a fixture is instant.
const SURVEY_QUIET_MS: u64 = 250;
const SURVEY_TIMEOUT_MS: u64 = 8_000;

/// Compile a profile's whole suite into runnable cases.
///
/// # Errors
/// [`SitesError::Config`] if a test names a page or read the profile does not
/// define — a test that points at nothing is a spec error, caught here rather
/// than silently passing at run time.
pub fn compile(profile: &ConsoleProfile) -> Result<Vec<CompiledTest>> {
    profile.tests.iter().map(|t| compile_one(profile, t)).collect()
}

fn compile_one(profile: &ConsoleProfile, t: &crate::profile::PageTest) -> Result<CompiledTest> {
    let page = profile
        .pages
        .iter()
        .find(|p| p.name == t.page)
        .ok_or_else(|| SitesError::Config(format!("test '{}' names page '{}', which the profile has no page for", t.name, t.page)))?;
    let mut read_checks = Vec::with_capacity(t.expect_reads.len());
    for er in &t.expect_reads {
        let read = page
            .reads
            .iter()
            .find(|r| r.name == er.read)
            .ok_or_else(|| SitesError::Config(format!("test '{}' expects read '{}' on page '{}', which has no such read", t.name, er.read, t.page)))?;
        read_checks.push(CompiledReadCheck {
            read: er.read.clone(),
            js: emit_read_checked(read)?,
            expect_status: er.outcome.as_status().to_string(),
        });
    }
    Ok(CompiledTest {
        name: t.name.clone(),
        route: page.route.clone(),
        tab: page.tab.clone(),
        survey_js: emit_survey_when_settled(SURVEY_QUIET_MS, SURVEY_TIMEOUT_MS),
        expect_controls: t.expect_controls.clone(),
        expect_routes: t.expect_routes.clone(),
        must_settle: t.must_settle,
        read_checks,
    })
}

/// Score a case's survey result against its expectations. Pure — the one judge
/// both executors call. Returns the failure lines (empty ⇒ that part passed).
#[must_use]
pub fn judge_survey<T: Expectations + ?Sized>(test: &T, survey: &Value) -> Vec<String> {
    let mut fails = Vec::new();
    let controls: Vec<&str> = survey["controls"]
        .as_array()
        .map(|a| a.iter().filter_map(|c| c["text"].as_str()).collect())
        .unwrap_or_default();
    for want in test.expected_controls() {
        if !controls.iter().any(|c| c == want) {
            fails.push(format!("expected control '{want}' not present"));
        }
    }
    let routes: Vec<&str> = survey["routes"]
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    for want in test.expected_routes() {
        if !routes.iter().any(|r| r.contains(want.as_str())) {
            fails.push(format!("expected route '{want}' not present"));
        }
    }
    if test.must_settle() && survey["settled"] != Value::Bool(true) {
        fails.push("page did not settle".to_string());
    }
    fails
}

/// Score one read-check result. Pure. Returns a failure line, or `None` if it
/// produced the expected verdict.
#[must_use]
pub fn judge_read(check: &CompiledReadCheck, result: &Value) -> Option<String> {
    judge_status(&check.read, &check.expect_status, result)
}

fn judge_status(read: &str, expect: &str, result: &Value) -> Option<String> {
    let got = result["status"].as_str().unwrap_or("<no status>");
    if got == expect {
        None
    } else {
        Some(format!("read '{read}': expected {expect}, got {got}"))
    }
}

/// Assemble a [`CaseResult`] from the gathered data. Pure — the executor gathers
/// `survey` and one `read_results` entry per `read_checks` entry, in order.
#[must_use]
pub fn judge_case<T: Expectations + ?Sized>(
    test: &T,
    survey: &Value,
    read_results: &[Value],
) -> CaseResult {
    let mut failures = judge_survey(test, survey);
    let checks = test.read_expectations();
    for ((read, expect), result) in checks.iter().zip(read_results) {
        if let Some(f) = judge_status(read, expect, result) {
            failures.push(f);
        }
    }
    if read_results.len() != checks.len() {
        failures.push(format!(
            "executor ran {} read-checks, plan has {}",
            read_results.len(),
            checks.len()
        ));
    }
    CaseResult { name: test.case_name().to_string(), passed: failures.is_empty(), failures }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn plan() -> CompiledTest {
        CompiledTest {
            name: "signin".into(),
            route: "/".into(),
            tab: None,
            survey_js: "()=>({})".into(),
            expect_controls: vec!["Sign in".into(), "Access Key".into()],
            expect_routes: vec!["/registration".into()],
            must_settle: true,
            read_checks: vec![CompiledReadCheck {
                read: "heading".into(),
                js: "()=>({})".into(),
                expect_status: "found".into(),
            }],
        }
    }

    #[test]
    fn a_fully_matching_case_passes() {
        let survey = json!({
            "controls": [{"text":"Sign in"},{"text":"Access Key"},{"text":"Email"}],
            "routes": ["https://x/registration", "/other"],
            "settled": true
        });
        let res = judge_case(&plan(), &survey, &[json!({"status":"found"})]);
        assert!(res.passed, "{:?}", res.failures);
    }

    #[test]
    fn missing_control_route_settle_and_wrong_read_all_report() {
        let survey = json!({ "controls": [{"text":"Sign in"}], "routes": [], "settled": false });
        let res = judge_case(&plan(), &survey, &[json!({"status":"empty"})]);
        assert!(!res.passed);
        assert!(res.failures.iter().any(|f| f.contains("Access Key")), "{:?}", res.failures);
        assert!(res.failures.iter().any(|f| f.contains("/registration")), "{:?}", res.failures);
        assert!(res.failures.iter().any(|f| f.contains("settle")), "{:?}", res.failures);
        assert!(res.failures.iter().any(|f| f.contains("expected found, got empty")), "{:?}", res.failures);
    }

    #[derive(Deserialize)]
    struct SharedCase {
        test: CompiledTest,
        survey: Value,
        reads: Vec<Value>,
        expect: CaseResult,
    }

    #[test]
    fn the_shared_judge_fixture_is_judged_exactly_as_recorded() {
        let cases: Vec<SharedCase> =
            serde_json::from_str(include_str!("../fixtures/judge-cases.json")).unwrap();
        assert!(cases.len() >= 5);
        for c in cases {
            assert_eq!(judge_case(&c.test, &c.survey, &c.reads), c.expect, "{}", c.test.name);
        }
    }

    #[test]
    fn an_app_case_must_be_ready_and_has_no_routes() {
        let t = CompiledAppTest {
            name: "keypad".into(),
            view: "keypad".into(),
            ready: vec![],
            expect_controls: vec!["clear".into()],
            read_checks: vec![],
        };
        let ok = judge_case(&t, &json!({"controls":[{"text":"clear"}], "routes": [], "settled": true}), &[]);
        assert!(ok.passed, "{:?}", ok.failures);
        let not_ready = judge_case(&t, &json!({"controls":[{"text":"clear"}], "settled": false}), &[]);
        assert_eq!(not_ready.failures, vec!["page did not settle".to_string()]);
    }

    #[test]
    fn a_read_check_count_mismatch_is_a_failure() {
        // An executor that skipped a read must not let the case pass by omission.
        let survey = json!({ "controls": [{"text":"Sign in"},{"text":"Access Key"}], "routes": ["/registration"], "settled": true });
        let res = judge_case(&plan(), &survey, &[]);
        assert!(!res.passed);
        assert!(res.failures.iter().any(|f| f.contains("read-checks")), "{:?}", res.failures);
    }
}
