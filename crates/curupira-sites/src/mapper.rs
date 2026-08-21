//! Read-only enumeration of a console's surface.
//!
//! Authoring a profile by hand means reading someone else's DOM by eye. The
//! mapper does the enumeration instead: it emits JS that walks the current page
//! for routes, controls, tables and inputs, and folds the result into a **draft**
//! profile a human then reviews.
//!
//! # It never clicks. That is the whole design constraint.
//!
//! On borrowed ground an automated crawler that clicks to "explore" is
//! catastrophic — the control it cannot classify is exactly the one most likely
//! to be destructive, and by the time you know what `Delete` did you have done
//! it. So the mapper only *reads the DOM of the page it is already on*. It does
//! not click, submit, or navigate. Discovering what is behind a control is a
//! deliberate human step, taken with a profile in hand.
//!
//! # Everything it finds is `mutate` until a human says otherwise
//!
//! [`Effect`] has no `Unknown` arm, so a discovered control must be emitted as
//! one or the other, and the safe direction is unambiguous: `mutate` means the
//! control cannot be driven without an explicit grant. Demoting one to `observe`
//! is an edit a person makes after deciding what it does — which is exactly
//! where that judgement belongs. A mapper that guessed `observe` from a label
//! like "Refresh" would be wrong the first time a console labelled a destructive
//! action mildly, and that error is unrecoverable.

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::profile::{Action, ConsoleProfile, Effect, Locator, Page, Read, ReadKind, ReadySignal};

/// One control the mapper saw, before a human classifies it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FoundControl {
    /// Visible text — how console controls are usually identified, and what
    /// survives a CSS-module class rename.
    pub text: String,
    /// `button`, `a`, or an ARIA role.
    pub kind: String,
}

/// A table or ARIA grid the mapper saw.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FoundTable {
    /// A selector that addresses it — an id when it has one, else a positional
    /// fallback the reviewer is expected to tighten.
    pub selector: String,
    pub rows: usize,
    #[serde(default)]
    pub headers: Vec<String>,
}

/// A list the mapper saw.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FoundList {
    pub selector: String,
    pub items: usize,
}

/// A heading the mapper saw.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FoundHeading {
    pub selector: String,
    pub text: String,
}

/// What one page yielded.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageSurvey {
    pub url: String,
    pub title: String,
    /// In-page links, as candidate routes.
    #[serde(default)]
    pub routes: Vec<String>,
    #[serde(default)]
    pub controls: Vec<FoundControl>,
    #[serde(default)]
    pub tables: Vec<FoundTable>,
    /// Lists — as much console content lives in `<ul>`/ARIA lists as in tables.
    #[serde(default)]
    pub lists: Vec<FoundList>,
    /// Headings: the cheapest "did the right page render" read there is.
    #[serde(default)]
    pub headings: Vec<FoundHeading>,
    /// Elements carrying a stable-looking test id — the best selectors a console
    /// offers, and worth surfacing separately because they are what a reviewer
    /// should prefer.
    #[serde(default)]
    pub test_ids: Vec<String>,

    /// Whether the DOM actually went quiet before the survey was taken.
    ///
    /// `false` means the page was still mutating at timeout, so this survey is a
    /// snapshot under motion and may be missing surface. Recorded rather than
    /// hidden: an incomplete map that looks complete is how a profile ends up
    /// silently missing half a console.
    #[serde(default)]
    pub settled: bool,

    /// How long the mapper waited before surveying.
    #[serde(default)]
    pub waited_ms: u64,
}

