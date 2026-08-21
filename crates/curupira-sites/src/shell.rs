//! The shell as a line processor: a core that runs commands, plugins that give
//! their output a shape.
//!
//! A terminal hands back bytes. Everything above it wants records. Without a
//! layer in between, every caller writes its own `grep | awk`, and the structure
//! it recovers is invented at the call site, undocumented, and wrong the first
//! time a column moves.
//!
//! # Core / plugin
//!
//! The **core** is [`structure`]: given the command that was run and the raw
//! output, it asks each registered [`Shaper`] whether it claims that command,
//! and the first one that does produces a typed [`Structured`]. The **plugins**
//! are the shapers — one per output shape, each small enough to read in one
//! sitting and testable without a terminal.
//!
//! # The rule that makes this cheap: ask for structure, do not recover it
//!
//! A shaper that parses a human table is guessing. A shaper that parses `-o json`
//! is reading. So [`prefer_structured`] rewrites a command to request a machine
//! format where the tool has one, and the table shapers exist for output that
//! genuinely has no structured form. Recovering structure is the fallback, never
//! the plan.
//!
//! # Nothing here touches a terminal
//!
//! Pure functions over strings, so every shape is unit-tested against captured
//! output rather than against a live console — which is the only way this stays
//! honest, because a console's output changes when nobody is looking.

use serde::{Deserialize, Serialize};

/// What a command's output turned out to be.
///
/// `Unstructured` is a real answer, not a failure: some output has no shape, and
/// saying so beats inventing one. The caller can still read `lines`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "shape", rename_all = "kebab-case")]
pub enum Structured {
    /// The tool emitted JSON and we parsed it.
    Json { value: serde_json::Value },
    /// The tool emitted YAML; carried as text plus a note, because a second YAML
    /// parser is a second thing to disagree with the first.
    Yaml { text: String },
    /// A header row plus data rows, e.g. plain `kubectl get`.
    Table { headers: Vec<String>, rows: Vec<Vec<String>> },
    /// Rows with no header, e.g. `--no-headers`.
    Rows { rows: Vec<Vec<String>> },
    /// A two-column ATTRIBUTE/VALUE listing, e.g. `kubectl auth whoami`.
    Pairs { pairs: Vec<(String, String)> },
    /// A single number, e.g. `| wc -l`.
    Count { count: i64 },
    /// Lines, when there is genuinely nothing more to say.
    Unstructured { lines: Vec<String> },
}

/// One plugin: claims a command shape and gives its output structure.
pub trait Shaper: Send + Sync {
    /// Stable name, for reporting which plugin shaped a result.
    fn name(&self) -> &'static str;
    /// Whether this shaper handles the command that produced the output.
    ///
    /// Keyed on the COMMAND rather than sniffed from the output, deliberately:
    /// output-sniffing guesses, and a `kubectl get` returning one line of JSON-ish
    /// text would be claimed by the wrong plugin. The command states intent.
    fn claims(&self, cmd: &str) -> bool;
    /// Shape it. Returning `None` declines, and the core moves on — so a shaper
    /// that claims a command but meets output it cannot parse degrades to the
    /// next candidate instead of failing the call.
    fn shape(&self, raw: &str) -> Option<Structured>;
}

/// What the core produced, and which plugin produced it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Shaped {
    pub shaper: &'static str,
    pub structured: Structured,
}

// ── Plugins ──────────────────────────────────────────────────────────────────

/// `-o json`, `--format JSON*`, `-o=json`.
pub struct JsonShaper;
impl Shaper for JsonShaper {
    fn name(&self) -> &'static str { "json" }
    fn claims(&self, cmd: &str) -> bool {
        let c = cmd.to_ascii_lowercase();
        c.contains("-o json") || c.contains("-o=json") || c.contains("--output json")
            || c.contains("--format json")
    }
    fn shape(&self, raw: &str) -> Option<Structured> {
        let t = raw.trim();
        // JSONEachRow and friends emit one object per line, which is not a
        // document. Try the whole thing first, then line-wise.
        if let Ok(v) = serde_json::from_str(t) {
            return Some(Structured::Json { value: v });
        }
        let rows: Vec<serde_json::Value> = t
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l.trim()))
            .collect::<Result<_, _>>()
            .ok()?;
        if rows.is_empty() {
            return None;
        }
        Some(Structured::Json { value: serde_json::Value::Array(rows) })
    }
}

/// `-o yaml`.
pub struct YamlShaper;
impl Shaper for YamlShaper {
    fn name(&self) -> &'static str { "yaml" }
    fn claims(&self, cmd: &str) -> bool {
        let c = cmd.to_ascii_lowercase();
        c.contains("-o yaml") || c.contains("-o=yaml") || c.contains("--output yaml")
    }
    fn shape(&self, raw: &str) -> Option<Structured> {
        let t = raw.trim();
        if t.is_empty() { None } else { Some(Structured::Yaml { text: t.to_string() }) }
    }
}

