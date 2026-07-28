# Reviewer

A macOS app for reading code reviews written by your coding agent.

Agents write good reviews and then dump them into a terminal, where you scroll past a wall of text
with no diff next to it. Reviewer takes that same review and shows it the way GitHub would: a
summary up front, comments pinned to the exact lines they talk about, and an optional order to read
the change in.

> **Note:** fully vibecoded. Every line was written by Claude and no human has read the code.

![Reviewer showing a diff grouped into ordered layers with anchored review comments](assets/screenshot.png)

## Why

- **Works with any agent.** `rvw` is a small CLI that takes a review as JSON. It never tells your
  agent what to look for — your rules stay yours. You can write the JSON by hand too.
- **No made-up line numbers.** Every comment is checked against the real diff before anything is
  saved. If a line doesn't exist, `rvw` rejects the review instead of showing you a comment on the
  wrong code.
- **Opens with a summary, not a file tree.** You start by reading what the change does, then click
  into the parts you care about.
- **Reads in order.** The agent can group the diff into steps, so you read the new data structure
  before the code that uses it.
- **Local-first.** No account, no server. Reviews are files on your disk.

## Use it

From inside the repo, your agent pipes the review in:

```bash
rvw emit <<'JSON'
{ "overview": { ... }, "comments": [ ... ], "layers": [ ... ] }
JSON
```

That validates the review, saves it, and opens the app. The commit range is detected automatically
(current branch against its fork point); override it with `--repo` / `--base` / `--head`, or skip
opening with `--no-open`.

In practice you never write that by hand. Ask your agent for a review and say where to send it:

```
/code-review — then present the findings in Reviewer using the rvw CLI.
```

Running `rvw` opens with a line telling the agent to read the bundled `present-review` skill
(`rvw skills present-review` prints its path), which carries the draft format and the handoff — so
the instructions live with the tool instead of in the prompt. Two other commands are useful while
authoring: `rvw schema --json` prints the exact JSON shape, and `rvw diff` prints the diff that
comments are checked against.

Reviews store only refs, so the app rebuilds the diff from your branch each time you open it —
which also means a review is only readable where the repo is. To send one somewhere else, add
`--embed-patch` and the diff travels inside the artifact:

```bash
rvw emit --base main --embed-patch --no-open --out review.reviewer.json
```

That opens on any machine, with no repo and no refs — the CI case. The cost is that its diff is
frozen: the app cannot expand context around a hunk or narrow to a subrange of commits, since both
read git. Prefer refs whenever the reader has the repo.

Emitted reviews land in `~/.rvw/reviews/` (override with `RVW_HOME`) unless `--out` says otherwise.
The app lists them newest-first under **File ▸ Recent Reviews** (⇧⌘R), so a review you closed, or
one your agent wrote while you were elsewhere, is always a keystroke away.

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

`bun run reset` does the reset on its own: it clears the first-run guide's flag, empties the
tab strip (keeping a copy at `sessions.json.bak`), and removes the installed `rvw` launcher —
the three things that decide what a new user's first screen looks like. Your theme is left
alone. `--keep-tabs` / `--keep-cli` skip a part; quit the app first, or pass `--force`.

**Stack:** Electron, React 19, TypeScript, Tailwind v4, Base UI, zustand, zod, Pierre
`@pierre/diffs` / `@pierre/trees`, system `git`; [bun](https://bun.sh).

## License

MIT — see [LICENSE](./LICENSE).
