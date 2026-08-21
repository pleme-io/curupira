use curupira_sites::emit;
use curupira_sites::profile::Locator;
fn main() {
    let exact  = emit::emit_locate(&Locator::ButtonText("Pods".into())).unwrap();
    let prefix = emit::emit_locate(&Locator::ButtonTextPrefix("Pods".into())).unwrap();
    println!("(() => {{ const ex = {exact}; const pf = {prefix}; return {{ exact_found: !!ex, exact_text: ex && ex.textContent.trim(), prefix_found: !!pf, prefix_text: pf && pf.textContent.replace(/\\s+/g,' ').trim() }}; }})()");
}
