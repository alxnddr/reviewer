---
name: authoring-review
description: Reviews a git range and authors a .reviewer.json (anchored comments, ordered chapter layers) that opens in Reviewer with zero manual fixing. User-invoked.
disable-model-invocation: true
---

# authoring-review

Author one high-quality `.reviewer.json` for a git range: comments anchored to exact lines and
**ordered layers** — a guided reading order — each with a chapter-intro `description`. `rvw emit`
captures the range's diff to prove every anchor places, then writes a refs-only artifact the app
re-derives from the branch on open — it is **self-validated before handoff**, so it is correct by
construction, not by hope. It opens in Reviewer with no manual fixing (the branch must stay
available for the app to render).

**This skill authors an artifact. It never publishes to GitHub and never marks a review
submitted** — it drafts _as the user_, who then curates in the app and decides what ships.
The only output is a `.reviewer.json` file on disk.

Ask the toolchain for the artifact shape — `rvw schema --json` emits it, derived from the contract
the gate enforces. Order **is** reading order: the app renders layers in the sequence you
emit and re-sorts nothing, so the whole ordering burden is yours.

## The `rvw` CLI

Every command below is a verb on `rvw`, the review CLI. It is self-contained: it runs **from any
working directory, in any repo**, and needs no dependencies installed in the repo you are reviewing.
Run `rvw <verb> --help` for flags.

If `rvw` is not on your `PATH`, invoke the bundle directly — `node <reviewer-install>/dist/rvw.js
<verb>`, or `bun run cli <verb>` from inside the Reviewer checkout.

Reference (load when you reach the step that names it):

- `reference/authoring-guide.md` — how to divide a diff into comprehension-ordered layers, write a
  chapter `description`, keep comments minimal, and the exact `draft.json` shape you write. Read it
  before Step 2.

## Step 1 — Resolve the range

Pick the range to review as a **base** and **head** ref. Each must be a branch name or a full
commit sha — a rev-expression like `HEAD~2` or `main~3` is not a valid artifact ref (the schema,
and so the gate, rejects it). Resolve any expression first:

```
git -C <repo> rev-parse <expr>     # → full sha to pass as --base / --head
```

The diff is captured with the exact three-dot `base...head` (merge-base) range — only what head adds
over the common ancestor, matching how a PR is reviewed. You do not run that command yourself; `rvw
emit` (Step 4) captures it to validate every anchor, and the app re-derives the same range on open.

Completion: you have a `<repo>` path and two refs, each a branch name or full sha.

## Step 2 — Read the diff and author the draft

Read the full diff for the range — with the same config the Step 4 gate captures, so you read the
exact file-path bytes it embeds (a repo whose git config escapes paths would otherwise make you
author against a path the gate reports absent):

```
git -C <repo> -c core.quotepath=false -c diff.noprefix=false -c diff.mnemonicPrefix=false \
  diff --find-renames --patch <base>...<head> --
```

Then author `draft.json` — an object with two keys, `comments` and `layers` — following
`reference/authoring-guide.md`. In short:

- **Layers** are the ordered walkthrough. Emit them in the sequence that makes the change easiest to
  understand (foundation → dependents, not file-alphabetical). Each layer: `id`, `label`, one-line
  `summary`, author-chosen `kind`, `ranges` (each `file` + `side` + ascending `startLine`/`endLine`),
  and a chapter `description` — genuine "why this slice" reading context, not a restated summary. A
  parent layer may carry empty `ranges` and roll up its children via their `parent` field.
- **Comments** are minimal: `file`, `side`, ascending `startLine`/`endLine`, `body`. `side` is the
  enum **`deletions`** or **`additions`** (never `old`/`new`). The body says _why_ — it never
  restates the line.
- Every range/comment `side` + line span must fall inside a hunk of the range's diff, and every
  `[label](path)` link in a `description` must target a file present in this diff. The Step 4 gate
  enforces both; author against the diff you read so it passes first time.

Completion: `draft.json` exists with ≥1 comment and an ordered `layers` array; every anchor was read
off the actual diff.

## Step 3 — (nothing to assemble by hand)

You never hand-write the `version` or `source`, and never paste the diff into JSON — `rvw emit`
captures the diff with the exact flags to validate your anchors and assembles the artifact. Hand-
assembly is where a stray byte or a mis-authored anchor breaks placement; the tool removes that
class of error.

## Step 4 — Emit and self-validate (hard gate)

Run `rvw emit` from anywhere — the CLI carries its own dependencies:

```
rvw emit \
  --repo <repo> --base <ref> --head <ref> \
  --draft <path/to/draft.json>
```

`--out` is optional: omit it and the artifact lands in rvw's managed reviews dir (`~/.rvw/reviews/`,
or `$RVW_HOME/reviews/`) under a derived name — **never in the repo you are reviewing**, which stays
clean. Pass `--out <name>.reviewer.json` only when the user wants it somewhere specific. Either way
`rvw emit` prints the written path (and reports it as `out` under `--json`) — **capture that path**;
it is what you hand to `rvw check` and `rvw open` in the next steps.

`rvw emit` captures the diff, folds in your draft, and validates the assembled artifact with
the same validator the app anchors with — every comment anchor and layer range proven to **place**
against that captured diff, every description link proven to resolve — **before writing any bytes**.
On a clean pass it writes a refs-only artifact (no embedded patch) the app re-derives from the branch
on open. Outcomes:

- **Exit 0**: `<name>.reviewer.json` is written and ready. Only then is the artifact real.
- **Exit 1**: the artifact failed the gate; **nothing was written**. `rvw emit` prints each problem
  with its exact locator (file, side, line range, layer id, or bad link). Fix `draft.json` — a range
  that does not place is a wrong line number; an unresolved link is a path not in the diff — and
  re-run. **Never hand over an artifact the gate did not pass**: a hallucinated line reaching
  the user is the failure this step exists to prevent.
- **Exit 2**: `rvw emit` could not run (bad flags, git failure, unreadable draft). Fix the invocation.

Then run the pre-handoff gate, which re-checks placement **and** reports what the layers leave
uncovered:

```
rvw check <name>.reviewer.json                     # exit 0 = valid; a coverage gap warns
rvw check <name>.reviewer.json --require-complete  # exit 1 unless every changed line is covered
```

A gap is not automatically a defect — a strong review may skip formatting or generated files — but it
is a decision you make with the numbers in front of you, never by accident. If the gap is real,
add a layer and re-emit.

Completion: `rvw emit` exited 0, `rvw check` exited 0, and `<name>.reviewer.json` exists.

## Step 5 — Open it in Reviewer

Open the finished artifact directly — only after Step 4's gate passed:

```
rvw open <name>.reviewer.json
```

This hands the file to the installed app, which imports it and reveals it (a running Reviewer is
reused; a closed one is launched). Exit `0` means the app was asked to open it; exit `2` means it
could not — the app is not installed, or you are not on macOS. If `rvw open` cannot launch it, tell
the user to open it by hand, any one of:

- `reviewer <name>.reviewer.json` on the command line,
- **File → Open** in the app, or
- drag the `.reviewer.json` onto the window.

The app assigns each comment its identity on import and pins every anchor to its exact line; the
layers step in the order you authored. The user curates from there.
