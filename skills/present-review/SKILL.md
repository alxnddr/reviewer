---
name: present-review
description: How to present a review you have already performed in the Reviewer app (an overview, line-anchored comments and a layer tour of the diff), published with `rvw emit`. Read it before writing the draft.
disable-model-invocation: true
---

# present-review

You have already reviewed the change. This skill turns your findings into a review the user reads in the Reviewer app. **It does not perform the review.** If you have not reviewed the change yet, stop: run the review command or skill your harness provides, with the project's own guidelines if it has any (`CLAUDE.md`, `AGENTS.md`, `.cursor/rules`, `CONTRIBUTING.md`), and come back with findings.

`rvw` is the CLI that publishes the draft. If it is not on your `PATH`, run `node /Applications/Reviewer.app/Contents/Resources/cli/rvw.js` on macOS, or `node ~/.local/share/rvw/<version>/cli/rvw.js` on Linux.

## The draft

One JSON object with three keys you author: `overview`, `comments`, `layers`. `rvw emit` supplies `repo`, `base` and `head`, and refuses any key it does not know, at any level.

```json
{
  "overview": {
    "title": "Replace the polling loop with a socket subscription",
    "body": "...", "verdict": "caution"
  },
  "comments": [
    {
      "file": "src/queue.ts", "side": "additions", "startLine": 88, "endLine": 91,
      "body": "**A reconnect replays every acked event**\n\nWhy.",
      "severity": "blocking",
      "evidence": "```\n$ bun test queue\n✗ resumes from the last acked offset\n  expected first event seq 42, received 1\n```"
    }
  ],
  "layers": [
    {
      "label": "Subscription contract",
      "summary": "Events carry a sequence number so a reconnect can resume",
      "description": "Sequence numbers count per stream, not globally, so a client resumes each stream on its own.",
      "ranges": [
        {
          "file": "src/protocol.ts", "side": "additions", "startLine": 12, "endLine": 30,
          "note": "the sequence number every later slice reads"
        }
      ]
    }
  ]
}
```

