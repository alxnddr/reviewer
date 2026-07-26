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

`rvw schema --json` is the authority on field rules — read it rather than guessing. Prose takes a
small markdown set, and every `[label](path)` link must name a file present in the diff or the gate
refuses the draft.

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
says why, not what — the diff already shows what changed.

## Organizing layers

Layers are optional. A comments-only review is completely valid and needs no `layers` key; add
layers when a reading order genuinely helps. A layer is `{ label, summary?, description?, ranges?,
children? }` — nesting is structural, via `children`. Only `label` is required; omit `ranges` on a
grouping layer whose children carry them, and omit `children` on a leaf.

- Treat layers as chapters of a reading order you chose, not a listing of what the diff touched.
- Group by what changed and why — a capability added, a bug fixed, a migration, a constraint now enforced — never by folder, file type, or filename.
- Let one layer span many files, and let one file appear in several layers when it plays several parts.
- Order so each chapter is understandable from what came before it and nothing else.
- Put the contract first: the type, schema, interface, or config a change rests on, ahead of the code that consumes it.
- Put the cause before the consequence: the behavior change before the call sites it forced, the fix before the tests that pin it.
- Keep groups non-overlapping in intent. If two layers would explain the same decision, they are one layer.
- Make them exhaustive together. After the last chapter, a reader should be able to describe the whole change.
- Cut any layer that exists only for completeness — mechanical renames, generated output, formatting. Fold it into the layer it serves.
- Keep the list flat unless a theme genuinely has parts worth reading separately. Most reviews are flat.
- Nest only when the parent makes a point of its own and each child is a distinct step in that point. Never nest just to shorten a list.
- Write each summary as the point of the slice: "Retries now back off per host", not "Updates to client.ts".
- Keep the summary to one line and make it claim something. If it could label any diff, rewrite it.
- Use the description for what you would say out loud before the reviewer looks: why this slice exists, what to notice, where it gets subtle.
- Write the description so it lands for someone who has not opened the diff. No "here you can see", "below", "as shown".
- Do not restate the summary in the description. Add the reason, the constraint, or the thing that is easy to miss.
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
`--head` only to override. Any git revision expression works; refs are resolved for you.

Outcomes:

- **Exit 0** — the review was written and opened.
- **Exit 1** — the gate refused the draft and **nothing was written**. Each problem is printed with
  its locator: a file, side and line span for a comment, or an ordinal path like `4.2.1` for a layer
  range, pointing at that position in the `layers` array you wrote. Fix the draft and re-run.
- **Exit 2** — the invocation could not run.

If an anchor will not place, run `rvw diff` — it prints the exact diff the gate validates against.
`rvw diff --json` lists the anchorable line spans per file and side; a line inside a hunk's context
also places, so that listing is not the complete set of valid anchors.
