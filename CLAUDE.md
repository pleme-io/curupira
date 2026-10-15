# Curupira

> **★★★ CSE / Knowable Construction.** This repo operates under **Constructive Substrate Engineering** — canonical specification at [`pleme-io/theory/CONSTRUCTIVE-SUBSTRATE-ENGINEERING.md`](https://github.com/pleme-io/theory/blob/main/CONSTRUCTIVE-SUBSTRATE-ENGINEERING.md). The Compounding Directive (operational rules: solve once, load-bearing fixes only, idiom-first, models stay current, direction beats velocity) is in the org-level pleme-io/CLAUDE.md ★★★ section. Read both before non-trivial changes.

<div align="center"> <h3>🦶 Trace backwards through execution to find the root cause 🦶</h3> <p>Named after the Brazilian forest guardian with backward feet</p>

## Site targets

The site engine compiles profiles into one bundle served by generic MCP tools. A
profile's `target` (`browser`, the default, `macos-app`, or `desktop`) picks
the backend; the pipeline is shared. Map:

| Path | What |
|---|---|
| `crates/curupira-sites` | profile schema (`profile.rs` browser, `app.rs` macos-app, `desktop.rs` desktop), compiler (`toolgen.rs`), suites + the one judge (`testplan.rs`) |
| `target: desktop` (`desktop.rs`) | a surface driven by the computer-use MCP, which curupira plans and never executes: `app` (name as macOS shows it), optional `bundle_id`, `tier` read/click/full (the computer-use grant; steps the tier blocks are refused: read has no type/click/key, click has no type/key), required `why` (why neither browser nor macos-app covers it), `views` of `ready` visible text, `reads` as screen `region`s and `actions` as ordered `steps` (verbs key/type/click/scroll/wait/screenshot/open, `{param}` placeholders declared in `params`), optional `promote` (the profile that replaces it once mapped); `site_goto`/`site_read`/`site_act` answer `{driver:"computer-use", app, tier, view, ready, steps, then}`; a mutate act still needs `authorized_by`; carries no suite, so the judge never sees it |
| `site_route` / `curupira-mcp route <query>` | match a query against every profile (id, base_url host and `match`, bundle_id, desktop app, page/view names; exact id > host > name) and answer `{matches:[{site, target, driver: curupira-cdp/curupira-ax/computer-use, tools, pages or views, promote?}], unmatched, next?}`; unmatched is a typed answer naming how to map the surface |
| `crates/curupira-ax` | macos-app executor + `curupira-ax` CLI; the only unsafe code is `src/seam.rs` |
| `mcp-server/src/mcp/tools/providers/site-tools.factory.ts` | generic tools; dispatches on `site.target` |
| `crates/curupira-sites/fixtures/judge-cases.json` | holds the Rust and TS judges to the same verdicts |
| `crates/curupira-stack` | layered stack: `/etc/curupira-sites/curupira-sites.yaml` < `~/.config/curupira-sites/curupira-sites.yaml` < every `.curupira-sites.yaml` / `.curupira-sites-*.yaml` from `/` down to the cwd (shikumi hierarchical discovery, nearest wins per key); sites and workspaces are maps so layers add, override or `enabled: false` single entries |
| `site_workspace_list` / `site_workspace_open` | open a workspace's tabs in the connected headed Chrome; the server builds the stack at start (`CURUPIRA_STACK_BIN`), falling back to the static bundle when no layer exists or `CURUPIRA_SITES_SOURCE=bundle` |
| typing actions (`Action.input`) | `locator` is the text box; `site_act` with `value` focuses it, sends `value` as trusted `Input.insertText`, then submits by Enter, a click, or not at all; typing into an app is `effect: mutate` and needs `authorized_by` like any write |
| `site_watch` / `site_events` | a page's `events` streams: a MutationObserver buffers new `items` inside `within` (filtered by `contains`) until drained; `watching: false` means no observer, never "no events" |
| postures (`curupira-mcp posture [name]`, `curupira-mcp warm`) | named states in the stack (`postures.<name>`: workspaces, hours, days, interval_minutes, form `signin` rules reading files, `notify` bin); `off` is always legal; `warm` applies the selected one: opens missing tabs over CDP, refills forms, notifies for the rest; HM `programs.curupira.warm.enable` runs it from launchd every 5 min |
| reconcile (`curupira-mcp reconcile [--once]`, `strays [host action]`, `site_posture`, `site_posture_stray`) | a posture's `reconcile` block is an eventual state converged every `tick_seconds` wherever curupira runs (MCP server, or HM `programs.curupira.reconcile.enable` agent; a lease in `~/.local/state/curupira/reconcile.lease` keeps one actor): `tabs` enforce/observe/off, `strays` question/close/ignore for pages on hosts outside the posture (`allow` and chrome/devtools/sign-in pages exempt); questioned strays notify once and wait in `strays.json` for adopt/dismiss/close; `CURUPIRA_RECONCILE=off` keeps a server passive; every tick except `held` writes `reconcile-last.json`, so an idle or blind tick replaces an old `converged` |
| `site_app_launch` | a browser profile with `launch: {app, port}` is an Electron app: opened with `--remote-debugging-port` and connected, then driven by the same tools |
| session-less CDP (`ChromeClient.send` / `activePageSession`) | a page command with no session goes to the front-most page tab, activated first through `/json/activate` because a hidden window (fullscreen on another Space) freezes its renderers and every renderer call hangs; `Target.createTarget` without a browser socket goes over `PUT /json/new` |
| `sites/` | public examples only (`example.invalid`, stock Apple apps) |

A new target kind is a backend (locator vocabulary + executor) behind the same
verbs, never a second pipeline. Rules every backend keeps: `effect` is observe or
mutate; a mutating act needs `authorized_by`; reads answer found / empty / absent,
capped and saying when cut; ready only on a named signal; the qualifying suite
runs on demand per target. `Cargo.lock` changes ship with `gen build .` and the
regenerated `Cargo.gen.lock` in the same commit. A real stack (sites,
workspaces) lives in a private repo or the user layer, never here.
