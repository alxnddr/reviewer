---
name: present-review
description: Presents a review you have already performed in the Reviewer app — an overview, line-anchored comments, and an optional layer walkthrough. User-invoked.
disable-model-invocation: true
---

# present-review

You have already reviewed the change. This skill turns the findings you hold into a review the user reads in the Reviewer app. **It does not perform the review.**

**If you have not reviewed the change yet, stop here.** Run the review command or skill your agent harness provides, together with the project's own guidelines if it has any (`CLAUDE.md`, `AGENTS.md`, `.cursor/rules`, `CONTRIBUTING.md`), and come back with findings. There is no review procedure in this file; do not invent one.

`rvw` is the CLI that publishes the draft. It runs from any working directory, in any repo. If it is not on your `PATH`, run `node <reviewer-install>/dist/rvw.js`.

## The draft

One JSON object. You author exactly three keys: `overview`, `comments`, `layers`. `rvw emit` supplies `repo`, `base` and `head`, so never hand-write them.

```json
{
  "overview": {
    "title": "Replace the polling loop with a socket subscription",
    "body": "...", "verdict": "caution"
  },
  "comments": [
    {
      "file": "src/queue.ts", "side": "additions", "startLine": 88, "endLine": 91,
      "body": "**Retry storms on a slow consumer**\n\nWhy.",
      "severity": "blocking", "tag": "race condition",
      "evidence": "```\n$ bun test queue\n1 failed: resumes from the last acked offset\n```"
    }
  ],
  "layers": [
    {
      "label": "Subscription contract",
      "summary": "Events carry a sequence number so a reconnect can resume",
      "description": "Read this first; every later slice assumes it.",
      "ranges": [
        {
          "file": "src/protocol.ts", "side": "additions", "startLine": 1, "endLine": 30,
          "note": "the sequence number every later slice reads"
        }
      ]
    }
  ]
}
```

In a comment, `severity`, `tag`, `evidence` and `postable` are optional. `rvw schema --json` is the authority on field rules; read it rather than guessing.

