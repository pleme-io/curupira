//! Generate a skill document from a profile.
//!
//! A profile already states everything a reader needs: which console it claims,
//! what can be read, and which controls change the host. Writing that a second
//! time as prose guarantees the two drift, and the prose is the copy people
//! trust. So the document is DERIVED — regenerating it is the only way to edit
//! it.
//!
//! What it deliberately does not do is describe the console. The mapper found
//! structure, not meaning; asserting what a page is *for* would be invention,
//! and an authoritative-sounding sentence nobody measured is worse than an
//! absent one.

use crate::error::Result;
use crate::profile::{ConsoleProfile, Effect};
use crate::toolgen::{self, ToolKind};

/// Render a `SKILL.md` for one profile.
pub fn render(profile: &ConsoleProfile) -> Result<String> {
    let tools = toolgen::generate(profile)?;
    let mutating: Vec<&toolgen::ToolSpec> =
        tools.iter().filter(|t| t.effect == Some(Effect::Mutate)).collect();

    let mut s = String::new();
    s.push_str("---\n");
    s.push_str(&format!("name: site-{}\n", profile.id));
    s.push_str(&format!(
        "description: Drive the {} console through curupira's generated site tools — \
         navigate its pages, read their data, and act on controls under an explicit grant. \
         Generated from the profile; do not edit by hand.\n",
        profile.id
    ));
    s.push_str("---\n\n");

    s.push_str(&format!("# site-{}\n\n", profile.id));
    s.push_str(
        "**Generated from a console profile by `curupira-sites skill`. Every number below is \
         counted from the profile, not asserted.** Edit the profile and regenerate; editing this \
         file directly means the two disagree and this one is the copy people trust.\n\n",
    );

    s.push_str("## What this covers\n\n");
    s.push_str(&format!("- Base URL: `{}`\n", profile.base_url));
    if profile.match_urls.is_empty() {
        s.push_str(
            "- **Claims no tab.** `match` is empty, so this profile is never auto-selected. \
             That is the state of an unreviewed draft — it can be loaded and inspected but not \
             activated.\n",
        );
    } else {
        s.push_str(&format!("- Active when the tab URL contains: `{}`\n", profile.match_urls.join("`, `")));
    }
    s.push_str(&format!("- Pages: {}\n", profile.pages.len()));
    s.push_str(&format!("- Tools: {} ({} mutating)\n\n", tools.len(), mutating.len()));

    s.push_str("## Pages\n\n");
    for p in &profile.pages {
        s.push_str(&format!("### `{}`\n\n", p.name));
        s.push_str(&format!("Route `{}`", p.route));
        if let Some(t) = &p.tab {
            s.push_str(&format!(", in-page tab `{t}`"));
        }
        s.push_str(".\n\n");
        if p.reads.is_empty() {
            s.push_str("No reads defined.\n\n");
        } else {
            s.push_str("| read | returns |\n|---|---|\n");
            for r in &p.reads {
                s.push_str(&format!("| `{}` | {:?} |\n", r.name, r.kind));
            }
            s.push('\n');
        }
    }

    s.push_str("## Reading\n\n");
    s.push_str(
        "Every read answers with a **status**, not a bare value: `found`, `empty` (the element \
         is there and holds nothing — a finding, not an error) or `absent` (the locator matched \
         nothing — usually a stale profile). A large read is cut at 20,000 characters and says \
         so with `truncated`, `totalLen` and `returnedLen`; a silently shortened log is \
         indistinguishable from a short one.\n\n",
    );

    s.push_str("## Acting — borrowed ground\n\n");
    if mutating.is_empty() {
        s.push_str(
            "This profile defines no mutating controls, so it is **read-only by construction**. \
             Worth stating rather than leaving to inference.\n\n",
        );
    } else {
        s.push_str(&format!(
            "**{} of {} tools change the host.** Each requires `authorized_by` carrying the \
             operator's explicit go-ahead *for that specific action* — a grant for one control \
             never authorises another, and it cannot be defaulted. The refusal names what the \
             control does, so whoever is asked to grant it knows what they are approving.\n\n",
            mutating.len(),
            tools.len()
        ));
        s.push_str("<details><summary>Mutating tools</summary>\n\n");
        for t in &mutating {
            s.push_str(&format!(
                "- `{}` — {}\n",
                t.name,
                t.describes.as_deref().unwrap_or("effect unknown")
            ));
        }
        s.push_str("\n</details>\n\n");
    }

    let unreviewed = mutating
        .iter()
        .filter(|t| t.describes.as_deref().is_some_and(|d| d.contains("UNREVIEWED")))
        .count();
    if unreviewed > 0 {
        s.push_str(&format!(
            "> **{unreviewed} control(s) are still UNREVIEWED.** The mapper classifies everything \
             it discovers as mutating, because it never clicks and therefore cannot know. That is \
             the fail-safe direction, not a finding: it means nobody has decided yet which of \
             these are ordinary reads. Demote them in the profile as you determine what they do.\n\n"
        ));
    }

    s.push_str("## Navigating\n\n");
    let gotos = tools.iter().filter(|t| t.kind == ToolKind::Goto).count();
    s.push_str(&format!(
        "{gotos} `*_goto` tool(s). Each waits for the page's declared ready signals and reports \
         which never held, so a timeout ends in a diagnosis rather than a bare failure. A page \
         whose only readiness evidence is its URL is refused at build time — a URL is true before \
         any content renders.\n",
    ));

    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(yaml: &str) -> ConsoleProfile {
        ConsoleProfile::from_yaml(yaml).expect("fixture parses")
    }

    const WITH_MUTATION: &str = r##"
id: acme
base_url: https://c.example.invalid
match: [c.example.invalid]
pages:
  - name: home
    route: /home
    ready:
      - !selector-present "#t"
    reads:
      - name: title
        locator: !selector "#t"
        kind: !text
    actions:
      - name: nuke
        locator: !button-text "Delete"
        effect: mutate
        describes: destroys the cluster
"##;

    #[test]
    fn counts_come_from_the_profile_not_from_prose() {
        let s = render(&profile(WITH_MUTATION)).unwrap();
        assert!(s.contains("Pages: 1"));
        assert!(s.contains("(1 mutating)"));
        assert!(s.contains("acme_home_act_nuke"));
        assert!(s.contains("destroys the cluster"));
    }

    #[test]
    fn a_read_only_profile_says_so_rather_than_leaving_it_to_inference() {
        let s = render(&profile(
            r##"
id: ro
base_url: https://c.example.invalid
match: [c.example.invalid]
pages:
  - name: home
    route: /home
    ready:
      - !selector-present "#t"
    reads:
      - name: title
        locator: !selector "#t"
        kind: !text
"##,
        ))
        .unwrap();
        assert!(s.contains("read-only by construction"), "{s}");
    }

    #[test]
    fn a_draft_that_claims_no_tab_says_that_too() {
        let mut p = profile(WITH_MUTATION);
        p.match_urls.clear();
        let s = render(&p).unwrap();
        assert!(s.contains("Claims no tab"), "{s}");
    }

    #[test]
    fn unreviewed_controls_are_called_out_as_undecided_not_as_dangerous() {
        let mut p = profile(WITH_MUTATION);
        p.pages[0].actions[0].describes =
            "UNREVIEWED — discovered by the mapper, never driven.".into();
        let s = render(&p).unwrap();
        assert!(s.contains("still UNREVIEWED"), "{s}");
        assert!(s.contains("nobody has decided yet"), "{s}");
    }

    #[test]
    fn the_frontmatter_is_well_formed() {
        let s = render(&profile(WITH_MUTATION)).unwrap();
        assert!(s.starts_with("---\n"));
        assert!(s.contains("\nname: site-acme\n"));
        assert_eq!(s.matches("---\n").count(), 2, "exactly one frontmatter block");
    }
}