/// A trailing `wc -l` (or `wc -w`/`-c`): the answer is one number.
pub struct CountShaper;
impl Shaper for CountShaper {
    fn name(&self) -> &'static str { "count" }
    fn claims(&self, cmd: &str) -> bool { cmd.contains("wc -l") || cmd.contains("wc -w") || cmd.contains("wc -c") }
    fn shape(&self, raw: &str) -> Option<Structured> {
        raw.trim().lines().last()?.trim().parse::<i64>().ok().map(|count| Structured::Count { count })
    }
}

/// `--no-headers`: whitespace-split rows, no header to name them.
pub struct NoHeaderShaper;
impl Shaper for NoHeaderShaper {
    fn name(&self) -> &'static str { "no-headers" }
    fn claims(&self, cmd: &str) -> bool { cmd.contains("--no-headers") }
    fn shape(&self, raw: &str) -> Option<Structured> {
        let rows: Vec<Vec<String>> = raw
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| l.split_whitespace().map(str::to_string).collect())
            .collect();
        if rows.is_empty() { None } else { Some(Structured::Rows { rows }) }
    }
}

/// A two-column `ATTRIBUTE  VALUE` listing, as `kubectl auth whoami` emits.
pub struct PairsShaper;
impl Shaper for PairsShaper {
    fn name(&self) -> &'static str { "pairs" }
    fn claims(&self, cmd: &str) -> bool { cmd.contains("auth whoami") }
    fn shape(&self, raw: &str) -> Option<Structured> {
        let mut pairs = Vec::new();
        for l in raw.lines().filter(|l| !l.trim().is_empty()) {
            // Two or more spaces separate the columns; a single space is inside
            // a value.
            let mut it = l.splitn(2, "  ");
            let k = it.next()?.trim();
            let v = it.next().unwrap_or("").trim();
            if k.eq_ignore_ascii_case("ATTRIBUTE") {
                continue;
            }
            if !k.is_empty() {
                pairs.push((k.to_string(), v.to_string()));
            }
        }
        if pairs.is_empty() { None } else { Some(Structured::Pairs { pairs }) }
    }
}

/// A plain `kubectl get` table: first line is the header.
pub struct KubectlTableShaper;
impl Shaper for KubectlTableShaper {
    fn name(&self) -> &'static str { "kubectl-table" }
    fn claims(&self, cmd: &str) -> bool {
        let c = cmd.to_ascii_lowercase();
        c.contains("kubectl") && c.contains(" get ") && !c.contains("-o ") && !c.contains("--no-headers")
    }
    fn shape(&self, raw: &str) -> Option<Structured> {
        let mut lines = raw.lines().filter(|l| !l.trim().is_empty());
        let header = lines.next()?;
        // A header is upper-case column names; if it is not, this is not a table
        // (an error message, most likely) and the shaper declines.
        if !header.chars().any(|c| c.is_ascii_uppercase()) {
            return None;
        }
        let headers: Vec<String> = header.split_whitespace().map(str::to_string).collect();
        let rows: Vec<Vec<String>> =
            lines.map(|l| l.split_whitespace().map(str::to_string).collect()).collect();
        Some(Structured::Table { headers, rows })
    }
}

/// Every shaper, in claim order. Order is the priority: the most specific claim
/// must come first, or a broader shaper swallows it.
#[must_use]
pub fn shapers() -> Vec<Box<dyn Shaper>> {
    vec![
        Box::new(CountShaper),
        Box::new(JsonShaper),
        Box::new(YamlShaper),
        Box::new(PairsShaper),
        Box::new(NoHeaderShaper),
        Box::new(KubectlTableShaper),
    ]
}

/// The core. Give it the command and the raw output; get a shape and the name of
/// the plugin that produced it.
///
/// Always succeeds: with no claimant, or a claimant that declines, the result is
/// `Unstructured`, which is an honest answer rather than an error.
#[must_use]
pub fn structure(cmd: &str, raw: &str) -> Shaped {
    for s in shapers() {
        if s.claims(cmd) {
            if let Some(structured) = s.shape(raw) {
                return Shaped { shaper: s.name(), structured };
            }
        }
    }
    Shaped {
        shaper: "unstructured",
        structured: Structured::Unstructured {
            lines: raw.lines().map(str::to_string).collect(),
        },
    }
}

