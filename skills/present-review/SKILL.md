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
    "lede": "Clients polled `/events` every 2 s and missed events between polls; they now hold one socket and resume by sequence number.",
    "steps": [
      "Events carry a per-stream sequence number",
      "The client subscribes once and resumes from the last acked number",
      "The polling loop and its timer are deleted"
    ],
    "visual": {
      "kind": "flow", "caption": "How an event reaches the client",
      "nodes": [
        { "id": "server", "label": "EventServer", "status": "same" },
        { "id": "sub", "label": "subscribe()", "status": "added", "note": "one socket per client",
          "at": { "file": "src/client.ts", "side": "additions", "startLine": 40, "endLine": 52 } },
        { "id": "poll", "label": "pollLoop()", "status": "removed",
          "at": { "file": "src/client.ts", "side": "deletions", "startLine": 31, "endLine": 44 } }
      ],
      "edges": [
        { "from": "server", "to": "sub", "label": "events", "status": "added" },
        { "from": "server", "to": "poll", "status": "removed" }
      ]
    },
    "body": "Checked: ...", "verdict": "caution"
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
      "label": "Number events per stream",
      "summary": "Events carry a sequence number so a reconnect can resume",
      "description": "Sequence numbers count per stream, not globally, so a client resumes each stream on its own.",
      "ranges": [
        { "file": "src/protocol.ts", "note": "the sequence number every later slice reads" },
        { "file": "src/server.ts", "side": "additions", "startLine": 40, "endLine": 52 }
      ],
      "focus": { "file": "src/protocol.ts", "side": "additions", "startLine": 12, "endLine": 30 },
      "visual": {
        "kind": "skeleton", "caption": "What publish() now does",
        "lines": [
          { "depth": 0, "code": "publish(stream, event)", "status": "same" },
          { "depth": 1, "code": "nextSeq(stream)", "status": "added", "note": "per stream, not global",
            "at": { "file": "src/protocol.ts", "side": "additions", "startLine": 18, "endLine": 18 } },
          { "depth": 1, "code": "socket.send(event)", "status": "same" }
        ]
      }
    }
  ]
}
```

An anchor (a comment's, a line range, a layer `focus`, or a visual element's `at`) is `file`, `side` (`additions` or `deletions`), `startLine`, `endLine`, and it sits inside one hunk of the diff; context lines count. `rvw diff --json` lists each file's hunks and changed lines per side, and `pairs` gives each hunk's two sides together: place anchors from it. A layer range may instead be `{ "file": path }` alone, which covers every changed line of that file on both sides. A `focus` or an `at` names the file by its path after the change, as a range does. `tag` is at most 24 characters, a range `note` at most 120, and layers nest at most 5 deep. The overview's `lede` is one line of at most 220 characters, and `steps` holds 2 to 5 lines of at most 110 each. If a refusal surprises you, `rvw schema --json` has every field rule.

Prose fields are markdown (CommonMark plus GFM). A link to a path is a file reference, and it can name lines: `[the caller](src/worker.ts:88)`, `[…](src/worker.ts:88-91)`, or the pre-change side with `[…](src/worker.ts:88-91@deletions)`; any other suffix is refused. In the overview's `lede`, `steps` and `body`, a layer `summary` and description, and `postable`, a reference takes the reader to the line, and the gate refuses one whose file is not in the diff or whose lines do not place. Write it inline: the gate refuses a reference-style definition (`[label]: path`). In a comment body and in evidence, a reference shows only its label and nothing checks it, so write a location there in backticks: `src/worker.ts:88`. An `https://` link opens in the browser. `lede`, `steps` and a layer `summary` render inline on one line, so keep them to text, code spans and references; the gate refuses block syntax there (a leading `#`, `>`, `-` or `1.`, a code fence, a `---` rule), and the app numbers the steps itself. A visual's text (`caption`, `label`, `code`, `note`) is plain text, not markdown: the app draws backticks and `**` as-is, so the gate refuses them. Write `fetchBlob()`, not `` `fetchBlob()` ``.

