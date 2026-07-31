# `design/`

Five files besides this note, only one of which the app reads. This note says which is which,
because "unreferenced" and "safe to delete" are not the same thing here.

## Consumed by the build

- **`globals.css`** — the colour source of truth. Imported last by `src/renderer/src/index.css`
  (so its `:root` / `.dark` / `@theme` win the cascade) and parsed by `src/shared/themes.test.ts`,
  which pins it against `src/shared/themes.ts`. It began as a generator output and is **no longer
  one**: the generator emitted one light/dark pair on `:root` / `.dark`, and the six curated
  `html[data-theme]` themes were adopted into it by hand. It is edited by hand now. Nothing
  regenerates it, and regenerating it would replace all six with that original pair.

## Not consumed by anything — kept as the record of where the palette came from

The remaining four are one snapshot from a design-system generator that does not live in this
repository, run once at project start. Nothing in the build, the tests, or `src/` reads them, and
no script here produces them; they cannot be refreshed from inside this repo. They describe the
*original* generated light/dark pair only — what is now `pierre-light` / `pierre-dark` — not the
four themes adopted after it.

- **`design-manifest.json`** — the generator's input: brand seed (`#009fff`), tone, fonts, contrast
  target, and the hue/chroma it resolved them to. The record of what was asked for.
- **`tokens.json`** — the generated ramp in machine-readable form, each stop as oklch + hex.
- **`contrast-report.json`** — every foreground/background pair in that ramp graded against WCAG and
  APCA. This one is **load-bearing prose evidence**: the per-theme ink lift in `index.css`
  ("the report grades faint as `faint/large text`") argues directly from it, and against the numbers
  in it. Deleting it strands that reasoning.
- **`preview.html`** — a standalone swatch/specimen page for the same ramp. Open it in a browser;
  it needs nothing.

They are kept rather than deleted because the ink lift cites the report, and because the four only
make sense as a set: the manifest is the question, the other three are the answer. They are not a
description of the app's current theme set — `globals.css` is the only file that is.
