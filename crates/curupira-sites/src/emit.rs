//! JS emission for the [`crate::profile`] surface.
//!
//! CDP evaluates JavaScript into the page VM by protocol definition, so a
//! browser-driving tool emits JS the way pangea emits Terraform JSON: the
//! meaning is owned in Rust, the target language is a render target. These are
//! pure functions — a plan in, a JS expression out — so what actually runs in
//! someone else's console is unit-testable without a browser.
//!
//! # Every injected value goes through `serde_json::to_string`
//!
//! Never `format!("…'{selector}'…")`. A profile's selectors and text matches are
//! operator-authored strings that routinely contain quotes (`[data-id="x"]`),
//! backslashes, and newlines. Interpolating one raw produces JS that is either a
//! syntax error or — worse — a working expression that does something other than
//! what the profile says, which is indistinguishable from the selector simply
//! not matching. `serde_json::to_string` emits a correctly-escaped JS string
//! literal for any input, so the emitted program means what the profile meant.
//! This is the fleet's typed-emission rule at its narrowest and most concrete.

use serde_json::to_string as js;

use crate::error::Result;
use crate::profile::{Locator, Read, ReadKind, ReadySignal};

/// JS expression resolving to the element a [`Locator`] names, or `null`.
///
/// `ButtonText` walks buttons and compares trimmed, case-folded text, matching
/// the driver's existing connect-button behaviour so a profile author does not
/// have to learn two different matching rules.
pub fn emit_locate(loc: &Locator) -> Result<String> {
    Ok(match loc {
        Locator::Selector(s) => format!("document.querySelector({})", js(s)?),
        Locator::ButtonText(t) => format!(
            "(Array.from(document.querySelectorAll('button,[role=\"button\"],a')) \
             .find(e => (e.textContent||'').trim().toLowerCase() === {}.toLowerCase()) || null)",
            js(t)?
        ),
    })
}

/// JS expression resolving to every element a [`Locator`] names.
pub fn emit_locate_all(loc: &Locator) -> Result<String> {
    Ok(match loc {
        Locator::Selector(s) => format!("Array.from(document.querySelectorAll({}))", js(s)?),
        Locator::ButtonText(t) => format!(
            "Array.from(document.querySelectorAll('button,[role=\"button\"],a')) \
             .filter(e => (e.textContent||'').trim().toLowerCase() === {}.toLowerCase())",
            js(t)?
        ),
    })
}

/// JS expression resolving to `true` once every signal holds.
///
/// An empty signal list yields `true` — navigation alone. That is deliberately
/// permitted (some pages have no stable marker) and deliberately weak; the
/// profile type documents it as such rather than inventing a default marker
/// that would be wrong for most consoles.
pub fn emit_ready_probe(signals: &[ReadySignal]) -> Result<String> {
    if signals.is_empty() {
        return Ok("true".to_string());
    }
    let mut parts = Vec::with_capacity(signals.len());
    for s in signals {
        parts.push(match s {
            ReadySignal::UrlContains(u) => {
                format!("location.href.includes({})", js(u)?)
            }
            ReadySignal::SelectorPresent(sel) => {
                format!("!!document.querySelector({})", js(sel)?)
            }
            ReadySignal::TextPresent(t) => {
                format!("(document.body ? document.body.innerText.includes({}) : false)", js(t)?)
            }
        });
    }
    Ok(format!("({})", parts.join(" && ")))
}

/// JS expression resolving to the JSON value a [`Read`] extracts.
///
/// `Table` walks `tr`/`th,td` rather than assuming a `<table>` element, so an
/// ARIA grid built from divs reads the same as a real table — consoles use both
/// and a profile author should not have to care which.
pub fn emit_read(read: &Read) -> Result<String> {
    let one = emit_locate(&read.locator)?;
    let all = emit_locate_all(&read.locator)?;
    Ok(match &read.kind {
        ReadKind::Text => format!("(e => e ? (e.textContent||'').trim() : null)({one})"),
        ReadKind::TextAll => format!("{all}.map(e => (e.textContent||'').trim())"),
        ReadKind::Count => format!("{all}.length"),
        ReadKind::Attribute(a) => {
            format!("(e => e ? e.getAttribute({}) : null)({one})", js(a)?)
        }
        ReadKind::Table => format!(
            "(root => root ? Array.from(root.querySelectorAll('tr,[role=\"row\"]')) \
             .map(r => Array.from(r.querySelectorAll('th,td,[role=\"cell\"],[role=\"columnheader\"]')) \
             .map(c => (c.textContent||'').trim())).filter(r => r.length) : null)({one})"
        ),
    })
}

