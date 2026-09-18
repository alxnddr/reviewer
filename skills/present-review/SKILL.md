---
name: present-review
description: Presents a review you have already performed in the Reviewer app — an overview, line-anchored comments, and an optional layer walkthrough. User-invoked.
disable-model-invocation: true
---

# present-review

You have already reviewed the change. This turns the findings you hold into a review the user can
read in the Reviewer app. **It does not perform the review.**

**If you have not actually reviewed the change yet, stop here.** Run the review command or skill
your agent harness provides — whatever `/code-review`-equivalent it ships — together with the
project's own guidelines if it has any (`CLAUDE.md`, `AGENTS.md`, `.cursor/rules`,
`CONTRIBUTING.md`). Come back with findings. There is no review procedure in this file; do not
invent one.

`rvw` is the CLI that publishes the draft. It is self-contained and runs from any working
directory, in any repo. If it is not on your `PATH`, run `node <reviewer-install>/dist/rvw.js`.

## The draft

One JSON object. You author exactly three keys — `overview`, `comments`, `layers`. `rvw emit`
supplies `repo`, `base` and `head`, so never hand-write them.

```json
{
  "overview": { "title": "Replace the polling loop with a socket subscription", "body": "..." },
  "comments": [
    { "file": "src/client.ts", "side": "additions", "startLine": 42, "endLine": 47, "body": "Why." }
  ],
  "layers": [
    {
      "label": "Subscription contract",
      "summary": "Events carry a sequence number so a reconnect can resume",
      "description": "Read this first; every later slice assumes it.",
      "ranges": [{ "file": "src/protocol.ts", "side": "additions", "startLine": 1, "endLine": 30 }]
    }
  ]
}
```

`rvw schema --json` is the authority on field rules — read it rather than guessing. Every prose
field — the overview body, a layer description, a comment body — is markdown (CommonMark + GFM).
A link to a path is read as a file reference and must name a file present in the diff, or the gate
refuses the draft; a `https://` link is left alone and opens in the browser.

## Writing the overview

- Title the review with the change, not a category: "Replace the polling loop with a socket subscription", not "Networking changes".
- Make the first sentence state what the change does and why it exists. A reader who stops there should still be able to describe the change to someone else.
- Put the reason — the bug, limit, or pressure that forced the work — in that sentence or the next one. Do not build up to it.
- Cut any warm-up: "This PR…", "In this change…", "As part of our work on…". Start at the point.
- Follow the answer with two to four supporting points: the approach taken, the decision that mattered and what it displaced, the consequence for callers.
- Make each point stand alone. A reader should understand it without having read the others.
- Hold one group at one level of abstraction. Don't set "moved retry logic behind an interface" beside "renamed a variable".
- Make every point summarize something real underneath it. If a sentence summarizes nothing, delete it.
- Order the support deliberately — dependency before dependent, cause before effect, or largest consequence first. Never arbitrary.
- Give the reader what they need before line one: the assumption that changed, the invariant now enforced, the term you use that they may not know.
- Name the tradeoff you accepted and what you deliberately did not do. A reviewer cannot recover that from the diff.
- Say what you checked and found sound, in one short list of three to six items, each one thing you actually did. A review with few comments needs this most: it is how the reader tells clean from unread.
- Name the tests that pin the behavior and say whether you ran them. Link the ones the change touched, as file references — a path that is not in the diff fails the gate, so a linked name is checked rather than claimed; name an unchanged test in plain backticks.
- If this should have been two changes, say so and say where the seam is. The diff cannot show that; only you can.
- End the body with the verdict in one sentence: whether this should land as is, and if not, the one thing that stops it. Not a score, not a percentage, not an estimate — a verdict is a judgement you own, and the rule below against counting is about numbers, which the app measures for itself.
- Write actively and concretely: "the parser now rejects trailing commas", not "trailing commas are no longer accepted".
- Use the domain's words. Prefer the real noun over "the abstraction layer" or "the refactored logic".
- Do not list the layers or preview the walkthrough. The app derives that.
- Do not count files, lines, comments, or commits. The app computes those.
- Do not restate findings. The comments carry them; the overview says why the change exists.
- Do not inventory paths or narrate file moves. "Split parsing out of the client so the worker can reuse it" beats naming directories.
- Keep it to roughly 100–250 words. Past that, you are explaining code the layers will show.
- Sound like a competent colleague explaining it at a desk: direct, specific, unhurried.
- No hype ("massively improves"), no hedging ("should probably be fine"), no apologies.
- If you cannot state the answer in one sentence, you do not yet know what the change is. Work that out before writing.

## Comments

Anchor to the smallest span that carries the point. `side` is `additions` or `deletions`. The body
says why, not what — the diff already shows what changed. It is markdown, so a `symbol`, a short
list, or a fenced snippet of the fix all render — but keep it to the point: a comment is read
beside the code, and a card that turns into a document stops being a comment.