An anchor (a comment's, or a layer range) is `file`, `side` (`additions` or `deletions`), `startLine`, `endLine`, and it sits inside one hunk of the diff; context lines count. `rvw diff --json` lists each file's hunks and changed lines per side: place anchors from it. `tag` is at most 24 characters, a range `note` at most 120, and layers nest at most 5 deep. If a refusal surprises you, `rvw schema --json` has every field rule.

Prose fields are markdown (CommonMark plus GFM). A link to a path is a file reference, and it can name lines: `[the caller](src/worker.ts:88)`, `[…](src/worker.ts:88-91)`, or the pre-change side with `[…](src/worker.ts:88-91@deletions)`; any other suffix is refused. In the overview body, a layer description and `postable`, a reference takes the reader to the line, and the gate refuses one whose file is not in the diff or whose lines do not place. Write it inline: the gate refuses a reference-style definition (`[label]: path`). In a comment body and in evidence, a reference shows only its label and nothing checks it, so write a location there in backticks: `src/worker.ts:88`. An `https://` link opens in the browser.

## Three parts, three jobs

Each part has one job and a length. A part that runs past its length is usually doing another part's job.

| Part | Its job | Length |
|---|---|---|
| Overview `body` | Why the change exists and whether it should land | 100–250 words |
| Layer `summary` | The point of one chapter | one line, about 12 words |
| Layer `description` | What to know before reading the chapter's code | up to 60 words, or absent |
| Range `note` | What one file contributes to its chapter | one line |
| Comment `body` | One finding: what breaks, and on what | a bold claim plus 20–80 words |
| Comment `evidence` | Proof the card cannot show | the command and the few output lines that show it, or absent |
| Comment `postable` | One finding, for the change's author | 20–100 words; a fenced fix snippet is allowed |

Say each thing once, in the part that owns it. The overview does not restate findings, a description does not restate its summary, and a comment does not re-explain the change.

## The prose

Write so the reader understands on the first read, like a colleague explaining a change at a desk: direct, specific, unhurried. Cryptic fails like padded does: both cost a second read.

Cut:

- Warm-up, recap, praise, hedges and filler: "This PR…", "Overall…", "clean", "robust", "should probably be fine", "in order to", "leverage". State what you did not check as a fact: "I did not run the Postgres path."
- Restating the diff. Say why, and what follows from it.
- Abstractions where a real name exists: "the refactored logic", "improves maintainability". A sentence that could sit unchanged in another review says nothing about this one.
- An adjective where a number exists: "3 s per query", not "slow".
- Formatting as decoration: a bold label on every bullet, a heading over every paragraph, ideas forced into threes.

Keep full sentences with their articles and verbs (no arrows standing in for verbs), one name per thing across the whole review, a definition for any term the reader may not know (shorthand you coined while reviewing means nothing to them), and the plain word for a bad thing: "wrong", "bug", "missing".

## The overview

Build the body in this order: one paragraph of answer, a short list of supporting points, what you checked, one sentence of verdict.

- Title the review with the change, not a category ("Networking changes").
- Make the first sentence say what the change does and why it exists: the bug, limit or pressure that forced the work. If you cannot write that sentence, you do not yet know what the change is.
- Follow with two to four supporting points at one level of abstraction, cause before effect or largest first, picked from what the reader needs before line one of the diff: the approach, the decision that mattered and what it displaced, the invariant now enforced, the consequence for callers, and, if there is one, the tradeoff accepted or the seam where this should have been two changes.
- List what you checked and found sound, under a short lead-in such as "Checked:": up to six items, each one thing you actually did, including which tests you ran and which you did not. A short true list is how the reader tells clean from unread. Link a test the change touched as a reference; put an unchanged one in backticks, because a reference outside the diff fails the gate.
- End with the verdict in one sentence: whether this lands as is, and if not, the one thing that stops it.
- Set `verdict` as shorthand for that sentence: no comments, or only follow-ups that can wait → `ready`; a comment the reader should act on or decide before merging → `caution`; something must change first → `blocked`. Nothing computes it from severities.
- Do not list the layers, count files, lines, comments or commits, or narrate paths; the app shows those.

## Comments

Anchor to the smallest span that carries the point. The app shows comments in diff order, by file and line, whatever order you write them in.

- Open the body with a bold three-to-seven-word claim on its own line: what is wrong, not where. The rail previews that line, so spend it on the conclusion.
- Under it, say why. Name what breaks and on what: the input, state or sequence that reaches this code, and the wrong result. A cleanup that breaks nothing (dead code, a misleading name) qualifies only if you can name its concrete cost to the next reader or change; taste does not. If you can name neither, you have a question; tag it so.
- A `symbol`, a short list or a fenced snippet of the fix all render. Use one when it is shorter than the sentence it replaces.
- One comment per issue. Anchor the clearest instance and name the other sites in backticks (`src/worker.ts:88-91`) instead of repeating the paragraph. A finding with two ends, such as where a value is produced and where it is misused, is one comment anchored at one end.
- A defect the change did not introduce is `pre-existing`, even on a line the change rewrote; tag it so the reader does not blame the change. Anchor it on the nearest changed or context line in the same file. If the file is not in the diff at all, an anchor there is refused: anchor on the changed line that reaches it (the call, the import) and name the file in backticks, or put the finding in the overview.

Four optional fields sharpen a comment. Absent is a real answer for each.

- **`tag`** is a free-form label shown as a pill. Use one only when it changes how the comment is read; a category ("performance", "naming") rarely does. The app knows three: `pre-existing`, `decision` (a call the reader has to make, such as a threshold or a dropped case; nothing is broken yet) and `question` (the answer decides whether this is a finding).
- **`severity`** is `blocking`, `important` or `minor`, and only if your review already ranks findings: P0, critical, must-fix → `blocking`; P1, major, high → `important`; P2 and below, nit, info → `minor`. Leave it unset rather than guess. Giving every comment the same severity tells the reader nothing.
- **`evidence`** is proof the reader cannot get from the card: the output of something that ran or searched the code exhaustively (a failing test, a repro script, a build, a search that lists every caller or shows there are none), or lines from outside the diff that the finding depends on, headed by their `path:line`. Paste it verbatim, cut to the lines that show the claim. If it ran a script you wrote, include the script, short, in the evidence; never name a file the reader cannot see. Leave it out when everything the finding rests on is in the diff: the diff's own lines, your reasoning in a code block, or a `cat` of changed code only restate the body, and absent evidence honestly says the finding is reasoned. It renders folded under the body.
- **`postable`** is the comment as it would be posted to the change's author. Write it on every comment the reader might post when the review is of someone else's change (a pull request, emitted with `--pr`) or the user asked for it; leave it out on the user's own branch. The app copies or posts exactly it, never `body`, and the reader can edit or remove it but cannot add one.
  - Write to the author as a careful human reviewer would: the problem, why it matters, what to do, courteous and specific; on a `question`, ask the question. Never say how the finding was reached: no agent, review, tour, evidence or "I ran". Tone rules the user gave for author comments come first.
  - Point at other sites with a reference such as `[the caller](src/worker.ts:88-91)`: the gate checks it, and the app turns it into a link that works on the code host. A reference to a file outside the diff is refused; link that code with a full https permalink pinned to a commit instead.

## Layers

**Write layers by default.** They make the review a tour instead of a list: the diff cut into chapters, in an order you choose. Leave `layers` out only when the user or the project asked for comments alone, or when the change is a single hunk or a config bump. When in doubt, write them: a fix and its test are two short chapters.

A layer is `{ label, summary?, description?, ranges?, children?, skim? }`; only `label` is required, and a grouping layer may leave out `ranges` when a descendant has some.

- Group by what changed and why (a capability added, a bug fixed, a migration, a constraint now enforced). Never by folder, file type or filename, and never one layer per file. One layer can span many files, and one file can appear in several layers when it plays several parts.
- Order the chapters so each is understandable from the ones before it: the contract (a type, schema or config) before its consumers, the behavior change before the call sites it forced, the fix before the tests that pin it.
- Cover every changed line once, in the chapter whose reasoning it belongs to. A range sits inside one hunk, so a file with three hunks takes three ranges. Coverage counts each side separately: a hunk that removes lines needs a `deletions` range beside its `additions` one, or its removed lines read as uncovered. `rvw diff --json` lists exactly what to cover. `rvw emit` reports what no layer covers, and the app lists it as "Not covered by layers"; leave a gap only on purpose.
- Put the mechanical remainder (lockfiles, generated output, a rename sweep, a formatting pass) in one trailing layer marked `"skim": true`. The app opens its files folded and still counts them as covered. It means "nothing here to read", never "a lot here to read".
- Keep the list flat. Nest only when the parent makes a point of its own and each child is a step in it.
- Make the `summary` claim something: "Retries now back off per host", not "Updates to client.ts".
- Use the `description` for what you would say before the reader looks: why the slice exists, what to notice, where it gets subtle. It adds to the summary and must make sense before the diff is open, so no "below" or "as shown". Leave it off when the summary is enough.
- Put a `note` on a range when the file's part is not obvious from its name: what it contributes, not what changed. It prints beside the file's counts in the overview; only the first note on a file per layer shows. Notes pay off most on the skim layer: `bun.lock`, "axios 1.6 → 1.7, one transitive bump".

## Pseudocode, traces and diagrams

Most reviews need none. Each earns its place by showing what the diff cannot show in one place, in the description of the layer that owns the code (the overview only for behavior the whole change turns on): pseudocode for control flow that is hard to scan; a trace of one small input through the old path and the new, naming where they diverge; a diagram of a flow across files or processes, about ten nodes, as a ```` ```mermaid ```` fence, never the file layout. The app draws diagrams in the overview body and layer descriptions only; in a comment the fence stays source text.

## Emitting

```
rvw emit --base main <<'JSON'
{ ... }
JSON
```

The draft goes in on stdin, or with `--draft <file>` if your shell refuses the heredoc, and the app opens on the result (`--no-open` writes without opening).

**Name the range you reviewed.** The diff is `base...head`, what `head` adds since it forked from `base`, and holds committed history only: uncommitted edits are never in it. Run from the checkout you reviewed or pass `--repo`, and pass `--base` with what you reviewed against (`main`, or a pull request's base such as `origin/main`); `--head` defaults to the current branch. Without `--base`, `rvw` guesses a fork point and prints the ref it used; check it. `rvw diff` takes the same flags and prints the exact diff the gate checks against.

For a pull request, also pass `--pr` with its URL or `owner/repo#123`, and write `postable` on each comment.

Without `--out` the artifact lands in `~/.rvw/reviews/`, where the app's Recent Reviews (⇧⌘R) finds it. For a review opened on another machine (CI, a container), add `--embed-patch`. On Linux there is no app: pass `--no-open` and name the written path in your reply.

Exit 1 means the gate refused the draft and **nothing was written**: each problem names its place (file, side and lines for a comment; for a layer range, the layer's position in your `layers` tree and the range's position in that layer), and an anchor that does not place comes with the nearest hunks on its file and side. Fix every problem and re-run.