## Three parts, three jobs

Each part has one job and a length. A part that runs past its length is usually doing another part's job.

| Part | Its job | Length |
|---|---|---|
| Overview `lede` | What the change does and why it exists | one sentence, at most 220 characters |
| Overview `steps` | The steps the change takes, in order | 2 to 5 lines, each at most 110 characters |
| Overview `visual` | The shape of the change: before and after | one flow or one skeleton |
| Overview `body` | Reviewer's notes: what you checked, the verdict sentence | up to 80 words, or absent |
| Layer `label` | The chapter's name, as a verb phrase | 3 to 7 words |
| Layer `summary` | The point of one chapter | one line, about 12 words |
| Layer `description` | What it does, then the one invariant or edge case to watch | up to 70 words in at most two short paragraphs, or absent |
| Layer `focus` | The one hunk that represents the chapter | one anchor, or absent |
| Range `note` | What one file contributes to its chapter | one line |
| Comment `body` | One finding: what breaks, and on what | a bold claim plus 20–80 words |
| Comment `evidence` | Proof the card cannot show | the command and the few output lines that show it, or absent |
| Comment `postable` | One finding, for the change's author | 20–100 words; a fenced fix snippet is allowed |

Say each thing once, in the part that owns it. The overview does not restate findings, the steps do not restate the lede, a description does not restate its summary, and a comment does not re-explain the change.

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

Readers do not read a page of prose before the diff. They read one sentence, a few numbered steps and a picture, then go to the code. Write the overview in that order: `lede`, `steps`, `visual`, then the optional notes in `body`.

- Title the review with the change, not a category ("Networking changes").
- Make the `lede` say what the change does and why it exists: the bug, limit or pressure that forced the work. If you cannot write that sentence, you do not yet know what the change is.
- Write 2 to 5 `steps`: what the change does, in the order it happens or the order a reader should learn it, each one line that names the real thing (`withRetry`, the `/events` route). A step is an action, not a file ("Reads go through `withRetry`", not "Changes to client.ts").
- Draw one `visual` of the change's shape (see Visuals below). Leave it out only when the change has no shape to draw, such as a one-line fix or a dependency bump.
- Keep `body` to the reviewer's notes, up to 80 words: what you checked and found sound, under a short lead-in such as "Checked:" (each item one thing you actually did, including which tests you ran and which you did not), and one sentence of verdict: whether this lands as is, and if not, the one thing that stops it. The app shows it folded at the end. Link a test the change touched as a reference; put an unchanged one in backticks, because a reference outside the diff fails the gate.
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

A layer is `{ label, summary?, description?, ranges?, focus?, visual?, children?, skim? }`; only `label` is required, and a grouping layer may leave out `ranges` when a descendant has some.

