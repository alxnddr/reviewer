# Authoring the artifact

The review is already done — this file is the craft of **presenting** it: the exact `draft.json`
shape, how to nest layers, the prose grammar, how to phrase a comment, and the
anchoring contract the gate enforces. The layering _principles_ (foundation before dependents,
story over structure) live in SKILL.md Step 2; this is the shape behind them.

## Contents

- The `draft.json` shape
- Writing the `overview`
- Nesting layers
- Writing a layer `description`
- Phrasing a comment
- The anchoring contract

## The `draft.json` shape

You author exactly three keys. Everything else (`version`, `source`) `rvw emit` supplies, and the
artifact is refs-only — the app re-derives the diff from the branch on open — so you never write
or paste a patch.

```json
{
  "overview": {
    "title": "Reject logins with no password",
    "body": "The login path now takes a password and refuses an empty one up front.\n\nThe guard lands in [login](src/auth/login.ts); everything downstream is unchanged."
  },
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
- `parent` (optional) points at another layer's `id`, nesting this one under it. See "Nesting
  layers" for the rules the gate enforces.
- `description` is optional but is what makes a layer worth reading — author one per substantive
  layer.
- `overview` is optional; without one the app opens straight on the diff. Author one for any
  review a human will actually read.

## Writing the `overview`

The overview is the **doc the review opens on** — the first thing the reader sees, before any code,
and the one screen where the whole review can be *read* rather than clicked through. It answers
"what is this change, and how should I read it?"

The app renders your `title` and `body`, then continues the same document with **one section per
layer**, in your authored order. Each section is assembled from the layer itself: its label, `kind`,
its `summary` as the deck, **its whole `description` read in full**, the files it covers with that
layer's own `+/−` counts, and its comment count. A nested layer is numbered under its parent
(`4.1`, `4.2.1`) and set at a smaller heading rank, which is how the doc shows what belongs to
what — it never indents a section, so every one is read at the same width. A section's title and
its file rows open that layer in the diff; the reader comes back from the rail or the band's
breadcrumb.

So write the part only you can write, and let the app compute the rest:

- **`title`** — the change as its author would say it out loud ("Reject logins with no password"),
  not a file list and not a commit hash.
- **`body`** — a few paragraphs of orientation: what this does, why it is shaped this way, what
  context the reader needs before line one, and what to look at first. Same markdown grammar
  as a layer `description` (below): paragraphs, `` `code` ``, `[label](path)` links to files in
  the diff, emphasis, lists, headings, quotes, and fences.
- **Do not** enumerate the layers, restate their summaries, or list files — every layer's own
  section already carries all of it, and a hand-written copy goes stale the moment a layer moves.
- **Do not** repeat the findings; comments carry those.

### Never write a number the app can count

Counts are **computed**, always, from the layers and the diff on screen — file counts, `+/−` line
counts, comment counts, coverage percentages, "3 layers", "the last two files". Writing one into
`title`, `body`, a `summary`, or a `description` does not add information; it adds a second number
that disagrees with the app's the moment a comment is added, a range moves, or the branch advances.
Say _what_ and _why_ ("the callers, then the tests"), never _how many_. The same goes for anything
else the app derives: which files a layer touches, whether a range is outdated, what percentage is
covered.

## Nesting layers

`parent` makes `layers` a tree, and the array **is** that tree in document order: a layer's
descendants follow it, together, before the next layer at its level. Read the array top to bottom
and you have read the review.

A layer's **extent** is its own ranges plus every range under it — one rule at every level. So:

- a layer with children is a normal layer that happens to contain others (like a directory),
- selecting it in the app shows the whole group; selecting a child narrows to that section,
- its file, line and comment counts are the group's totals, computed, never authored.

Because a parent's extent already includes its children's, you usually leave `"ranges": []` on it
and let the sections carry the code — but ranges on a parent are allowed, and simply add to its
extent. A parent is numbered `4` to its children's `4.1`, `4.2`, and a grandchild's `4.2.1`.

Nest when a theme genuinely has parts worth reading separately; a flat list is the right shape for
most reviews. The gate enforces:

- `parent` names a layer that exists (and not itself),
- the chain terminates — no cycles,
- nesting is at most **five levels** deep,
- every layer reaches some code: its own ranges, or a descendant's, and
- the array is in document order — a subtree is contiguous and follows its parent.

## Writing a layer `description`

`summary` is the one-line label in the layer list. `description` is the long-form prose the app
renders **twice**: as that layer's section of the overview doc, and above the diff when the layer is
active — the "why this slice" a good reviewer says out loud. Make it reading context: what this
slice does, why it is grouped, what to notice.

Because it is read in the doc as well as over the code, write it to stand on its own: a reader who
never opens the diff should still learn what this slice does. Do not open with "here you can see" or
otherwise assume the code is on screen, and do not restate the `summary`.

The grammar below is the artifact's one prose tier: it governs a layer `description` and the
overview `body` alike. It is a deliberately small markdown set — **only** these, nothing else:

- **Paragraphs** separated by a blank line. A single newline inside a paragraph is a soft wrap.
- **Inline `` `code` ``** for a symbol or a filename (mono; if the text names a file in the diff
  it becomes a clickable chip).
- **`[label](path)` links** whose `path` is a file **present in this diff** — it renders as a
  clickable chip that navigates the diff to that file.
- **`**strong**`** and **`*emphasis*`** for a phrase that must carry weight in the sentence; a
  bolded phrase keeps its code spans and links live. Use sparingly — prose that is all bold says
  nothing loudly.
- **`-` bullet and `1.` numbered lists**, one item per line; an indented follow-on line
  soft-wraps into its item.
- **`#`–`######` headings** to break a long description into parts. They render *below* the
  section headings the app already draws, so use them for structure inside your prose, not to
  restate the layer's own title.
- **`>` block quotes** for an aside, and **` ``` ` code fences** for quoting a few verbatim
  lines. Prefer anchored comments for anything about specific changed lines — quoted code in
  prose does not navigate.
- **`---`** for a thematic break.

Not in the grammar (do not use): tables, images, HTML, and external URLs. A `[label](path)` to a
path **not** in the diff renders dead and **fails the gate** — link only to files the range
actually touches.

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
- Every `description` link path — and every link in the overview `body` — must be a file in the
  diff.
- A layer with no ranges of its own is fine when something under it has some; a layer whose whole
  extent is empty is refused.

If the gate reports a problem, it names the exact locator. Fix `draft.json` and re-run until it
exits 0; only a passed artifact is handed over.
