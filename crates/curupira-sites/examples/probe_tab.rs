use curupira_sites::{emit, profile::Locator};
fn main() {
    let ex = emit::emit_locate(&Locator::ButtonText("Terminal".into())).unwrap();
    let pf = emit::emit_locate(&Locator::ButtonTextPrefix("Terminal".into())).unwrap();
    let ct = emit::emit_locate(&Locator::ButtonTextContains("Terminal".into())).unwrap();
    println!("JSON.stringify((() => {{ const e={ex}, p={pf}, c={ct}; const t=x=>x?x.textContent.replace(/\\s+/g,' ').trim():null; return {{ exact:t(e), prefix:t(p), contains:t(c) }}; }})())");
}