- Group by what changed and why (a capability added, a bug fixed, a migration, a constraint now enforced). Never by folder, file type or filename, and never one layer per file. One layer can span many files, and one file can appear in several layers when it plays several parts.
- Order the chapters so each is understandable from the ones before it: the core change first, then the contract (a type, schema or config) before its consumers, the behavior change before the call sites it forced, the fix before the tests that pin it. Tests, generated output and docs go last.
- Cover every changed line once, in the chapter whose reasoning it belongs to. When a chapter owns a whole file, write `{ "file": path }`: one range for every hunk on both sides. Write line ranges only for a file split across chapters. A line range sits inside one hunk and covers one side, so cover a split file's hunks from `rvw diff --json`'s `pairs`, a `deletions` range beside each `additions` one where lines were removed. Lines covered twice belong to the more specific claim: a child's range takes them from its parent's, and between chapters at the same depth a line range takes them from a whole-file range, so a split file can be `{ "file": path }` in the chapter that owns most of it and line ranges in the others. Comments, badges and the gate's `focus` rule all follow that ownership. `rvw emit` reports what no layer covers, and the app lists it as "Not covered by layers"; leave a gap only on purpose.
- Put the mechanical remainder (lockfiles, generated output, a rename sweep, a formatting pass) in one trailing layer marked `"skim": true`. The app opens its files folded and still counts them as covered. It means "nothing here to read", never "a lot here to read".
- Keep the list flat. Nest only when the parent makes a point of its own and each child is a step in it.
- Name the chapter with a verb phrase: "Stage and upload shared files", not "Upload" or "Share handling".
- Make the `summary` claim something: "Retries now back off per host", not "Updates to client.ts".
- Use the `description` for what you would say before the reader looks: what the chapter does, then the one invariant or edge case to watch. Two short paragraphs at most, 70 words in all. It adds to the summary and must make sense before the diff is open, so no "below" or "as shown". Leave it off when the summary is enough.
- Set `focus` to the one hunk that best shows the chapter. Its lines must belong to the chapter: covered by its own ranges or a child's, and not claimed more specifically by another chapter (a deeper one, or a line range where this chapter has only a whole-file range). The gate refuses any other focus and names the chapter that owns it. The app shows that hunk beside the chapter's prose; without it, the app picks a declaration in the chapter's largest file, which may not be the point.
- Give a chapter its own `visual` only when its shape is the hard part, such as a new call path through three files. Most chapters need none.
- Put a `note` on a range when the file's part is not obvious from its name: what it contributes, not what changed. It prints beside the file's counts in the overview; only the first note on a file per layer shows. Notes pay off most on the skim layer: `bun.lock`, "axios 1.6 → 1.7, one transitive bump".

## Visuals

A visual is a picture of the change's shape that the gate proves against the diff. It is data, not a drawing: you name the boxes or lines and where their code is, and the app lays it out.

- Use a **`flow`** when the change is about who calls whom or how data travels: nodes are the functions, components or processes involved (a `label` of at most 40 characters, such as `useShareSend()`), edges the calls or the data between them (an edge `label` of at most 16 characters, such as `files`). 2 to 14 nodes and up to 20 edges; each node has a unique slug `id`, and an edge names two different nodes by `id`.
- Use a **`skeleton`** when the change is about what one function now does: its call tree with no bodies, one signature or call per line (`code` of at most 90 characters), indented by `depth` 0 to 6, 2 to 18 lines. There is no `changed` line: a line that changed is a `removed` line beside an `added` one, as in a diff.
- Mark each element's `status`: `added`, `removed`, or `same` (a flow node may also be `changed`). Include the unchanged neighbors that make the picture readable, such as the caller the new code hangs off, and no more.
- **Every node or line whose status is not `same` carries `at`**, an anchor on its code, and every `at` must place; the gate refuses a changed element without one.
- **The `at` must show what the status claims.** An `added` element points at added lines on `additions`, a `removed` one at removed lines on `deletions`, and a `changed` node at a range with at least one changed line. A range of only context lines is refused.
- An edge may carry `at` too, at the call site or channel where the change lives, under the same rules. An unchanged hop (a `same` node or edge) may leave `at` out; it then shows no chapter badge.
- Do not write chapter numbers. The app badges each element with the chapter whose ranges cover its `at`, so the picture works as a table of contents into the layers. An `at` no layer covers gets no badge.
- A `caption` (at most 80 characters) says what the picture shows, as a phrase: "How a blob read reaches the network". A `note` (at most 60 characters on a node, 80 on a line) adds a few words where the label cannot say it.

Use a `visual` instead of a ```` ```mermaid ```` diagram. The app still draws mermaid in the overview `body` and layer descriptions, but nothing checks it. For control flow that is hard to scan, pseudocode or a trace of one small input through the old path and the new can still go in the description of the layer that owns the code.

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

Exit 1 means the gate refused the draft and **nothing was written**: each problem names its place (file, side and lines for a comment; for a layer range, the layer's position in your `layers` tree and the range's position in that layer; for a visual, the overview's or the layer's, and the node's `id`, the edge as `from→to`, or the line's position). An anchor that does not place comes with the nearest hunks on its file and side. Every position counts from 1, schema paths too: `layers#2.ranges#1.side` is the second layer's first range. Fix every problem and re-run.
