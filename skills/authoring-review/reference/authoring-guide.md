# Authoring the artifact

The review is already done — this file is the craft of **presenting** it: the exact `draft.json`
shape, how to nest layers, the chapter `description` grammar, how to phrase a comment, and the
anchoring contract the gate enforces. The layering _principles_ (foundation before dependents,
story over structure) live in SKILL.md Step 2; this is the shape behind them.

## Contents

- The `draft.json` shape
- Nesting layers with rollups
- Writing a chapter `description`
- Phrasing a comment
- The anchoring contract

## The `draft.json` shape

You author exactly two keys. Everything else (`version`, `source`) `rvw emit` supplies, and the
artifact is refs-only — the app re-derives the diff from the branch on open — so you never write
or paste a patch.

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
- `kind` is a free label you choose (`feature`, `validation`, `refactor`, …); the app maps it to
  an icon. Pick the word that names the slice.
- `parent` (optional) points at another layer's `id` to nest granularity.
- `description` is optional but is what makes a layer worth reading — author one per substantive
  layer.

## Nesting layers with rollups

When a theme spans many hunks, make a parent layer and hang the pieces off it. The parent carries
empty `ranges` and a `summary` naming the theme; each child sets `parent` to the parent's `id`
and carries the actual ranges. A parent with empty `ranges` is valid — it is a chapter heading,
not a "nothing placed" failure. The array stays flat and **ordered**; nesting is expressed only
through `parent`, and the app renders parents and children in the sequence you emit.

## Writing a chapter `description`

`summary` is the one-line label in the layer list. `description` is the long-form prose the app
renders **above the diff** when the layer is active — the "why this slice" a good reviewer says
out loud. Make it reading context: what this slice does, why it is grouped, what to notice.

The grammar is a deliberately small markdown-lite tier — **only** these, nothing else:

- **Paragraphs** separated by a blank line. A single newline inside a paragraph is a soft wrap.
- **Inline `` `code` ``** for a symbol or a filename (mono; if the text names a file in the diff
  it becomes a clickable chip).
- **`[label](path)` links** whose `path` is a file **present in this diff** — it renders as a
  clickable chip that navigates the diff to that file.

Not in the grammar (do not use): headings, lists, bold/italic, block quotes, code fences, and
external URLs. A `[label](path)` to a path **not** in the diff renders dead and **fails the gate**
— link only to files the range actually touches.

## Phrasing a comment

The finding is already decided; a comment is its anchor plus its reason. The diff shows _what_
changed — the body says what the diff cannot: _why_ it is right, what it trades off, what to check.

- Anchor tightly — the smallest line span that carries the point, on the correct `side`.
- Body answers **why**. "Guards the empty-tree case so root commits diff" — not "adds an if".
- No restating the line, no narrating the change ("changed X to Y"), no praise.

## The anchoring contract

The gate proves, mechanically, that the artifact opens clean:

- Every comment and every layer range must fall inside a hunk of the range's diff, on its `side`.
  Author every anchor by reading the actual diff line numbers — a guessed line is the exact
  failure the gate catches.
- Every `description` link path must be a file in the diff.
- A parent rollup with empty `ranges` is valid.

If the gate reports a problem, it names the exact locator. Fix `draft.json` and re-run until it
exits 0; only a passed artifact is handed over.
