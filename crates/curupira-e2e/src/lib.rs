//! Test infrastructure for the browser-facing curupira engine.
//!
//! Serves fixture HTML locally and drives it with a real browser, so the JS
//! curupira-sites EMITS (survey, driver, read emitters) is exercised against real
//! DOM/JS semantics — the layer unit tests never reach. Fixtures mimic the mapped
//! console structures; no 2F/akeyless credentials are involved.

use std::io::Cursor;
use std::sync::mpsc;
use std::thread;

/// A locally-served fixture page. Dropping it stops the server.
pub struct Fixture {
    pub url: String,
    stop: Option<mpsc::Sender<()>>,
}

impl Fixture {
    /// Serve `html` on a loopback port and return its URL.
    #[must_use]
    pub fn serve(html: &str) -> Self {
        let server = tiny_http::Server::http("127.0.0.1:0").expect("bind fixture server");
        let url = format!("http://{}/", server.server_addr());
        let body = html.to_string();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        thread::spawn(move || {
            loop {
                if stop_rx.try_recv().is_ok() {
                    break;
                }
                match server.recv_timeout(std::time::Duration::from_millis(100)) {
                    Ok(Some(req)) => {
                        let resp = tiny_http::Response::new(
                            200.into(),
                            vec![tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).unwrap()],
                            Cursor::new(body.clone().into_bytes()),
                            Some(body.len()),
                            None,
                        );
                        let _ = req.respond(resp);
                    }
                    Ok(None) => {}
                    Err(_) => break,
                }
            }
        });
        Self { url, stop: Some(stop_tx) }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(s) = self.stop.take() {
            let _ = s.send(());
        }
    }
}

// ── Browser driver (chromiumoxide, pure-Rust CDP) ───────────────────────────

use chromiumoxide::browser::{Browser, BrowserConfig};
use chromiumoxide::cdp::js_protocol::runtime::EvaluateParams;
use futures::StreamExt as _;

/// Launch a headless browser, load `html` as a fixture page, run `f(page)`, tear down.
///
/// Uses the operator's Chrome/Chromium via CDP — the same protocol curupira drives.
/// Headless + isolated, so tests never touch the 2F/akeyless session.
pub async fn with_fixture<F, Fut, T>(html: &str, f: F) -> T
where
    F: FnOnce(chromiumoxide::Page) -> Fut,
    Fut: std::future::Future<Output = T>,
{
    // Browser E2E tests each launch a Chromium; parallel launches contend and
    // one fails. Serialize the browser section with a process-global lock so the
    // suite is order- and parallelism-independent.
    static BROWSER_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = BROWSER_LOCK.lock().await;
    let fx = Fixture::serve(html);
    let cfg = BrowserConfig::builder()
        .build()
        .expect("browser config");
    let (mut browser, mut handler) = Browser::launch(cfg).await.expect("launch browser");
    let drive = tokio::spawn(async move { while handler.next().await.is_some() {} });
    let page = browser.new_page(&fx.url).await.expect("open fixture");
    // fixtures are static; give the DOM a beat to parse
    page.wait_for_navigation().await.ok();
    let out = f(page).await;
    let _ = browser.close().await;
    drive.abort();
    out
}

/// Evaluate JS (expression, may return a promise) and get the JSON value back.
/// This is exactly how curupira runs the emitted payloads: `Runtime.evaluate`
/// with `awaitPromise` + `returnByValue`.
pub async fn eval_json(page: &chromiumoxide::Page, js: &str) -> serde_json::Value {
    let params = EvaluateParams::builder()
        .expression(js.to_string())
        .await_promise(true)
        .return_by_value(true)
        .build()
        .expect("eval params");
    let res = page.evaluate(params).await.expect("evaluate");
    res.value().cloned().unwrap_or(serde_json::Value::Null)
}

// ── Per-site suite: the reference executor ──────────────────────────────────

use curupira_sites::testplan::{CaseResult, CompiledTest, judge_case};

/// Run one compiled test case against a page that is ALREADY at the right route
/// (a fixture is), gathering the survey + each read result and handing them to
/// the pure judge. This is the reference executor; the MCP server's TypeScript
/// executor navigates first, then does exactly this and calls the same judge.
pub async fn run_case_on_page(page: &chromiumoxide::Page, test: &CompiledTest) -> CaseResult {
    let survey = eval_json(page, &test.survey_js).await;
    let mut reads = Vec::with_capacity(test.read_checks.len());
    for check in &test.read_checks {
        reads.push(eval_json(page, &check.js).await);
    }
    judge_case(test, &survey, &reads)
}