- Open the body with a bold three-to-seven-word claim on its own line — what is wrong, not where — and put the why in the paragraph under it. The rail previews that line as plain words, so spend it on the conclusion, not the approach to it.
- Say what breaks and on what: the input, state, or sequence that reaches this code, and the wrong result it produces. If you cannot name one, you have a question and not a finding — say which.
- One comment per issue. Anchor it to the clearest instance and name the other sites as file references (`[the same check in the worker](src/worker.ts)`), which the gate resolves against the diff. Do not repeat the paragraph at each one.
- Open with **Decision** (or **Question**) when the comment is a call the reader has to make rather than a defect — a threshold, a default, a name, a dropped case. Nothing is broken yet, and the first word should say so.
- Open with **Pre-existing** when the finding is in code this change did not touch, so the reader does not blame the change. It is still a finding: anchor it to the nearest changed or context line in the same file — a line inside a hunk's context places, which is why `rvw diff --json`'s spans are the floor and not the ceiling of what you can anchor to.

## Organizing layers

**Write layers by default.** They are what makes this a tour instead of a list of comments — the
diff cut into chapters in an order you chose. `layers` is optional in the schema only: leave it out
when the user or the project's rules asked for comments alone, or when the change is genuinely one
thought (a one-file fix, a config bump). Otherwise layer it.

A layer is `{ label, summary?, description?, ranges?, children? }` — nesting is structural, via
`children`. Only `label` is required; omit `ranges` on a grouping layer whose children carry them,
and omit `children` on a leaf.

- Treat layers as chapters of a reading order you chose, not a listing of what the diff touched.
- Group by what changed and why — a capability added, a bug fixed, a migration, a constraint now enforced — never by folder, file type, or filename.
- Let one layer span many files, and let one file appear in several layers when it plays several parts.
- Order so each chapter is understandable from what came before it and nothing else.
- Put the contract first: the type, schema, interface, or config a change rests on, ahead of the code that consumes it.
- Put the cause before the consequence: the behavior change before the call sites it forced, the fix before the tests that pin it.
- Keep groups non-overlapping in intent. If two layers would explain the same decision, they are one layer.
- Make them exhaustive together: every changed line belongs to exactly one chapter's reasoning — never explained twice under two layers, never left out silently. After the last chapter, a reader should be able to describe the whole change.
- What you leave unplaced the app shows as "Not covered by layers", so an omission is visible either way. Make it a decision rather than an oversight.
- Cut any layer that exists only for completeness — mechanical renames, generated output, formatting. Fold it into the layer it serves.
- Keep the list flat unless a theme genuinely has parts worth reading separately. Most reviews are flat.
- Nest only when the parent makes a point of its own and each child is a distinct step in that point. Never nest just to shorten a list.
- Write each summary as the point of the slice: "Retries now back off per host", not "Updates to client.ts".
- Keep the summary to one line and make it claim something. If it could label any diff, rewrite it.
- Use the description for what you would say out loud before the reviewer looks: why this slice exists, what to notice, where it gets subtle.
- Write the description so it lands for someone who has not opened the diff. No "here you can see", "below", "as shown".
- Do not restate the summary in the description. Add the reason, the constraint, or the thing that is easy to miss.
- When a layer's code is hard to scan, put a few lines of pseudocode in its description: strip the syntax, the error handling and the boilerplate, and keep the control flow, so the reader can confirm the intent before reading the real thing.
- When a layer changes behavior in a way the diff does not make obvious, trace one small concrete input through the old path and the new one — a GFM table works well — and name the step where they diverge.
- Reach for either only when the diff is genuinely hard to read. Most layers need neither.
- Leave the description off when the summary is genuinely enough. An empty description costs the reader more than none.
- Never order alphabetically, by path, or one layer per file. That is a directory listing with extra steps.

## Emitting

One call. The draft goes in on stdin and the app opens:

```
rvw emit --open <<'JSON'
{ ... }
JSON
```

`--open` is the default and can be omitted; pass `--no-open` to write without opening. Run
`rvw <verb> --help` for flags.

The range is auto-detected — the cwd's repo, the current branch, the fork point against its
upstream or the default branch — and echoed back so you can check it. Pass `--repo`, `--base` or
`--head` only to override — and name a branch when a branch is what you mean: a local branch is
recorded as written and the review follows it, while a tag, `HEAD`, `main~3`, `origin/main` or a
sha is pinned to the commit it resolved to. Any revision git understands is accepted.

Without `--out` the artifact lands in `~/.rvw/reviews/`, where the app's Recent Reviews picker
(⇧⌘R) finds it. Pass `--out` only when someone asked for the file somewhere specific.

If the review is being emitted on a machine the reader will not open it on — CI, a container, a
remote box — add `--embed-patch`, which carries the diff inside the artifact so it opens anywhere.
Embedding costs nothing on the reader's side: the app reads the diff from their checkout whenever
it has one (and the review goes live — context expands, files open in an editor) and falls back to
the embedded patch only when it does not. Emitting on the reader's own machine needs no flag.

On a platform without the app (Linux), `rvw emit` writes the artifact but cannot open it: pass
`--no-open` and name the written path in your reply so the reader can carry it over.

Outcomes:

- **Exit 0** — the review was written and opened.
- **Exit 1** — the gate refused the draft and **nothing was written**. Each problem is printed with
  its locator: a file, side and line span for a comment, or an ordinal path like `4.2.1` for a layer
  range, pointing at that position in the `layers` array you wrote. Fix the draft and re-run.
- **Exit 2** — the invocation could not run.

If an anchor will not place, run `rvw diff` — it prints the exact diff the gate validates against.
`rvw diff --json` lists the anchorable line spans per file and side; a line inside a hunk's context
also places, so that listing is not the complete set of valid anchors.