/// JS that surveys the CURRENT page. Reads only: no click, no submit, no
/// navigation.
///
/// Returns a [`PageSurvey`] as JSON.
#[must_use]
pub fn emit_survey() -> String {
    // Written as one expression so a caller can evaluate it exactly like any
    // other emitted read. Selector preference order is deliberate: an id, then a
    // test id, then a class — a positional nth-of-type is offered only as a last
    // resort and is flagged by being obviously fragile to whoever reviews it.
    r#"(() => {
  const txt = e => (e.textContent||'').replace(/\s+/g,' ').trim().slice(0,80);
  const sel = e => {
    if (e.id) return '#' + e.id;
    const t = e.getAttribute('data-testid');
    if (t) return '[data-testid="' + t + '"]';
    const c = (e.className && typeof e.className === 'string')
      ? e.className.trim().split(/\s+/)[0] : '';
    if (c) return e.tagName.toLowerCase() + '.' + c;
    return e.tagName.toLowerCase();
  };
  const controls = Array.from(document.querySelectorAll('button,[role="button"]'))
    .map(e => ({ text: txt(e), kind: e.tagName.toLowerCase() }))
    .filter(c => c.text);
  const routes = Array.from(document.querySelectorAll('a[href]'))
    .map(a => a.getAttribute('href')).filter(h => h && !h.startsWith('javascript:'));
  const tables = Array.from(document.querySelectorAll('table,[role="grid"],[role="table"]'))
    .map(t => {
      const rows = Array.from(t.querySelectorAll('tr,[role="row"]'));
      const head = rows.length
        ? Array.from(rows[0].querySelectorAll('th,[role="columnheader"]')).map(txt)
        : [];
      return { selector: sel(t), rows: rows.length, headers: head };
    });
  const testIds = Array.from(document.querySelectorAll('[data-testid]'))
    .map(e => e.getAttribute('data-testid'));
  // Lists are content too. A console renders as much in <ul>/<ol> and ARIA
  // lists as it does in tables, and a mapper that only knows tables reports a
  // page as having nothing to read when it is full of readable data.
  const lists = Array.from(document.querySelectorAll('ul,ol,[role="list"]'))
    .map(l => ({ selector: sel(l), items: l.querySelectorAll('li,[role="listitem"]').length }))
    .filter(l => l.items > 0);
  // Headings identify a page and are the cheapest "did the right thing render"
  // read available.
  const headings = Array.from(document.querySelectorAll('h1,h2'))
    .map(h => ({ selector: sel(h), text: txt(h) })).filter(h => h.text);
  return {
    url: location.href, title: document.title,
    routes: [...new Set(routes)], controls,
    tables, lists, headings, test_ids: [...new Set(testIds)]
  };
})()"#
        .to_string()
}

/// JS that waits for the DOM to STOP CHANGING, then surveys.
///
/// Round F5 (2026-08-21) measured why this is needed and why it cannot reuse the
/// page-ready machinery: surveying a console that renders 400ms after
/// navigation found all four routes and **zero** controls, tables and test-ids —
/// it had photographed the shell.
///
/// [`crate::emit::emit_ready_wait`] cannot help here. That waits on signals a
/// profile *declares*, and the mapper's entire job is to run where no profile
/// exists yet — there is no selector to wait for, because finding it is the
/// point. So the mapper waits on **quiescence** instead: no DOM mutations for
/// `quiet_ms`, which is the only readiness statement available about a page you
/// have never seen.
///
/// It is a heuristic and says so: the result carries `settled` and `waitedMs`,
/// so a survey taken from a page that never went quiet (a live-updating
/// dashboard, a spinner) is visibly a snapshot-under-motion rather than silently
/// passing as complete.
#[must_use]
pub fn emit_survey_when_settled(quiet_ms: u64, timeout_ms: u64) -> String {
    let survey = emit_survey();
    format!(
        "(async () => {{
  const t0 = Date.now();
  let last = Date.now();
  const obs = new MutationObserver(() => {{ last = Date.now(); }});
  obs.observe(document.documentElement, {{ childList: true, subtree: true, characterData: true }});
  let settled = false;
  while (Date.now() - t0 < {timeout_ms}) {{
    if (Date.now() - last >= {quiet_ms}) {{ settled = true; break; }}
    await new Promise(r => setTimeout(r, 50));
  }}
  obs.disconnect();
  const s = {survey};
  return Object.assign(s, {{ settled, waitedMs: Date.now() - t0 }});
}})()"
    )
}

