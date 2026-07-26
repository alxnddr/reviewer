---
name: authoring-review
description: Presents a review you have already performed as a .reviewer.json — anchored comments and an ordered layer walkthrough — that opens in the Reviewer app with zero manual fixing. User-invoked.
disable-model-invocation: true
---

# authoring-review

You have already reviewed the change — found the issues, formed the judgments (with whatever
review skills you loaded for that). This skill is **not** how to review. It is how to **present**
a review: it turns the findings you already hold into one `.reviewer.json` — an **overview** the
review opens on, comments anchored to exact lines, and **ordered layers** that walk a human through
the change in a deliberate reading order, each with a chapter-intro `description` — and opens it in
the Reviewer app.

`rvw emit` captures the range's diff, proves every anchor places against it, and writes a
refs-only artifact the app re-derives from the branch on open. It is **self-validated before
handoff** — correct by construction, not by hope — and needs no manual fixing (the branch must
stay available for the app to render).

**This skill authors an artifact. It never publishes to GitHub and never marks a review
submitted.** It drafts _as the user_, who then curates in the app and decides what ships. The
only output is a `.reviewer.json` file on disk.

Order **is** reading order: the app renders layers in the sequence you emit and re-sorts nothing.
Getting that order right is the one act of craft this skill exists to guide — see Step 2.

## The `rvw` CLI

Every command below is a verb on `rvw`, the review CLI. It is self-contained: it runs **from any
working directory, in any repo**, and needs no dependencies installed in the repo you are
reviewing. Run `rvw <verb> --help` for flags, and `rvw schema --json` for the authoritative
artifact shape (derived from the contract the gate enforces).

If `rvw` is not on your `PATH`, invoke the bundle directly — `node <reviewer-install>/dist/rvw.js
<verb>`, or `bun run cli <verb>` from inside the Reviewer checkout.

Reference (load when you reach Step 2):

- `reference/authoring-guide.md` — the exact `draft.json` shape and field rules, the overview and
  chapter prose grammar, how to phrase a comment, and the anchoring contract.

## Step 1 — Resolve the range

Pick the range to review as a **base** and **head** ref. Each must be a branch name or a full
commit sha — a rev-expression like `HEAD~2` or `main~3` is not a valid artifact ref (the schema,
and so the gate, rejects it). Resolve any expression first:

```
git -C <repo> rev-parse <expr>     # → full sha to pass as --base / --head
```

The diff is the exact three-dot `base...head` (merge-base) range — only what head adds over the
common ancestor, matching how a PR is reviewed. You do not run that command yourself; `rvw emit`
(Step 4) captures it, and the app re-derives the same range on open.

Completion: you have a `<repo>` path and two refs, each a branch name or full sha.

## Step 2 — Read the diff, then shape your findings into a draft

Read the full diff with the exact config the Step 4 gate captures, so you anchor against the same
file-path bytes it embeds (a repo whose git config escapes paths would otherwise make you author
against a path the gate reports absent):

```
git -C <repo> -c core.quotepath=false -c diff.noprefix=false -c diff.mnemonicPrefix=false \
  diff --find-renames --patch <base>...<head> --
```

Then author `draft.json` — an object with three keys, `overview`, `comments` and `layers` —
following `reference/authoring-guide.md`:

- **The overview** is the doc the review opens on: a `title` naming the change and a `body`
  saying what it does and why it is shaped this way. Write it for someone who has not seen the
  branch. Do **not** list the layers in it — the app continues the doc with one section per layer
  (its `description` in full, the files it covers, its line and comment counts) built from
  `layers` itself, so a hand-written table of contents would only go stale.

- **Never write a count.** Files, lines, comments, layers, coverage — the app computes all of
  them from the artifact and the diff on screen. A number in your prose is a second answer that
  goes wrong the moment anything moves.

- **Comments** carry the findings you already have. One per finding: `file`, `side` (the enum
  **`additions`** or **`deletions`**, never `old`/`new`), ascending `startLine`/`endLine`, and a
  `body` that says _why_. Anchor to the smallest span that carries the point; do not restate the
  line — the diff already shows what changed.

- **Layers** are the walkthrough, and they are where this artifact earns its keep — see below.

### Layering: the walkthrough is the product

A pile of comments is a checklist; a layered review is a guided reading. `layers` is an
**ordered** array the app renders verbatim, one chapter at a time. Order it for a first-time
reader of _this_ change, not for the filesystem.

- **Foundation before dependents.** The type, contract, or schema a change rests on comes before
  the code that consumes it. Meet the shape first and every later use reads for free.
