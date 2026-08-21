//! End-to-end demonstration of the navigation surface, without a browser.
//!
//! Run: `cargo run --example console_demo`
//!
//! Shows the whole vertical slice on a generic profile: parse YAML -> plan
//! navigation -> emit the JS a CDP client evaluates -> refuse a mutating
//! control -> allow it once an operator grants it. The emitted JS is printed so
//! it can be piped into a JS parser and checked for real (see the README).

use std::collections::BTreeMap;

use curupira_sites::profile::{self, Authorization, ConsoleProfile};
use curupira_sites::emit;

const PROFILE: &str = r#"
base_url: https://platform.secure.example
pages:
  - name: cluster
    route: /clusters/{cluster_id}
    tab: Terminal
    ready:
      - !url-contains "/clusters/"
      - !selector-present ".xterm"
    reads:
      - name: heading
        locator: !selector "h1"
        kind: !text
      - name: pods
        locator: !selector "table.pods"
        kind: !table
      - name: tab-count
        locator: !selector "[role=\"tab\"]"
        kind: !count
    actions:
      - name: refresh
        locator: !button-text "Refresh"
        effect: observe
      - name: delete-cluster
        locator: !button-text "Delete"
        effect: mutate
        describes: permanently destroys the cluster
"#;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let profile = ConsoleProfile::from_yaml(PROFILE)?;
    println!("== profile ==");
    println!("base_url       : {}", profile.base_url);
    println!("pages          : {}", profile.pages.len());
    println!("mutating       : {:?}", profile.mutating_actions());

    let mut params = BTreeMap::new();
    params.insert("cluster_id".to_string(), "69".to_string());

    println!("\n== 1. plan navigation ==");
    let plan = profile::plan_nav(&profile, "cluster", &params)?;
    println!("url            : {}", plan.url);
    println!("tab            : {:?}", plan.tab);
    println!("ready probe JS : {}", emit::emit_ready_probe(&plan.ready)?);

    println!("\n== 2. an unresolved param is refused, not silently emptied ==");
    match profile::plan_nav(&profile, "cluster", &BTreeMap::new()) {
        Ok(p) => println!("UNEXPECTED: planned {}", p.url),
        Err(e) => println!("refused        : {e}"),
    }

    println!("\n== 3. emitted read JS ==");
    let page = profile.page("cluster").expect("page");
    for name in ["heading", "pods", "tab-count"] {
        let r = page.read(name).expect("read");
        println!("{name:<14} : {}", emit::emit_read(r)?);
    }

    println!("\n== 4. the borrowed-ground gate ==");
    let obs = profile::plan_observe(&profile, "cluster", "refresh")?;
    println!("observe/refresh: OK effect={:?}", obs.effect);

    match profile::plan_observe(&profile, "cluster", "delete-cluster") {
        Ok(_) => println!("UNEXPECTED: observe planned a mutation"),
        Err(e) => println!("observe/delete : {e}"),
    }

    let wrong = Authorization::grant("cluster.refresh", "operator ok'd a refresh");
    match profile::plan_mutate(&profile, "cluster", "delete-cluster", &wrong) {
        Ok(_) => println!("UNEXPECTED: a grant for one action authorized another"),
        Err(e) => println!("wrong grant    : {e}"),
    }

    let right = Authorization::grant("cluster.delete-cluster", "operator said: yes, tear it down");
    let mutation = profile::plan_mutate(&profile, "cluster", "delete-cluster", &right)?;
    println!("granted        : effect={:?} by={:?}", mutation.effect, mutation.authorized_by);
    println!("click JS       : {}", emit::emit_click(&mutation.locator)?);

    println!("\n== 5. injection: a selector carrying live JS stays data ==");
    let nasty = profile::Locator::Selector("a\"); alert(1); //".to_string());
    println!("emitted        : {}", emit::emit_locate(&nasty)?);

    Ok(())
}