/// Fold one or more surveys into a **draft** profile for review.
///
/// Draft in two concrete senses, both deliberate:
///
/// - `match` is left **empty**, so the draft claims no tab and is never
///   auto-selected. An unreviewed profile silently owning every URL is the wrong
///   way to fail.
/// - every discovered control is `Effect::Mutate`, so nothing it found can be
///   driven without an explicit grant.
pub fn draft_profile(id: &str, base_url: &str, surveys: &[PageSurvey]) -> Result<ConsoleProfile> {
    let mut names: Vec<String> =
        surveys.iter().enumerate().map(|(i, s)| page_name(s, base_url, i)).collect();
    uniquify(&mut names);

    let mut pages = Vec::with_capacity(surveys.len());
    for (i, s) in surveys.iter().enumerate() {
        let name = names[i].clone();
        let route = route_of(&s.url, base_url);

        let mut reads = Vec::new();
        for (n, t) in s.tables.iter().enumerate() {
            reads.push(Read {
                name: if s.tables.len() == 1 { "rows".to_string() } else { format!("rows_{n}") },
                locator: Locator::Selector(t.selector.clone()),
                kind: ReadKind::Table,
            });
        }
        for (n, l) in s.lists.iter().enumerate() {
            reads.push(Read {
                name: if s.lists.len() == 1 { "items".to_string() } else { format!("items_{n}") },
                locator: Locator::Selector(format!("{} li, {} [role=\"listitem\"]", l.selector, l.selector)),
                kind: ReadKind::TextAll,
            });
        }
        if let Some(h) = s.headings.first() {
            reads.push(Read {
                name: "heading".to_string(),
                locator: Locator::Selector(h.selector.clone()),
                kind: ReadKind::Text,
            });
        }
        for t in &s.test_ids {
            reads.push(Read {
                name: slugish(t),
                locator: Locator::Selector(format!("[data-testid=\"{t}\"]")),
                kind: ReadKind::Text,
            });
        }

        let actions = s
            .controls
            .iter()
            .map(|c| Action {
                name: slugish(stable_label(&c.text)),
                locator: match stable_label(&c.text) {
                    // A label carrying a live count is matched on its stable
                    // prefix, or the profile breaks the next time the number
                    // moves — silently, as "control not found".
                    stable if stable != c.text => Locator::ButtonTextPrefix(stable.to_string()),
                    _ => Locator::ButtonText(c.text.clone()),
                },
                effect: Effect::Mutate,
                describes: format!(
                    "UNREVIEWED — discovered by the mapper, never driven. Classified mutate \
                     because its effect is unknown; demote to observe only after deciding what \
                     '{}' actually does.",
                    c.text
                ),
            })
            .collect();

        // A ready signal the mapper can actually justify: the first table it saw
        // is content that only exists once the page rendered. Without one, the
        // lint would (correctly) refuse the draft the moment it has reads.
        // Prefer whatever content this page actually HAS as its ready signal:
        // a table, else a list, else a heading. Round F8 drafted an /events page
        // with no reads and no signal purely because it renders a <ul> rather
        // than a <table> — the page was fine, the mapper was narrow.
        let ready = s
            .tables
            .first()
            .map(|t| t.selector.clone())
            .or_else(|| s.lists.first().map(|l| l.selector.clone()))
            .or_else(|| s.headings.first().map(|h| h.selector.clone()))
            .map(|sel| vec![ReadySignal::SelectorPresent(sel)])
            .unwrap_or_default();

        pages.push(Page { name, route, tab: None, ready, reads, actions });
    }

    Ok(ConsoleProfile {
        id: id.to_string(),
        base_url: base_url.to_string(),
        match_urls: Vec::new(),
        pages,
        terminal: None,
    })
}

/// Name a drafted page from its ROUTE, not its title.
///
/// Round F8 (2026-08-21) measured why: naming from `document.title` drafted four
/// pages all called `fixture-console`, because a single-page console keeps one
/// title across every route. `ConsoleProfile::validate` refused the whole draft
/// as duplicate pages — correctly, but it means a title-named mapper produces
/// unusable drafts for most SPAs, which is most consoles.
///
/// The route is the part that actually differs, so it names the page; the title
/// is only a fallback for a route that slugs to nothing (a bare `/`).
fn page_name(s: &PageSurvey, base_url: &str, i: usize) -> String {
    let r = slugish(&route_of(&s.url, base_url));
    if !r.is_empty() {
        return r;
    }
    let t = slugish(&s.title);
    if t.is_empty() { format!("page-{i}") } else { t }
}

