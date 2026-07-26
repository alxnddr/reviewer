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
- **Local-first.** No account, no server. Reviews live in your repo.

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

To set your agent up, run `rvw skills` to install the bundled `present-review` skill, then invoke it
after the agent has finished reviewing. Two other commands are useful: `rvw schema --json` prints
the exact JSON shape, and `rvw diff` prints the diff that comments are checked against.

Reviews store only refs, so the app rebuilds the diff from your branch each time you open it.

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
bun run dev     # electron-vite dev (HMR)
bun run check   # typecheck + lint + format
bun run test    # vitest
```

**Stack:** Electron, React 19, TypeScript, Tailwind v4, Base UI, zustand, zod, Pierre
`@pierre/diffs` / `@pierre/trees`, system `git`; [bun](https://bun.sh).

## License

MIT — see [LICENSE](./LICENSE).