Every prose field (the overview body, a layer description, a comment's body, evidence and postable) is markdown: CommonMark plus GFM. A link to a path is a file reference. In the overview body, a layer description and a comment's `postable`, the gate checks every reference: it must name a file in the diff, or the gate refuses the draft. Write references inline, `[label](path)`; the gate refuses a reference-style definition (`[label]: path`) in those fields. An `https://` link opens in the browser.

A reference can name lines too: `[the caller](src/worker.ts:88)`, a range with `[…](src/worker.ts:88-91)`, and the pre-change side with `[…](src/worker.ts:88-91@deletions)` (additions is the default). The gate places that range against the diff exactly as it places a comment anchor, and the reader lands on the line. Any other suffix is refused.

## Three parts, three jobs

Each part of a review has one job and a length. A part that runs past its length is usually doing another part's job.

| Part | Its job | Length |
|---|---|---|
| Overview `body` | Why the change exists and whether it should land | 100–250 words |
| Layer `summary` | The point of one chapter | one line, about 12 words |
| Layer `description` | What to know before reading the chapter's code | up to 60 words, or absent |
| Range `note` | What one file contributes to its chapter | one line, at most 120 characters |
| Comment `body` | One finding: what breaks, and on what | a bold claim plus 20–80 words |
| Comment `evidence` | What proves the finding | the command and the few output lines that show it |
| Comment `postable` | One finding, for the change's author | 20–100 words; a fenced fix snippet is allowed |

Pseudocode, a trace table or a diagram sits outside these counts; its own section says when one earns its place.

Say each thing once, in the part that owns it. The overview does not restate findings, a description does not restate its summary, and a comment does not re-explain the change.

## The prose

Write so the reader understands on the first read. Every word earns its place, and the result still sounds like a colleague explaining the change at a desk: direct, specific, unhurried. Cryptic fails the same way padded does, because both cost the reader a second read.

Cut:

- Warm-up and wind-down: "This PR…", "In this change…", "It's worth noting that", "Overall…", a closing recap of what you just said.
- Restating the diff. The reader can see what changed. Say why, and what follows from it.
- Praise and hype: "clean", "robust", "massively improves".
- Hedges: "might potentially", "should probably be fine". State what you did not check as a fact: "I did not run the Postgres path."
- Filler and inflated words: "in order to", "basically", "simply", "just", "utilize", "leverage", "crucial", "serves as". Write "to", "use", "is".
- Abstractions where a real name exists: "the abstraction layer", "the refactored logic", "improves maintainability". Name the symbol, the file or the behavior. A sentence that could sit unchanged in another review says nothing about this one.
- An adjective where a number exists: "3 s per query", not "slow".
- Formatting as decoration: a bold label on every bullet, a heading over every paragraph, ideas forced into groups of three.

Keep:

- Full sentences, with their articles and verbs: "Remove the backup file", not "Remove backup file". No telegraphese, no arrows standing in for verbs.
- A term the reader may not know, defined once where it first appears. Shorthand you coined while reviewing means nothing to the reader.
- One name per thing. If it is "the gate" in the overview, it is "the gate" in every comment.
- The actor in the sentence: "the parser now rejects trailing commas", not "trailing commas are no longer accepted".
- Every "it" and "this" pointing at one obvious noun. Repeat the noun when in doubt.
- One thought per sentence. Split a sentence the reader has to re-parse; keep a long sentence that carries one fact with its condition.
- The plain word for a bad thing ("wrong", "bug", "missing"), and the problem before the fix.

## The overview

Build the body in this order: one paragraph of answer, a short list of supporting points, the list of what you checked, one sentence of verdict.

- Title the review with the change, not a category: "Replace the polling loop with a socket subscription", not "Networking changes".
- Make the first sentence state what the change does and why it exists: the bug, limit or pressure that forced the work. A reader who stops there can still describe the change to someone else. If you cannot write that sentence, you do not yet know what the change is; work that out first.
- Follow it with two to four supporting points: the approach, the decision that mattered and what it displaced, the consequence for callers. Set them as a markdown list when each is a separate claim. Each point stands alone, and all of them sit at one level of abstraction: not "moved retry logic behind an interface" beside "renamed a variable". Order them deliberately: dependency before dependent, cause before effect, or largest consequence first.
- Give the reader what they need before line one of the diff: the assumption that changed, the invariant now enforced.
- Name the tradeoff you accepted and what you deliberately did not do. If this should have been two changes, say so and say where the seam is. The diff can show neither.
- List what you checked and found sound: three to six items, each one thing you actually did. A review with few comments needs this most, because it is how the reader tells clean from unread.
- Name the tests that pin the behavior and say whether you ran them. Link a test the change touched as a file reference, so the gate checks the name. Put an unchanged test in plain backticks, because a path outside the diff fails the gate.
- End with the verdict in one sentence: whether this lands as is, and if not, the one thing that stops it. Not a score, a percentage or an estimate.
- Set `verdict` to `ready`, `caution` or `blocked` as shorthand for that sentence. The app shows it as a chip on the review and on the reader's list of waiting reviews. Land it as it stands → `ready`; landable once the reader has read the comments → `caution`; something has to change first → `blocked`. Nothing computes or checks it and no comment severity rolls up into it, so never let the chip replace the sentence, and leave it out rather than guess.
- Leave to the app what the app derives. Do not list the layers or preview the walkthrough, and do not count files, lines, comments or commits. That rule is about the diff's size, which the app measures; a verdict, or a number about behavior ("3 s per query"), is yours to state. Do not inventory paths or narrate file moves: "Split parsing out of the client so the worker can reuse it" beats naming directories.

## Comments

Anchor to the smallest span that carries the point; `side` is `additions` or `deletions`. A comment is read beside the code, and a card that turns into a document stops being a comment.

- Open the body with a bold three-to-seven-word claim on its own line: what is wrong, not where. The rail previews that line as plain words, so spend it on the conclusion.
- Under it, say why, not what. Name what breaks and on what: the input, state or sequence that reaches this code, and the wrong result it produces. If you cannot name one, you have a question and not a finding; say which.
- A `symbol`, a short list or a fenced snippet of the fix all render. Use one when it is shorter than the sentence it replaces.
- One comment per issue. Anchor it to the clearest instance and name the other sites as references (`[the same check in the worker](src/worker.ts:88-91)`) instead of repeating the paragraph. A finding that spans two places, such as where a value is produced and where it is misused, is also one comment: one end is the anchor and the other is a reference.
- A finding in code this change did not touch is still a finding, and the reader must not blame the change for it. Anchor it to the nearest changed or context line in the same file and tag it `pre-existing`. Any line inside a hunk places, context lines included.

Four optional fields sharpen a comment. Absent is a real answer for each of them.

- **`tag`** is a short free-form label, shown as a pill. Use one only when it changes how the reader reads the comment; a tag on every comment is noise. The app knows three: `pre-existing`, `decision` (a call the reader has to make, such as a threshold, a default, a name or a dropped case; nothing is broken yet) and `question` (you could not tell from the diff, and the answer decides whether this is a finding). Anything else is your own vocabulary and is printed as written. The label goes here, never in bold at the head of the body, which belongs to the claim.
- **`severity`** is `blocking`, `important` or `minor`, and only if your review already ranks findings. P0, critical, must-fix → `blocking`; P1, major, high → `important`; P2 and below, nit, info → `minor`. Unset is honest, and every comment at one level says the same as none. Severity never reorders the review; the order is yours.
- **`evidence`** is what you ran or read to confirm the finding. It renders folded under the body, so the body stays the sentence and the receipts wait for a reader who doubts you.
- **`postable`** is the comment as it would be posted to the author of the change. When the review is of someone else's change (a pull request, which you emit with `--pr`, or the user asked for postable comments), write it on every comment the reader might post. When you review the user's own branch, leave it out, because nobody posts those. The app shows it on its own under the finding, and copies or posts exactly it, never `body`.
  - Write it to the author, the way a careful human reviewer writes on a pull request: the problem, why it matters, and what to do, in the second person or impersonally. Make it courteous and specific. It is not a copy of `body`, and it never mentions how the finding was reached: no agent, no review, no tour, no evidence, no "I ran".
  - If the user gave you a writing guide or tone rules for comments to authors, follow them for `postable`, ahead of the advice in this bullet.
  - Write it now or not at all. The reader can refine or remove a `postable` in the app, but cannot add one, so a comment without it is a comment they will not post.
  - A file reference such as `[the caller](src/worker.ts:88-91)` is fine. The gate checks it like any other reference, and the app rewrites it into a form that works where the comment is posted.
  - On a `question`-tagged comment, `postable` asks the author the question.

## Layers

**Write layers by default.** They make this a tour instead of a list of comments: the diff cut into chapters, in an order you chose. Leave `layers` out only when the user or the project's rules asked for comments alone, or when the change is one thought (a one-file fix, a config bump).

A layer is `{ label, summary?, description?, ranges?, children?, skim? }`, and nesting is structural, through `children`. Only `label` is required. Omit `ranges` on a grouping layer whose children carry them, and omit `children` on a leaf. A range is `{ file, side, startLine, endLine, note? }`.

- Group by what changed and why (a capability added, a bug fixed, a migration, a constraint now enforced). Never group by folder, file type or filename, never make one layer per file, and never order alphabetically or by path. One layer can span many files, and one file can appear in several layers when it plays several parts.
- Order the layers so each chapter is understandable from the ones before it: the contract (a type, schema, interface or config) before the code that consumes it, the behavior change before the call sites it forced, the fix before the tests that pin it.
- Every changed line belongs to exactly one chapter's reasoning: never explained under two layers, never left out silently. If two layers would explain the same decision, they are one layer. The app shows what you leave unplaced as "Not covered by layers", so make an omission a decision and not an oversight.
- Put the mechanical remainder (lockfiles, generated output, a rename sweep, a formatting pass) in one trailing layer marked `"skim": true`. One layer holds all of it. The app marks its heading `Skim`, opens its files folded in the diff, and still counts its lines as covered. `skim` means "there is nothing here to read", never "there is a lot here to read".
- Keep the list flat. Nest only when the parent makes a point of its own and each child is a distinct step in that point, never to shorten a list.
- Make the `summary` claim something: "Retries now back off per host", not "Updates to client.ts". If it could label any diff, rewrite it.
- Use the `description` for what you would say out loud before the reader looks: why the slice exists, what to notice, where it gets subtle. It must land for someone who has not opened the diff, so no "here you can see", "below" or "as shown". It adds to the summary and never restates it. Leave it off when the summary is enough.
- Put a `note` on a range when the file's part in the chapter is not obvious from its name: what the file contributes, not what changed in it. The note prints on that file's row in the overview, beside its `+`/`−` counts. Write notes where the file list is long or the paths are opaque, and skip them where the summary already covers every file. They pay off most on the skim layer: `bun.lock`, "axios 1.6 → 1.7, one transitive bump". Only the first note on a file is read, per layer.

## Pseudocode, traces and diagrams

Most reviews need none of these. Each earns its place only by showing something the diff cannot show in one place. Put it in the description of the layer that owns the code, and use the overview body only for behavior the whole change turns on.

- **Pseudocode**, when a layer's control flow is hard to scan: a few lines with the syntax, the error handling and the boilerplate stripped, so the reader can confirm the intent before reading the real code.
- **A trace**, when behavior changes in a way the diff does not make obvious: one small concrete input followed through the old path and the new one (a GFM table works well), naming the step where they diverge.
- **A diagram**, when the flow crosses files or processes: a sequence, a state machine, a data path. Never the file layout or the call graph, which the layers already show, and never a picture of what one hunk already says. A diagram that restates the diff goes stale, and no gate catches it. Keep it to about ten nodes. Write it as a ```` ```mermaid ```` fence. The app draws a diagram in the overview body and in a layer `description` only; in a comment the fence stays source text, so never put one there.

## Emitting

One call. The draft goes in on stdin and the app opens:

```
rvw emit --open <<'JSON'
{ ... }
JSON
```

If your shell refuses the heredoc, write the draft to a file inside the working directory and pass `--draft <file>`. `--open` is the default; pass `--no-open` to write without opening. Run `rvw <verb> --help` for flags.

The range is auto-detected (the cwd's repo, the current branch, the fork point against its upstream or the default branch) and echoed back so you can check it. Pass `--repo`, `--base` or `--head` only to override, and name a branch when a branch is what you mean: a local branch is recorded as written and the review follows it, while a tag, `HEAD`, `main~3`, `origin/main` or a sha is pinned to the commit it resolved to. Any revision git understands is accepted.

When the review is of a pull request, pass `--pr` with its URL, `owner/repo#123` or its number (a bare number takes the repository from the `origin` remote, so when `origin` is a fork, pass `owner/repo#123` or the URL), and write `postable` on each comment (see Comments). The app then links every comment to its lines on the pull request.

Without `--out` the artifact lands in `~/.rvw/reviews/`, where the app's Recent Reviews picker (⇧⌘R) finds it. Pass `--out` only when someone asked for the file somewhere specific.

If the reader will open the review on a different machine from the one that emits it (CI, a container, a remote box), add `--embed-patch`, which carries the diff inside the artifact. The app still prefers the reader's checkout when it has one, so embedding costs the reader nothing. On a platform without the app (Linux), pass `--no-open` and name the written path in your reply so the reader can carry the file over.

Outcomes:

- **Exit 0**: the review was written and opened.
- **Exit 1**: the gate refused the draft and **nothing was written**. Each problem is printed with its locator: a file, side and line span for a comment, or an ordinal path like `4.2.1` for a layer range, pointing at that position in the `layers` array you wrote. Fix the draft and re-run.
- **Exit 2**: the invocation could not run.

An anchor that will not place is printed with the nearest hunks on its file and side. Move it inside one: an anchor sits within a single hunk, and context lines count. `rvw diff` prints the exact diff the gate validates against; `rvw diff --json` lists the changed spans per file and side.
