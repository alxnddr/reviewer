# Reviewer

A macOS app for reading code reviews written by your coding agent.

By now you have probably put real work into how your agent reviews — a review skill, house rules in
`CLAUDE.md` or `AGENTS.md`, conventions written down somewhere it can read. What comes out of all
that still lands as a wall of text in a terminal, where you scroll and rebuild the diff in your head.

![Reviewer showing a diff grouped into ordered layers with anchored review comments](assets/screenshot.png)

## Two things

**Bring your own agent.** `rvw` is a small CLI that takes a finished review as JSON. It has no
opinion about what a bug is and never tells your agent what to look for. Ask for the review the way
you already do — your `/code-review`, your skills, your `CLAUDE.md` — and the findings stay yours.
Any agent that can run a shell command can hand them over.

**The CLI turns findings into a tour.** A bundled skill walks the agent through building one: a
summary of what the change does and why, the diff cut into chapters you read in order — the schema
before the code that consumes it, the fix before the tests that pin it — and each finding anchored
to the lines it's about. You read it top to bottom instead of piecing it back together.

Anchors are checked against the real diff before a review is saved, so a comment can't land on the
wrong code. Reviews are files on your disk — no account, no server.

## Use it

Prompt for the review the way you already prompt for it — your skill, your rules, your wording — and
add one clause saying where the findings go: *…then present the findings using the rvw CLI.*

Below, `/code-review` is Claude Code's built-in review skill — it stands in for whatever you already
use, and only that first half changes from setup to setup:

```
/code-review — then present the findings using the rvw CLI.
```

`rvw` tells your agent the rest — the draft format and the guidance for building the tour ship with
the CLI as a skill, so none of it has to live in your prompt. The commit range is worked out for
you, and the app opens as soon as the review is written.

Reviews land in `~/.rvw/reviews/`; the app lists them newest-first under **File ▸ Recent Reviews**
(⇧⌘R). They keep git refs rather than a copy of the diff, so the app rebuilds the change from your
branch every time you open it — which also means a review opens only where the repo is. To send one
to a machine without the checkout, `rvw emit --embed-patch` packs the diff into the file itself.
`rvw --help` has the rest.

## Install

macOS. Download the `.dmg` from the [latest release](../../releases/latest), or build it:

```bash
bun install
bun run build:mac    # → Reviewer.app + .dmg in dist/
bun run build:cli    # → rvw CLI at dist/rvw.js
```

Builds are unsigned, so on first launch right-click → **Open**, or run:
`xattr -dr com.apple.quarantine /Applications/Reviewer.app`

## Develop

```bash
bun run dev        # build the CLI bundle, then electron-vite dev (HMR)
bun run dev:fresh  # reset to a first launch, then dev
bun run check      # typecheck + lint + format
bun run test       # vitest
```

The installed `rvw` is a two-line shim that execs the app's bundle, so it follows the app — an
update to Reviewer updates the command with no reinstall. In development that bundle is
`dist/rvw.js`, which is why `bun run dev` rebuilds it first; edit anything under `cli/` mid-session
and re-run `bun run build:cli` to catch the shim up.

`bun run reset` does that reset on its own: it clears the first-run guide's flag, empties the tab
strip (backup at `sessions.json.bak`), and removes the installed `rvw` launcher. Your theme is left
alone. `--keep-tabs` / `--keep-cli` skip a part; quit the app first, or pass `--force`.

## License

MIT — see [LICENSE](./LICENSE).

> **Note:** fully vibecoded. Every line was written by Claude and no human has read the code.
