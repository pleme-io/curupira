//! The read emitter's found/empty/absent verdicts (kotae), run in a real browser.
//! A read never lies about which of the three happened — that distinction is the
//! whole point, so it is exercised against a fixture with all three shapes.

use curupira_e2e::{eval_json, with_fixture};
use curupira_sites::emit::emit_read_bounded;
use curupira_sites::profile::{Locator, Read, ReadKind};

const FIXTURE: &str = r#"
<!doctype html><html><body>
  <div id="present">a real value</div>
  <div id="blank"></div>
  <ul id="rows"><li>one</li><li>two</li></ul>
</body></html>
"#;

fn read(name: &str, sel: &str, kind: ReadKind) -> Read {
    Read { name: name.into(), locator: Locator::Selector(sel.into()), kind }
}

#[tokio::test]
async fn read_reports_found_empty_and_absent_distinctly() {
    with_fixture(FIXTURE, |page| async move {
        let found = eval_json(&page, &emit_read_bounded(&read("p", "#present", ReadKind::Text), 20_000).unwrap()).await;
        assert_eq!(found["status"], "found", "present element: {found}");
        assert_eq!(found["value"], "a real value");

        let empty = eval_json(&page, &emit_read_bounded(&read("b", "#blank", ReadKind::Text), 20_000).unwrap()).await;
        assert_eq!(empty["status"], "empty", "blank element is EMPTY, not absent: {empty}");

        let absent = eval_json(&page, &emit_read_bounded(&read("x", "#nope", ReadKind::Text), 20_000).unwrap()).await;
        assert_eq!(absent["status"], "absent", "missing element is ABSENT, not empty: {absent}");

        let rows = eval_json(&page, &emit_read_bounded(&read("r", "#rows li", ReadKind::TextAll), 20_000).unwrap()).await;
        assert_eq!(rows["status"], "found", "rows: {rows}");
        assert_eq!(rows["value"].as_array().map(|a| a.len()), Some(2), "two rows: {rows}");
    })
    .await;
}

#[tokio::test]
async fn read_bounded_truncates_and_reports_the_cut() {
    // A long value is truncated, and the read STATES it truncated rather than
    // silently returning a partial that reads as complete.
    let big_html = format!(r#"<!doctype html><body><div id="big">{}</div></body>"#, "x".repeat(50));
    let big: &str = &big_html;
    with_fixture(big, |page| async move {
        let r = eval_json(&page, &emit_read_bounded(&read("big", "#big", ReadKind::Text), 10).unwrap()).await;
        assert_eq!(r["status"], "found");
        assert_eq!(r["truncated"], true, "must report the cut: {r}");
        assert_eq!(r["totalLen"], 50);
        assert_eq!(r["value"].as_str().map(str::len), Some(10));
    })
    .await;
}
