use curupira_sites::{emit, profile::{Locator, Read, ReadKind}};
fn main() {
    let r = Read { name: "log".into(), locator: Locator::Selector("main".into()), kind: ReadKind::Text };
    println!("{}", emit::emit_read_checked(&r).unwrap());
}