/// JS that WAITS for the ready signals, rather than merely testing them once.
///
/// Round F1, 2026-08-21, found the gap this closes: `emit_ready_probe` returns a
/// boolean, and nothing in the engine obliged a caller to act on it. Driving a
/// hash-routed console whose content renders 400ms after the URL changes, the
/// probe correctly answered `false` — and the reads ran anyway, returning the
/// PREVIOUS page's DOM. A correct signal that nobody waits on is not a guard.
///
/// Resolves to `{ready, waitedMs, unmet}`. `unmet` names the signals still false
/// at timeout, because "the page never became ready" is useless without knowing
/// WHICH condition never held — that is the difference between a stale selector
/// and a genuinely slow backend.
pub fn emit_ready_wait(signals: &[ReadySignal], timeout_ms: u64, poll_ms: u64) -> Result<String> {
    let mut checks = Vec::with_capacity(signals.len());
    for s in signals {
        let (label, expr) = match s {
            ReadySignal::UrlContains(u) => {
                (format!("url-contains {u}"), format!("location.href.includes({})", js(u)?))
            }
            ReadySignal::SelectorPresent(sel) => {
                (format!("selector-present {sel}"), format!("!!document.querySelector({})", js(sel)?))
            }
            ReadySignal::TextPresent(t) => (
                format!("text-present {t}"),
                format!("(document.body ? document.body.innerText.includes({}) : false)", js(t)?),
            ),
        };
        checks.push(format!("{{label:{}, ok:() => {expr}}}", js(&label)?));
    }
    Ok(format!(
        "(async () => {{ const C=[{}]; const t0=Date.now(); \
         while (Date.now()-t0 < {timeout_ms}) {{ \
           const unmet=C.filter(c=>{{try{{return !c.ok()}}catch(e){{return true}}}}); \
           if (!unmet.length) return {{ready:true, waitedMs:Date.now()-t0, unmet:[]}}; \
           await new Promise(r=>setTimeout(r,{poll_ms})); }} \
         return {{ready:false, waitedMs:Date.now()-t0, \
           unmet:C.filter(c=>{{try{{return !c.ok()}}catch(e){{return true}}}}).map(c=>c.label)}}; }})()",
        checks.join(",")
    ))
}

/// A read that says WHICH of three things happened instead of returning a bare
/// value.
///
/// Round F1 exposed the ambiguity: a read returned `null`, and `null` covered
/// three different worlds — the page had not rendered, the element does not
/// exist on this page, and the element exists but holds nothing. Those need
/// different responses (wait, fix the profile, accept the result), and a caller
/// cannot tell them apart from the value alone.
///
/// Resolves to `{status, value}` where status is `absent` (the locator matched
/// nothing), `empty` (matched, but no content — a FINDING, not an error), or
/// `found`.
pub fn emit_read_checked(read: &Read) -> Result<String> {
    let inner = emit_read(read)?;
    let present = match &read.kind {
        // Count is never "absent": zero IS the answer.
        ReadKind::Count => "true".to_string(),
        ReadKind::TextAll => format!("({}).length > 0", emit_locate_all(&read.locator)?),
        _ => format!("!!{}", emit_locate(&read.locator)?),
    };
    Ok(format!(
        "(() => {{ const present = {present}; const v = {inner}; \
         if (!present) return {{status:'absent', value:null}}; \
         const empty = v === null || v === '' || (Array.isArray(v) && v.length === 0); \
         return {{status: empty ? 'empty' : 'found', value: v}}; }})()"
    ))
}

/// JS expression that clicks the located element and resolves to whether it was
/// found. Returning the boolean rather than throwing lets the caller report
/// "control not present" distinctly from "click failed", which on a console that
/// renders controls conditionally is the difference between a stale profile and
/// a permissions problem.
pub fn emit_click(loc: &Locator) -> Result<String> {
    let one = emit_locate(loc)?;
    Ok(format!("(e => {{ if (!e) return false; e.click(); return true; }})({one})"))
}

