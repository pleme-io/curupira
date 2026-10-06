use std::time::{Duration, Instant};

use crate::exec::{Host, Opened, Responsible, Trust};

pub struct SystemHost {
    start: Instant,
}

impl Default for SystemHost {
    fn default() -> Self {
        Self { start: Instant::now() }
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::{Duration, Host, Opened, Responsible, SystemHost, Trust};
    use crate::seam::{self, Element, Raw};
    use crate::tree::{AttrValue, AxTree, Fault};

    const LAUNCH_WAIT_MS: u64 = 10_000;
    const LAUNCH_POLL_MS: u64 = 200;

    pub struct AppTree {
        pub pid: i32,
        app: Element,
    }

    impl AxTree for AppTree {
        type Node = Element;

        fn root(&self) -> Element {
            self.app.clone()
        }

        fn attr(&self, node: &Element, name: &str) -> AttrValue {
            match seam::attribute(node, name) {
                Raw::Absent | Raw::Unanswered => AttrValue::Absent,
                Raw::Text(s) => AttrValue::Text(s),
                Raw::Number(n) => AttrValue::Number(n),
                Raw::Bool(b) => AttrValue::Bool(b),
                Raw::Element(_) | Raw::Elements(_) => AttrValue::Other("<element>".to_string()),
                Raw::Other(s) => AttrValue::Other(s),
            }
        }

        fn elements(&self, node: &Element, name: &str) -> Vec<Element> {
            match seam::attribute(node, name) {
                Raw::Elements(v) => v,
                Raw::Element(e) => vec![e],
                _ => Vec::new(),
            }
        }

        fn press(&self, node: &Element) -> Result<(), Fault> {
            seam::perform(node, "AXPress").map_err(Fault::from_code)
        }

        fn set_value(&self, node: &Element, value: &str) -> Result<(), Fault> {
            seam::set_text(node, "AXValue", value).map_err(Fault::from_code)
        }

        fn activate(&self) -> Result<(), Fault> {
            seam::set_true(&self.app, "AXFrontmost").map_err(Fault::from_code)
        }
    }

    #[must_use]
    pub fn running_pid(bundle_id: &str) -> Option<i32> {
        seam::pid_for_bundle(bundle_id)
    }

    fn launch(bundle_id: &str) -> Option<i32> {
        let status = std::process::Command::new("/usr/bin/open").args(["-b", bundle_id]).status().ok()?;
        if !status.success() {
            return None;
        }
        let mut waited = 0;
        while waited < LAUNCH_WAIT_MS {
            if let Some(pid) = seam::pid_for_bundle(bundle_id) {
                return Some(pid);
            }
            std::thread::sleep(Duration::from_millis(LAUNCH_POLL_MS));
            waited += LAUNCH_POLL_MS;
        }
        None
    }

    impl Host for SystemHost {
        type Tree = AppTree;

        fn trust(&self) -> Trust {
            match seam::trusted() {
                Some(true) => Trust::Trusted,
                Some(false) => Trust::NotTrusted,
                None => Trust::Unsupported(
                    "the Accessibility API (HIServices / CoreFoundation) could not be loaded".to_string(),
                ),
            }
        }

        fn responsible(&self) -> Responsible {
            Responsible::from_process(seam::responsible_process())
        }

        fn open(&self, bundle_id: &str, launch_it: bool) -> Opened<AppTree> {
            let pid = seam::pid_for_bundle(bundle_id).or_else(|| launch_it.then(|| launch(bundle_id)).flatten());
            match pid {
                None => Opened::NotRunning,
                Some(pid) => match seam::application(pid) {
                    Some(app) => Opened::App(AppTree { pid, app }),
                    None => Opened::Fault(format!("could not open the accessibility element of pid {pid}")),
                },
            }
        }

        fn now_ms(&self) -> u64 {
            u64::try_from(self.start.elapsed().as_millis()).unwrap_or(u64::MAX)
        }

        fn sleep_ms(&self, ms: u64) {
            std::thread::sleep(Duration::from_millis(ms));
        }
    }
}

#[cfg(target_os = "macos")]
pub use mac::{AppTree, running_pid};

#[cfg(not(target_os = "macos"))]
impl Host for SystemHost {
    type Tree = crate::fake::FakeTree;

    fn trust(&self) -> Trust {
        Trust::Unsupported(format!(
            "the Accessibility API is macOS-only; this is {}",
            std::env::consts::OS
        ))
    }

    fn responsible(&self) -> Responsible {
        Responsible::default()
    }

    fn open(&self, _bundle_id: &str, _launch: bool) -> Opened<Self::Tree> {
        Opened::Unsupported(format!("no macOS apps on {}", std::env::consts::OS))
    }

    fn now_ms(&self) -> u64 {
        u64::try_from(self.start.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    fn sleep_ms(&self, ms: u64) {
        std::thread::sleep(Duration::from_millis(ms));
    }
}
