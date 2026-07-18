# Authoring a great review

What separates a real review from a demo: the layer order is a genuine reading order, each
`description` earns its place as reading context, and every comment says _why_. This file is the
craft behind Step 2.

## Contents

- The `draft.json` shape
- Ordering layers = ordering comprehension
- Writing a chapter `description`
- Minimal-comment discipline
- The anchoring contract

## The `draft.json` shape

You author exactly two keys. Everything else (`version`, `source`) `rvw emit` (Step 4) supplies, and
the artifact is refs-only — the app re-derives the diff from the branch on open — so you never write
or paste a patch. Do not write these keys.

```json
{
  "comments": [
    {
      "file": "src/foo.ts",
      "side": "additions",
      "startLine": 11,
      "endLine": 13,
      "body": "why this, not what"
    }
  ],
  "layers": [
    {
      "id": "core",
      "label": "Core",
      "summary": "one-line list label",
      "kind": "feature",
      "ranges": []
    },
    {
      "id": "core-parse",
      "label": "Parsing",
      "summary": "one-line list label",
      "kind": "validation",
      "parent": "core",
      "description": "The chapter intro the app shows above the diff for this layer.\n\nA second paragraph may reference a file with [parser](src/foo.ts) or a symbol with `parseThing`.",
      "ranges": [{ "file": "src/foo.ts", "side": "additions", "startLine": 11, "endLine": 13 }]
    }
  ]
}
```

Field rules (`rvw schema --json` emits the authoritative shape; `rvw check` enforces it):

- `side` is **`additions`** or **`deletions`** — never `old`/`new`.
- `startLine`/`endLine` are 1-based and **ascending** (`endLine >= startLine`). The number is the
  line in the file on that side — an addition's line in the new file, a deletion's line in the old.
- `kind` is a free label you choose (`feature`, `validation`, `refactor`, …); the app maps it to an
  icon. Pick the word that names the slice.
- `parent` (optional) points at another layer's `id` to nest granularity; a parent may carry empty
  `ranges` and roll up its descendants.
- `description` is optional but is what makes the review worth reading — author one per substantive
  layer.

## Ordering layers = ordering comprehension

`layers` is an **ordered** array and the app renders it verbatim. Order for a first-time
reader, not for the filesystem:

- **Foundation before dependents.** The type/contract/schema a change rests on comes before the code
  that consumes it. A reader who meets the shape first understands every later use for free.
- **Story over structure.** Group by _what changed and why_ (a capability, a fix, a migration), not
  by directory. One layer can span several files; one file can appear in several layers.
- **Rollups for scale.** When a theme spans many hunks, make a parent layer (empty `ranges`, a
  `summary` naming the theme) and nest the pieces under it via `parent`. The parent is the chapter;
  the children are its sections.

A weak division — alphabetical files, one layer per file, a `summary` that restates the filename —
turns the walkthrough into a directory listing. That is the demo you are avoiding.

## Writing a chapter `description`

`summary` is the one-line label in the layer list. `description` is the long-form prose the app
renders **above the diff** when the layer is active — the "why this slice" a good reviewer would say
out loud. Make it reading context: what this slice does, why it is grouped, what to notice.

The grammar is a deliberately small markdown-lite tier — **only** these, nothing else:

- **Paragraphs** separated by a blank line. A single newline inside a paragraph is a soft wrap.
- **Inline `` `code` ``** for a symbol or a filename (mono; if the text names a file in the diff it
  becomes a clickable chip).
- **`[label](path)` links** whose `path` is a file **present in this diff** — it renders as a
  clickable chip that navigates the diff to that file.

Not in the grammar (do not use): headings, lists, bold/italic, block quotes, code fences, and
external URLs. A `[label](path)` to a path **not** in the diff renders dead and **fails the Step 4
gate** — link only to files the range actually touches.

## Minimal-comment discipline

A comment is an anchor plus a reason. The diff already shows _what_ changed; the comment says what
the diff cannot: _why_ it is right, what it trades off, what to check.

- Anchor tightly — the smallest line span that carries the point, on the correct `side`.
- Body answers **why**. "Guards the empty-tree case so root commits diff" — not "adds an if".
- No restating the line, no narrating the change ("changed X to Y"), no praise. If a comment would
  only echo the code, drop it.

## The anchoring contract

The Step 4 gate proves, mechanically, that the artifact opens clean:

- Every comment and every layer range must fall inside a hunk of the range's diff, on its `side`.
  Author every anchor by reading the actual diff line numbers — a guessed line is the exact failure
  the gate catches.
- Every `description` link path must be a file in the diff.
- A parent rollup with empty `ranges` is valid — it is not a "nothing placed" failure.

If the gate reports a problem, it names the exact locator. Fix `draft.json` and re-run until it
exits 0; only a passed artifact is handed over.
