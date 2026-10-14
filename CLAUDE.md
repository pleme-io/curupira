# Curupira

> **★★★ CSE / Knowable Construction.** This repo operates under **Constructive Substrate Engineering** — canonical specification at [`pleme-io/theory/CONSTRUCTIVE-SUBSTRATE-ENGINEERING.md`](https://github.com/pleme-io/theory/blob/main/CONSTRUCTIVE-SUBSTRATE-ENGINEERING.md). The Compounding Directive (operational rules: solve once, load-bearing fixes only, idiom-first, models stay current, direction beats velocity) is in the org-level pleme-io/CLAUDE.md ★★★ section. Read both before non-trivial changes.

<div align="center"> <h3>🦶 Trace backwards through execution to find the root cause 🦶</h3> <p>Named after the Brazilian forest guardian with backward feet</p>

## Site targets

The site engine compiles profiles into one bundle served by generic MCP tools. A
profile's `target` (`browser`, the default, or `macos-app`) picks the backend;
the pipeline is shared. Map:

| Path | What |
|---|---|
| `crates/curupira-sites` | profile schema (`profile.rs` browser, `app.rs` macos-app), compiler (`toolgen.rs`), suites + the one judge (`testplan.rs`) |
| `crates/curupira-ax` | macos-app executor + `curupira-ax` CLI; the only unsafe code is `src/seam.rs` |
| `mcp-server/src/mcp/tools/providers/site-tools.factory.ts` | generic tools; dispatches on `site.target` |
| `crates/curupira-sites/fixtures/judge-cases.json` | holds the Rust and TS judges to the same verdicts |
| `crates/curupira-stack` | layered stack: `/etc/curupira-sites/curupira-sites.yaml` < `~/.config/curupira-sites/curupira-sites.yaml` < every `.curupira-sites.yaml` / `.curupira-sites-*.yaml` from `/` down to the cwd (shikumi hierarchical discovery, nearest wins per key); sites and workspaces are maps so layers add, override or `enabled: false` single entries |
| `site_workspace_list` / `site_workspace_open` | open a workspace's tabs in the connected headed Chrome; the server builds the stack at start (`CURUPIRA_STACK_BIN`), falling back to the static bundle when no layer exists or `CURUPIRA_SITES_SOURCE=bundle` |
| typing actions (`Action.input`) | `locator` is the text box; `site_act` with `value` focuses it, sends `value` as trusted `Input.insertText`, then submits by Enter, a click, or not at all; typing into an app is `effect: mutate` and needs `authorized_by` like any write |
| `site_watch` / `site_events` | a page's `events` streams: a MutationObserver buffers new `items` inside `within` (filtered by `contains`) until drained; `watching: false` means no observer, never "no events" |
| `site_app_launch` | a browser profile with `launch: {app, port}` is an Electron app: opened with `--remote-debugging-port` and connected, then driven by the same tools |
| `sites/` | public examples only (`example.invalid`, stock Apple apps) |

A new target kind is a backend (locator vocabulary + executor) behind the same
verbs, never a second pipeline. Rules every backend keeps: `effect` is observe or
mutate; a mutating act needs `authorized_by`; reads answer found / empty / absent,
capped and saying when cut; ready only on a named signal; the qualifying suite
runs on demand per target. `Cargo.lock` changes ship with `gen build .` and the
regenerated `Cargo.gen.lock` in the same commit. A real stack (sites,
workspaces) lives in a private repo or the user layer, never here.