/// Make every name unique by suffixing repeats.
///
/// Two routes CAN slug to the same name (`/a/b` and `/a-b`). Rather than let
/// `validate` reject the whole draft — which throws away a good survey over a
/// naming collision the mapper can simply resolve — disambiguate here.
fn uniquify(names: &mut [String]) {
    let mut seen: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    for n in names.iter_mut() {
        let c = seen.entry(n.clone()).or_insert(0);
        *c += 1;
        if *c > 1 {
            *n = format!("{n}-{c}");
        }
    }
}

fn route_of(url: &str, base_url: &str) -> String {
    url.strip_prefix(base_url).map_or_else(|| url.to_string(), |r| {
        if r.starts_with('/') { r.to_string() } else { format!("/{r}") }
    })
}

/// Strip a trailing live count from a control label.
///
/// Measured on a real console 2026-08-21: `Pods · 179`, `Deployments · 75`,
/// `Services · 128`. The count moves; the noun does not. Conservative on
/// purpose — it only strips a trailing separator-plus-digits, so a control
/// legitimately named `Region 2` keeps its name unless a separator precedes the
/// number.
fn stable_label(s: &str) -> &str {
    let t = s.trim_end();
    let Some(cut) = t.rfind(|c: char| c == '\u{b7}' || c == '|' || c == '-' || c == ':') else {
        return s;
    };
    let tail = t[cut + t[cut..].chars().next().map_or(1, char::len_utf8)..].trim();
    if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit() || c == ',' || c == '.') {
        t[..cut].trim_end()
    } else {
        s
    }
}

