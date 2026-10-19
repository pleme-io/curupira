use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::error::{Result, SitesError};

pub const DEFAULT_SPAN: &str = "-24h";
pub const DEFAULT_MAX: &str = "-30d";
pub const DEFAULT_KNOB: &str = "window";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum TimeWindow {
    Relative {
        param: String,
        #[serde(default = "default_span")]
        default: String,
        #[serde(default = "default_max")]
        max: String,
    },
    EpochMs {
        from: String,
        to: String,
        #[serde(default = "default_knob")]
        knob: String,
        #[serde(default = "default_span")]
        default: String,
        #[serde(default = "default_max")]
        max: String,
    },
}

fn default_span() -> String {
    DEFAULT_SPAN.into()
}

fn default_max() -> String {
    DEFAULT_MAX.into()
}

fn default_knob() -> String {
    DEFAULT_KNOB.into()
}

const LEGAL: &str = "a bounded relative span: -<n><s|m|h|d|w>, optionally snapped (@h, @d), e.g. -15m, -24h, -7d@d";

pub fn span_seconds(spec: &str, allow_snap: bool) -> Result<u64> {
    let refuse = |why: &str| SitesError::Config(format!("time window '{spec}' {why}; legal: {LEGAL}"));
    let body = spec.strip_prefix('-').ok_or_else(|| refuse("is not a relative span back from now"))?;
    let (span, snap) = match body.split_once('@') {
        Some((s, snap)) => (s, Some(snap)),
        None => (body, None),
    };
    if let Some(snap) = snap {
        if !allow_snap {
            return Err(refuse("snaps, which this site cannot express"));
        }
        if snap.is_empty() || !snap.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(refuse("has a malformed snap"));
        }
    }
    let unit = span.chars().last().ok_or_else(|| refuse("is empty"))?;
    let count = &span[..span.len() - unit.len_utf8()];
    if count.is_empty() || !count.chars().all(|c| c.is_ascii_digit()) {
        return Err(refuse("has no count"));
    }
    let n: u64 = count.parse().map_err(|_| refuse("has no count"))?;
    let per = match unit {
        's' => 1,
        'm' => 60,
        'h' => 3600,
        'd' => 86_400,
        'w' => 604_800,
        _ => return Err(refuse("has an unknown unit")),
    };
    if n == 0 {
        return Err(refuse("is empty"));
    }
    Ok(n * per)
}

impl TimeWindow {
    pub fn knob(&self) -> &str {
        match self {
            TimeWindow::Relative { param, .. } => param,
            TimeWindow::EpochMs { knob, .. } => knob,
        }
    }

    pub fn default_span(&self) -> &str {
        self.limits().0
    }

    fn snaps(&self) -> bool {
        matches!(self, TimeWindow::Relative { .. })
    }

    fn limits(&self) -> (&str, &str) {
        match self {
            TimeWindow::Relative { default, max, .. } | TimeWindow::EpochMs { default, max, .. } => (default, max),
        }
    }

    pub fn validate(&self, page: &str, route: &str) -> Result<()> {
        let (default, max) = self.limits();
        let cap = span_seconds(max, false)?;
        if span_seconds(default, self.snaps())? > cap {
            return Err(SitesError::Config(format!("page '{page}': window default '{default}' is wider than its max '{max}'")));
        }
        match self {
            TimeWindow::Relative { param, .. } if !route.contains(&format!("{{{param}}}")) => Err(SitesError::Config(format!(
                "page '{page}': window param '{param}' is not a {{{param}}} placeholder in route '{route}'"
            ))),
            TimeWindow::EpochMs { from, to, .. } if route.contains(&format!("{{{from}}}")) || route.contains(&format!("{{{to}}}")) => {
                Err(SitesError::Config(format!(
                    "page '{page}': an epoch-ms window appends {from}/{to} itself; drop them from route '{route}'"
                )))
            }
            _ => Ok(()),
        }
    }

    pub fn bound(&self, given: Option<&str>, now_ms: u64) -> Result<Bounded> {
        let (default, max) = self.limits();
        let spec = given.unwrap_or(default);
        let secs = span_seconds(spec, self.snaps())?;
        if secs > span_seconds(max, false)? {
            return Err(SitesError::Config(format!("time window '{spec}' is wider than this page's max '{max}'")));
        }
        Ok(match self {
            TimeWindow::Relative { param, .. } => Bounded { substitute: BTreeMap::from([(param.clone(), spec.to_string())]), append: BTreeMap::new() },
            TimeWindow::EpochMs { from, to, .. } => Bounded {
                substitute: BTreeMap::new(),
                append: BTreeMap::from([
                    (from.clone(), now_ms.saturating_sub(secs * 1000).to_string()),
                    (to.clone(), now_ms.to_string()),
                ]),
            },
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Bounded {
    pub substitute: BTreeMap<String, String>,
    pub append: BTreeMap<String, String>,
}

impl Bounded {
    pub fn apply(&self, url: &str) -> String {
        let mut out = url.to_string();
        for (k, v) in &self.substitute {
            out = out.replace(&format!("{{{k}}}"), v);
        }
        for (k, v) in &self.append {
            let sep = if out.contains('?') { '&' } else { '?' };
            out = format!("{out}{sep}{k}={v}");
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct Case {
        name: String,
        window: TimeWindow,
        given: Option<String>,
        now_ms: u64,
        expect: Option<Bounded>,
    }

    #[test]
    fn shared_cases_hold() {
        let cases: Vec<Case> = serde_json::from_str(include_str!("../fixtures/window-cases.json")).unwrap();
        assert!(cases.len() >= 8);
        for c in cases {
            let got = c.window.bound(c.given.as_deref(), c.now_ms).ok();
            assert_eq!(got, c.expect, "case '{}'", c.name);
        }
    }

    #[test]
    fn a_relative_param_must_be_in_the_route() {
        let w = TimeWindow::Relative { param: "earliest".into(), default: "-24h".into(), max: "-30d".into() };
        assert!(w.validate("search", "/search?q={q}&earliest={earliest}").is_ok());
        assert!(w.validate("search", "/search?q={q}").is_err());
        let wide = TimeWindow::Relative { param: "earliest".into(), default: "-60d".into(), max: "-30d".into() };
        assert!(wide.validate("search", "/s?earliest={earliest}").is_err());
    }

    #[test]
    fn bounded_appends_after_an_existing_query() {
        let b = Bounded { substitute: BTreeMap::new(), append: BTreeMap::from([("from_ts".into(), "1".into()), ("to_ts".into(), "2".into())]) };
        assert_eq!(b.apply("https://x.invalid/logs?query=a"), "https://x.invalid/logs?query=a&from_ts=1&to_ts=2");
        assert_eq!(b.apply("https://x.invalid/d/1"), "https://x.invalid/d/1?from_ts=1&to_ts=2");
    }
}
