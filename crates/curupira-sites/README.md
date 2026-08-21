# curupira-sites

Compile a web console into MCP tools.

A console is described as **data** — a profile of pages, the reads available on
them, and the controls they expose. This crate turns that into a bundle of tool
definitions with their JavaScript already baked in; curupira's TypeScript server
loads the bundle at startup. Nothing here runs at request time.

```
curupira-sites emit-survey            # read-only page survey, to evaluate in a tab
curupira-sites draft --id X --base-url U < surveys.json
curupira-sites curate DIR --id X --match host    # read-only slice of a draft
curupira-sites check DIR              # gate: refuses linted profiles
curupira-sites build DIR -o bundle.json
curupira-sites skill DIR              # generate the skill document
curupira-sites list DIR               # review surface, [MUTATES] marked
```

## The rules that carry it

**Borrowed ground.** A console usually belongs to someone else. Reads are
in-bounds; a mutating control needs an explicit grant naming *that* action.
`Effect` has no `Unknown` arm, so a control is classified or it is not usable.

**The mapper never clicks.** It reads the DOM of the page it is already on. An
automated crawler that clicks to explore will eventually click the destructive
thing, and that has no undo. Everything it discovers is `mutate` until a human
decides otherwise — the fail-safe direction.

**An answer says which of found / empty / absent happened.** `empty` is a
finding, not an error. A bare value cannot distinguish "not rendered" from
"not there" from "there and holding nothing", and those need different responses.

**Quiescence is not readiness.** A page that has stopped changing may be an
authentication interstitial. Surveys carry `text_len` and `interstitial`, and
`draft` refuses to fold one in — a map of nothing that looks like a map of
something is the expensive failure.

**Weakest matcher that works.** Exact, then prefix (`Pods · 179`), then contains
(`>_Terminal`). A substring can match several controls; an exact match cannot hit
the wrong one.

**Reads are bounded and say so.** Capped at 20,000 characters, reporting
`truncated` / `totalLen` / `returnedLen`. A silently shortened log reads exactly
like a short one.

## Profiles are not kept here

A real profile describes a third-party console's routes and menu structure. It
lives in `~/.config/curupira/sites/`, never in this repository. `sites/` and
`fixtures/` contain only `example.invalid` material.
