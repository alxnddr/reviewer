# Reviewer

Local-first macOS app for reading agent-authored code reviews.

Your agent reviews with its own rules; the `rvw` CLI presents the result — an **overview**,
line-anchored comments, and an optional walkthrough in ordered **layers** — validating every anchor
against the real diff first, so a hallucinated line can't reach you.

> **Note:** this project was developed entirely by Claude, no one has ever looked at its code.

![Reviewer showing a diff grouped into ordered layers with anchored review comments](assets/screenshot.png)

## Features

- **Any agent, your rules.** `rvw` is a small, provider-agnostic CLI that never tells your agent how
  to review. It hands over the artifact shape (`rvw schema`) and the exact diff anchors are checked
  against (`rvw diff`). A human can drive it too.
- **Validated, not trusted.** `rvw emit` writes nothing unless every comment and layer range places
  against the diff.
- **Starts with a tour, not a file list.** A review opens on its **overview**: what the change does,
  then one section per layer — its files, line counts and comments derived from the artifact, so
  they can't go stale. Click a chapter to read its diff; come back any time.
- **A reading path.** Layers are optional and nestable, and the order you emit is the order they are
  read. Follow them in sequence or solo one.
- **Survives drift.** A comment whose code moved is flagged **Outdated**, never shown on the wrong
  line.
- **High-fidelity diffs** via Pierre's `@pierre/diffs` / `@pierre/trees`. Local-first — no account,
  no server.

## Usage

One call, from inside the repo: the agent pipes its draft in, `rvw` validates every anchor against
the real diff, writes the artifact, and opens it.

```bash
rvw emit <<'JSON'
{ "overview": { ... }, "comments": [ ... ], "layers": [ ... ] }
JSON
```

The range is auto-detected (current branch against its fork point) — pass `--repo`/`--base`/`--head`
to override, `--no-open` to skip opening. See `rvw schema --json` for the draft shape and `rvw diff`
for the diff anchors are checked against.

Point your agent at the bundled `present-review` skill (`rvw skills`) after it has reviewed the
change. The artifact is refs-only — the app re-derives the diff from your branch on open, so it
stays small and current.

## Install

macOS. Grab the `.dmg` from the [latest release](../../releases/latest), or build from source:

```bash
bun install
bun run build:mac    # → Reviewer.app + .dmg in dist/
bun run build:cli    # → rvw CLI at dist/rvw.js
```

Release builds are unsigned — on first launch, right-click → **Open**, or:
`xattr -dr com.apple.quarantine /Applications/Reviewer.app`

## Develop

```bash
bun run dev     # electron-vite dev (HMR)
bun run check   # typecheck + lint + format
bun run test    # vitest
```

**Stack:** Electron, React 19, TypeScript, Tailwind v4, Base UI, zustand, zod, Pierre
`@pierre/diffs` / `@pierre/trees`, system `git`; [bun](https://bun.sh).

## License

MIT — see [LICENSE](./LICENSE).