- **Story over structure.** Group by _what changed and why_ — a capability, a fix, a migration —
  not by directory. One layer can span many files; one file can appear in several layers.
- **Nest for scale.** When a theme has parts worth reading separately, add a layer for the theme
  and point each part at it via `parent`. A layer's extent is its own ranges plus everything
  under it, so the parent is a real stop — opening it shows the whole group, opening a child
  narrows to that section — and it is numbered `4` to their `4.1`, `4.2`. Up to five levels; the
  array must stay in document order (a subtree follows its parent, together).
- **Every substantive layer earns a `description`** — the "why this slice" a reviewer would say
  out loud: what it does, why it is grouped, what to notice. Not a restated `summary`. It is read
  in the overview doc as well as above the diff, so write it to stand on its own.

Alphabetical files, one layer per file, a `summary` that echoes the filename — that is a
directory listing, not a review. Each layer: `id`, `label`, one-line `summary`, ascending `ranges`
(each `file` + `side` + `startLine`/`endLine`), and a `description`.

Every range/comment `side` + line span must fall inside a hunk of the diff, and every
`[label](path)` link in a `description` **or in the overview `body`** must target a file present in
the diff. The Step 4 gate enforces both; author against the diff you read so it passes first time.

Completion: `draft.json` exists with an `overview`, ≥1 comment, and an ordered `layers` array;
every anchor was read off the actual diff.

## Step 3 — (nothing to assemble by hand)

You never hand-write `version` or `source`, and never paste the diff into JSON — `rvw emit`
captures the diff with the exact flags and assembles the artifact. Hand-assembly is where a stray
byte or a mis-authored anchor breaks placement; the tool removes that class of error.

## Step 4 — Emit and self-validate (hard gate)

Run `rvw emit` from anywhere — the CLI carries its own dependencies:

```
rvw emit \
  --repo <repo> --base <ref> --head <ref> \
  --draft <path/to/draft.json>
```

`--out` is optional: omit it and the artifact lands in rvw's managed reviews dir (`~/.rvw/reviews/`,
or `$RVW_HOME/reviews/`) under a derived name — **never in the repo you are reviewing**, which
stays clean. Pass `--out <name>.reviewer.json` only when the user wants it somewhere specific.
Either way `rvw emit` prints the written path (and reports it as `out` under `--json`) — **capture
that path**; it is what you hand to `rvw check` and `rvw open`.

`rvw emit` validates the assembled artifact with the same validator the app anchors with — every
comment anchor and layer range proven to **place** against the captured diff, every description
link proven to resolve — **before writing any bytes**. On a clean pass it writes a refs-only
artifact (no embedded patch). Outcomes:

- **Exit 0**: `<name>.reviewer.json` is written and ready. Only then is the artifact real.
- **Exit 1**: the artifact failed the gate; **nothing was written**. `rvw emit` prints each
  problem with its exact locator (file, side, line range, layer id, or bad link). Fix
  `draft.json` — a range that does not place is a wrong line number; an unresolved link is a path
  not in the diff — and re-run. **Never hand over an artifact the gate did not pass**: a
  hallucinated line reaching the user is the failure this step exists to prevent.
- **Exit 2**: `rvw emit` could not run (bad flags, git failure, unreadable draft). Fix the
  invocation.

Then run the pre-handoff gate, which re-checks placement **and** reports what the layers leave
uncovered:

```
rvw check <name>.reviewer.json                     # exit 0 = valid; a coverage gap warns
rvw check <name>.reviewer.json --require-complete  # exit 1 unless every changed line is covered
```

A gap is not automatically a defect — a strong review may skip formatting or generated files —
but it is a decision you make with the numbers in front of you, never by accident. If the gap is
real, add a layer and re-emit.

Completion: `rvw emit` exited 0, `rvw check` exited 0, and `<name>.reviewer.json` exists.

## Step 5 — Open it in Reviewer

Open the finished artifact directly — only after Step 4's gate passed:

```
rvw open <name>.reviewer.json
```

This hands the file to the installed app, which imports it and reveals it (a running Reviewer is
reused; a closed one is launched). Exit `0` means the app was asked to open it; exit `2` means it
could not — the app is not installed, or you are not on macOS. If `rvw open` cannot launch it,
tell the user to open it by hand, any one of:

- `reviewer <name>.reviewer.json` on the command line,
- **File → Open** in the app, or
- drag the `.reviewer.json` onto the window.

The app assigns each comment its identity on import and pins every anchor to its exact line; the
layers step in the order you authored. The user curates from there.
