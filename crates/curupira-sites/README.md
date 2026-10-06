# curupira-sites

Compile a UI target — a web console or a native macOS app — into MCP tools.

A target is described as **data**: a profile of pages (views, for an app), the
reads available on them, and the controls they expose. This crate turns that into
a bundle of tool definitions; curupira's TypeScript server loads the bundle at
startup and serves every target through the same generic verbs (`site_goto`,
`site_read`, `site_act`, `site_run_tests`). One profile language, one compiler,
one judge. The profile's `target` picks the executor:

| `target` | identified by | locators | executor |
|---|---|---|---|
| `browser` (default — no `target` key) | `base_url` + `match` | CSS selectors, button-text matchers | JavaScript baked into the bundle, evaluated over CDP by the server |
| `macos-app` | `bundle_id` | AX role + title/description/identifier/value matchers, scoped by `within` | the `curupira-ax` binary (Accessibility API), spawned by the server |

A new target kind is a new backend — a locator vocabulary plus an executor — never
a new pipeline.

```
curupira-sites emit-survey            # read-only page survey, to evaluate in a tab
curupira-sites draft --id X --base-url U < surveys.json
curupira-sites curate DIR --id X --match host    # read-only slice of a draft
curupira-sites check DIR              # gate: refuses linted profiles
curupira-sites build DIR -o bundle.json
curupira-sites skill DIR              # generate the skill document (browser profiles)
curupira-sites list DIR               # review surface, [MUTATES] marked
curupira-sites tests DIR              # the qualifying suite each target carries
```

## A macos-app profile

```yaml
target: macos-app
id: example-calculator
bundle_id: com.apple.calculator
views:
  - name: keypad
    ready:
      - !window-title { contains: Calculator }
      - !element-present { role: AXButton, within: { role: AXWindow } }
    reads:
      - name: display
        locator: { role: AXStaticText, within: { role: AXWindow } }
        kind: !text
    actions:
      - name: clear
        locator: { role: AXButton, description: { contains: clear } }
        effect: mutate
        describes: discards the current calculation
        perform: press          # or set-value, which takes a value at call time
tests:
  - name: keypad renders
    view: keypad
    expect_reads: [{ read: display, outcome: found }]
```

`sites/example-macos-app.yaml` is the full example. Author one from a live tree
with `curupira-ax survey --bundle-id <id> --pretty`.

What `check` refuses in a macos-app profile, because each would load and then
quietly do the wrong thing: any browser field (`base_url`, `match`, `route`,
`tab`) or browser locator (`!selector`, `!button-text…`, `!selector-present`); a
role or attribute that is not an `AX…` name; an empty locator, or a text matcher
with zero or two of `exact`/`prefix`/`contains`; a bundle id that is not
reverse-DNS; and a view that reads or presses with no `element-present` ready
signal — a window title is set before the window's content exists, the same
reason a browser page cannot rely on `url-contains` alone. A browser profile that
carries `bundle_id` or `views` is refused too.

## The rules that carry it — on every backend

**Borrowed ground.** A target usually belongs to someone else. Reads are
in-bounds; a mutating control needs an explicit grant naming *that* action.
`Effect` has no `Unknown` arm, so a control is classified or it is not usable. The
server refuses a mutating `site_act` without `authorized_by` before it touches the
browser or spawns `curupira-ax`, and `curupira-ax act` refuses again without
`--authorized-by`.

**The mapper never clicks.** It reads the DOM of the page it is already on; the AX
survey reads the tree of the app as it stands. An automated crawler that clicks to
explore will eventually click the destructive thing, and that has no undo.
Everything the browser mapper discovers is `mutate` until a human decides
otherwise — the fail-safe direction.

**An answer says which of found / empty / absent happened.** `empty` is a
finding, not an error. A bare value cannot distinguish "not rendered" from
"not there" from "there and holding nothing", and those need different responses.
On a native target "the app is not running" and "this process is not trusted for
Accessibility" are their own typed outcomes, never an `absent`.

**Ready only on a named signal.** A browser `goto` waits for the page's ready
signals and names the ones that never held; an app `goto` does the same with AX
signals. A qualifying-suite case whose view never became ready fails as
`page did not settle`, rather than reading stale UI.

**Quiescence is not readiness.** A page that has stopped changing may be an
authentication interstitial. Surveys carry `text_len` and `interstitial`, and
`draft` refuses to fold one in — a map of nothing that looks like a map of
something is the expensive failure.

**Weakest matcher that works.** Exact, then prefix (`Pods · 179`), then contains
(`>_Terminal`). A substring can match several controls; an exact match cannot hit
the wrong one. A native `act` whose locator matches more than one element presses
nothing and answers `ambiguous` with the count.

**Reads are bounded and say so.** Capped at 20,000 characters, reporting
`truncated` / `totalLen` / `returnedLen` (`totalItems` / `returnedItems` for lists
and tables). A silently shortened log reads exactly like a short one. An AX walk is
capped too (8,000 nodes, depth 64) and reports `walkTruncated`.

**One judge.** `testplan::judge_case` scores a case from the gathered survey and
reads. The server's TypeScript port and this Rust judge are held to the same
answers by `fixtures/judge-cases.json`, which both test suites read.

## Profiles are not kept here

A real profile describes a third-party console's routes and menu structure. It
lives in `~/.config/curupira/sites/`, never in this repository. `sites/` and
`fixtures/` contain only `example.invalid` material and stock Apple apps.