/// Rewrite a command to ASK for machine-readable output where the tool has one.
///
/// Reading `-o json` beats parsing a table, so the cheapest way to structure
/// output is to never let it become prose. Conservative: it only touches a
/// `kubectl get` that specifies no output format and no `--no-headers`, and it
/// leaves anything piped alone, because appending a flag after a pipe changes
/// the wrong command.
#[must_use]
pub fn prefer_structured(cmd: &str) -> String {
    let c = cmd.trim();
    let lower = c.to_ascii_lowercase();
    let already = lower.contains("-o ") || lower.contains("-o=") || lower.contains("--output")
        || lower.contains("--no-headers");
    if !lower.contains("kubectl") || !lower.contains(" get ") || already || c.contains('|') {
        return c.to_string();
    }
    format!("{c} -o json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_count_is_a_number_not_a_line() {
        let s = structure("kubectl -n x get pods --no-headers | wc -l", "30\n");
        assert_eq!(s.shaper, "count");
        assert_eq!(s.structured, Structured::Count { count: 30 });
    }

    #[test]
    fn json_output_is_read_not_guessed() {
        let s = structure("kubectl get pods -o json", r#"{"items":[{"a":1}]}"#);
        assert_eq!(s.shaper, "json");
        match s.structured {
            Structured::Json { value } => assert_eq!(value["items"][0]["a"], 1),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn json_each_row_is_an_array_not_a_parse_failure() {
        // ClickHouse's JSONEachRow is one object per line, which is not a
        // document — a naive whole-string parse fails on perfectly good output.
        let s = structure("clickhouse-client --format JSONEachRow", "{\"a\":1}\n{\"a\":2}\n");
        assert_eq!(s.shaper, "json");
        match s.structured {
            Structured::Json { value } => assert_eq!(value.as_array().unwrap().len(), 2),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_kubectl_table_keeps_its_headers() {
        let raw = "NAME     READY   STATUS\napi-0    1/1     Running\napi-1    0/1     Pending\n";
        let s = structure("kubectl -n x get pods", raw);
        assert_eq!(s.shaper, "kubectl-table");
        match s.structured {
            Structured::Table { headers, rows } => {
                assert_eq!(headers, vec!["NAME", "READY", "STATUS"]);
                assert_eq!(rows.len(), 2);
                assert_eq!(rows[1][2], "Pending");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn an_error_message_is_not_mistaken_for_a_table() {
        // The failure this prevents: an error where a table was expected, shaped
        // into a "table" whose header is the first words of the error.
        let s = structure("kubectl -n x get pods", "error: the server doesn't have a resource type\n");
        assert_eq!(s.shaper, "unstructured");
    }

    #[test]
    fn whoami_becomes_pairs() {
        let raw = "ATTRIBUTE   VALUE\nUsername    system:serviceaccount:ns:sa\nUID         abc-123\n";
        let s = structure("kubectl auth whoami", raw);
        assert_eq!(s.shaper, "pairs");
        match s.structured {
            Structured::Pairs { pairs } => {
                assert_eq!(pairs.len(), 2);
                assert_eq!(pairs[0].0, "Username");
                assert!(pairs[0].1.starts_with("system:serviceaccount:"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn no_headers_gives_rows_without_inventing_names() {
        let s = structure("kubectl get pods --no-headers", "api-0 1/1 Running\napi-1 0/1 Error\n");
        assert_eq!(s.shaper, "no-headers");
        match s.structured {
            Structured::Rows { rows } => {
                assert_eq!(rows.len(), 2);
                assert_eq!(rows[1], vec!["api-1", "0/1", "Error"]);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_shaper_that_cannot_parse_declines_rather_than_failing_the_call() {
        // `wc -l` claimed, but the output is not a number — the core must fall
        // through instead of erroring.
        let s = structure("something | wc -l", "not a number\n");
        assert_eq!(s.shaper, "unstructured");
    }

    #[test]
    fn nothing_ever_errors_out() {
        for (c, r) in [("", ""), ("weird", "\u{1b}[31mred\u{1b}[0m"), ("kubectl get", "")] {
            let _ = structure(c, r);
        }
    }

    #[test]
    fn prefer_structured_asks_for_json_rather_than_recovering_it() {
        assert_eq!(prefer_structured("kubectl -n x get pods"), "kubectl -n x get pods -o json");
    }

    #[test]
    fn prefer_structured_leaves_alone_what_it_must_not_touch() {
        // Already formatted, explicitly headerless, or piped — appending a flag
        // after a pipe would modify the wrong command.
        for c in [
            "kubectl get pods -o yaml",
            "kubectl get pods --no-headers",
            "kubectl get pods | wc -l",
            "echo hello",
        ] {
            assert_eq!(prefer_structured(c), c, "must not rewrite: {c}");
        }
    }

    #[test]
    fn claim_order_puts_the_specific_before_the_general() {
        // `kubectl get … | wc -l` is claimed by count, not by the table shaper.
        let s = structure("kubectl get pods | wc -l", "7\n");
        assert_eq!(s.shaper, "count");
    }
}