fn slugish(s: &str) -> String {
    let mut out = String::new();
    let mut us = false;
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            us = false;
        } else if !us {
            out.push('-');
            us = true;
        }
    }
    out.trim_matches('-').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn survey() -> PageSurvey {
        PageSurvey {
            url: "https://c.example.invalid/clusters/69".into(),
            title: "Cluster 69".into(),
            routes: vec!["#/clusters".into()],
            controls: vec![
                FoundControl { text: "Refresh".into(), kind: "button".into() },
                FoundControl { text: "Delete Cluster".into(), kind: "button".into() },
            ],
            tables: vec![FoundTable {
                selector: "#pods".into(),
                rows: 3,
                headers: vec!["Pod".into(), "Phase".into()],
            }],
            lists: vec![],
            headings: vec![FoundHeading { selector: "#title".into(), text: "Cluster 69".into() }],
            test_ids: vec!["region".into()],
            settled: true,
            waited_ms: 400,
        }
    }

    #[test]
    fn the_settled_survey_also_never_clicks_or_navigates() {
        let js = emit_survey_when_settled(300, 5000);
        for forbidden in [".click(", ".submit(", "location.href =", "location.assign", "window.open"] {
            assert!(!js.contains(forbidden), "settled survey JS must not {forbidden}");
        }
        assert!(js.contains("MutationObserver"), "must wait on quiescence");
        assert!(js.contains("settled"), "must report whether it settled");
    }

    #[test]
    fn the_survey_js_never_clicks_or_navigates() {
        // The one property that must hold. A mapper that explores by clicking is
        // unusable on borrowed ground.
        let js = emit_survey();
        for forbidden in [".click(", ".submit(", "location.href =", "location.assign", "window.open"] {
            assert!(!js.contains(forbidden), "survey JS must not {forbidden}");
        }
    }

    #[test]
    fn every_discovered_control_is_mutate_until_a_human_says_otherwise() {
        let p = draft_profile("d", "https://c.example.invalid", &[survey()]).unwrap();
        let acts = &p.pages[0].actions;
        assert_eq!(acts.len(), 2);
        assert!(acts.iter().all(|a| a.effect == Effect::Mutate));
        // Including the innocuous-sounding one: a console is free to label a
        // destructive action "Refresh".
        let refresh = acts.iter().find(|a| a.name == "refresh").unwrap();
        assert_eq!(refresh.effect, Effect::Mutate);
        assert!(refresh.describes.contains("UNREVIEWED"));
    }

    #[test]
    fn a_label_carrying_a_live_count_is_matched_on_its_stable_prefix() {
        // Measured on a real console 2026-08-21: 11 of 89 control labels were
        // "Pods · 179"-shaped. An exact text match breaks the moment the count
        // moves, and breaks silently as "control not found".
        assert_eq!(stable_label("Pods · 179"), "Pods");
        assert_eq!(stable_label("Deployments · 75"), "Deployments");
        assert_eq!(stable_label("Services · 1,284"), "Services");
        // Conservative: a number that is part of the name survives.
        assert_eq!(stable_label("Region 2"), "Region 2");
        assert_eq!(stable_label("Refresh"), "Refresh");
        assert_eq!(stable_label("Cluster - prod"), "Cluster - prod");
    }

    #[test]
    fn a_volatile_label_drafts_a_prefix_locator_and_a_stable_name() {
        let mut sv = survey();
        sv.controls = vec![FoundControl { text: "Pods · 179".into(), kind: "button".into() }];
        let p = draft_profile("d", "https://c.example.invalid", &[sv]).unwrap();
        let a = &p.pages[0].actions[0];
        assert_eq!(a.name, "pods", "the name must not carry the count");
        assert_eq!(a.locator, Locator::ButtonTextPrefix("Pods".into()));
    }

    #[test]
    fn a_draft_claims_no_tab() {
        let p = draft_profile("d", "https://c.example.invalid", &[survey()]).unwrap();
        assert!(p.match_urls.is_empty());
        assert!(!p.matches_url("https://c.example.invalid/clusters/69"));
    }

    #[test]
    fn a_draft_carries_a_dom_ready_signal_so_it_passes_its_own_lint() {
        // The mapper must not emit drafts that the F3 lint immediately refuses.
        let p = draft_profile("d", "https://c.example.invalid", &[survey()]).unwrap();
        assert!(p.lints().is_empty(), "{:?}", p.lints());
    }

    #[test]
    fn tables_and_test_ids_become_reads() {
        let p = draft_profile("d", "https://c.example.invalid", &[survey()]).unwrap();
        let names: Vec<&str> = p.pages[0].reads.iter().map(|r| r.name.as_str()).collect();
        assert!(names.contains(&"rows"), "{names:?}");
        assert!(names.contains(&"region"), "{names:?}");
    }

    #[test]
    fn pages_are_named_from_the_route_not_the_shared_title() {
        // Round F8: a single-page console keeps ONE document.title across every
        // route, so title-naming collided all four pages and validate() refused
        // the entire draft.
        let mut a = survey();
        let mut b = survey();
        a.url = "https://c.example.invalid/clusters".into();
        b.url = "https://c.example.invalid/clusters/69".into();
        a.title = "Console".into();
        b.title = "Console".into();
        let p = draft_profile("d", "https://c.example.invalid", &[a, b]).unwrap();
        let names: Vec<&str> = p.pages.iter().map(|x| x.name.as_str()).collect();
        assert_eq!(names, vec!["clusters", "clusters-69"], "{names:?}");
        p.validate().expect("a multi-page draft must survive its own validator");
    }

    #[test]
    fn colliding_slugs_are_disambiguated_rather_than_rejected() {
        let mut a = survey();
        let mut b = survey();
        a.url = "https://c.example.invalid/a/b".into();
        b.url = "https://c.example.invalid/a-b".into();
        let p = draft_profile("d", "https://c.example.invalid", &[a, b]).unwrap();
        assert_eq!(p.pages[0].name, "a-b");
        assert_eq!(p.pages[1].name, "a-b-2");
        p.validate().unwrap();
    }

    #[test]
    fn the_route_is_relative_to_the_base_url() {
        let p = draft_profile("d", "https://c.example.invalid", &[survey()]).unwrap();
        assert_eq!(p.pages[0].route, "/clusters/69");
    }

    #[test]
    fn a_draft_compiles_into_tools() {
        // End of the pipe: survey -> draft -> bundle, with the mutating controls
        // still requiring a grant.
        let p = draft_profile("d", "https://c.example.invalid", &[survey()]).unwrap();
        let b = crate::toolgen::Bundle::compile(&[p]).unwrap();
        assert_eq!(b.sites.len(), 1);
        assert_eq!(b.sites[0].tools.iter().filter(|t| t.effect == Some(Effect::Mutate)).count(), 2);
    }
}