/// JS expression that activates an in-page tab by visible text.
pub fn emit_activate_tab(text: &str) -> Result<String> {
    emit_click(&Locator::ButtonText(text.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selector_values_are_json_escaped_not_interpolated() {
        // The injection this prevents: a perfectly ordinary attribute selector
        // contains double quotes. Interpolated raw it would terminate the JS
        // string early and produce either a syntax error or a DIFFERENT working
        // expression — the latter being indistinguishable from "no match".
        let loc = Locator::Selector(r#"[data-id="x"]"#.to_string());
        let out = emit_locate(&loc).unwrap();
        assert!(out.contains(r#"\"x\""#), "value must be escaped: {out}");
        assert_eq!(out.matches("document.querySelector(").count(), 1);
    }

    #[test]
    fn a_selector_carrying_a_quote_and_backslash_cannot_break_out() {
        let payload = "a\"); alert(1); //\\";
        let out = emit_locate(&Locator::Selector(payload.to_string())).unwrap();

        // Asserting the payload's TEXT is absent would be the wrong test — it is
        // present, and harmlessly so, because it is escaped. What must hold is
        // that it survives only as DATA: peel the one string literal back off
        // and it must be byte-identical to what went in. If any character had
        // escaped into live syntax, the literal would not round-trip.
        let lit = out
            .strip_prefix("document.querySelector(")
            .and_then(|s| s.strip_suffix(')'))
            .expect("emitted a single querySelector call");
        let back: String = serde_json::from_str(lit).expect("literal is well-formed JSON/JS string");
        assert_eq!(back, payload, "payload must round-trip as pure data");
    }

    #[test]
    fn empty_ready_signals_mean_navigation_alone() {
        assert_eq!(emit_ready_probe(&[]).unwrap(), "true");
    }

    #[test]
    fn ready_signals_are_conjoined() {
        let js = emit_ready_probe(&[
            ReadySignal::UrlContains("/clusters/".to_string()),
            ReadySignal::SelectorPresent(".xterm".to_string()),
        ])
        .unwrap();
        assert!(js.contains(" && "), "{js}");
        assert!(js.contains("location.href.includes"));
        assert!(js.contains("document.querySelector"));
    }

    #[test]
    fn count_read_uses_the_all_form_and_text_read_the_single_form() {
        let count = emit_read(&Read {
            name: "n".into(),
            locator: Locator::Selector(".row".into()),
            kind: ReadKind::Count,
        })
        .unwrap();
        assert!(count.ends_with(".length"), "{count}");
        assert!(count.contains("querySelectorAll"));

        let text = emit_read(&Read {
            name: "t".into(),
            locator: Locator::Selector("h1".into()),
            kind: ReadKind::Text,
        })
        .unwrap();
        assert!(text.contains("querySelector(") && !text.contains("querySelectorAll"));
    }

    #[test]
    fn table_read_handles_aria_grids_not_just_table_elements() {
        let t = emit_read(&Read {
            name: "grid".into(),
            locator: Locator::Selector("#g".into()),
            kind: ReadKind::Table,
        })
        .unwrap();
        assert!(t.contains(r#"role="row""#), "must accept ARIA rows: {t}");
        assert!(t.contains(r#"role="cell""#), "must accept ARIA cells: {t}");
    }

    #[test]
    fn attribute_read_escapes_the_attribute_name_too() {
        let a = emit_read(&Read {
            name: "a".into(),
            locator: Locator::Selector("img".into()),
            kind: ReadKind::Attribute(r#"data-"x"#.to_string()),
        })
        .unwrap();
        assert!(a.contains(r#"getAttribute("data-\"x")"#), "{a}");
    }

    #[test]
    fn click_reports_absence_rather_than_throwing() {
        let c = emit_click(&Locator::ButtonText("Delete".into())).unwrap();
        assert!(c.contains("if (!e) return false"), "{c}");
        assert!(c.contains("e.click()"));
    }

    #[test]
    fn button_text_match_is_case_insensitive_both_sides() {
        let c = emit_locate(&Locator::ButtonText("Connect".into())).unwrap();
        assert_eq!(c.matches("toLowerCase()").count(), 2, "both sides folded: {c}");
    }
}
