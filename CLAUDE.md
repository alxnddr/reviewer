# CLAUDE.md

Reviewer is a macOS Electron app for reading code reviews an agent wrote. `rvw` — a Stricli CLI
bundled beside the app — takes a finished review as JSON, proves every anchor places against the
real diff, and writes a `.reviewer.json` artifact the app renders as an ordered tour. `README.md`
is the user's view of that. This file is for whoever edits the code.

Every line in this repository was written by an agent and no human has read it. That is the
operating constraint, not a disclaimer: there is no reviewer downstream to catch a convention you
dropped, so a convention only counts if the compiler, a test, or a comment explaining *why*
enforces it — in that order of preference. Prefer making a mistake impossible over writing down
that it is a mistake.

## The comments are the design record

Module headers here say why the code is shaped the way it is, what was tried instead, and which
failure the shape prevents. They are the only record of that reasoning — there are no design docs,
no PR threads, no commit-message essays. Concretely load-bearing examples:

- `tsconfig.shared.json`'s header is the whole argument for the node-free boundary; delete it and
  the next agent "simplifies" the project away.
- `src/renderer/src/index.css`'s glass block documents two Chromium/Electron traps in
  `backdrop-filter`. One of them fires *only* in a packaged build — Lightning CSS runs on build,
  not under `bun dev` — where nobody is iterating.
- `src/shared/diff/walk.ts` explains why two hunk-geometry models deliberately coexist and where
  they are allowed to disagree.
- `.oxlintrc.json` turns off `eslint/max-lines`, `max-lines-per-function` and `no-inline-comments`
  precisely so this style is legal, and every other rule it disables carries the reason it is off.

So: a refactor moves prose with the code it describes. Delete a comment only when the thing it
describes is gone. New non-obvious code gets the same treatment — the reason, the rejected
alternative, the failure prevented. Markdown is excluded from `oxfmt` (`.prettierignore`, which
oxfmt reads by default along with `.gitignore`) because the formatter is non-idempotent on it.

## Layout, and who may import what

| Path | What it is |
|---|---|
| `src/shared/` | The domain: zod contracts and pure functions. Renderer-safe, **node-free**. |
| `src/shared/node/` | The node half of shared — spawn argv, env hardening, `~/.rvw` paths. Main + CLI only. |
| `src/main/` | The Electron main process: window, menu, IPC handlers, git, the session/settings/progress stores. |
| `src/preload/` | The sandboxed bridge. Bundles `shared/ipc.ts` and nothing heavier. |
| `src/renderer/src/` | The React app: `components/`, `lib/` (pure helpers + hooks), `stores/` (zustand), `dev/` (the preview harness). |
| `src/tools/` | Review tooling that is pure and I/O-free: schema emission, validation, artifact assembly, coverage. Shared by the CLI *and* the renderer. |
| `cli/` | `rvw`: the Stricli app, its six verbs, and the effectful shell around them. |
| `design/` | The palette. `globals.css` is consumed; the rest is provenance — see `design/README.md`. |
| `skills/` | The agent-facing review skill `rvw skills` points at. Shipped as `extraResources`. |
| `scripts/` | `reset-state.mjs` (back to a first launch), `gen-icon.mjs`, `check-package.mjs` (asserts on the packaged artifact). |

The edges that actually exist, and are the ones to keep:

- **renderer → `src/shared/` (never `src/shared/node/`) and `src/tools/`.** `lib/coverage.ts` and
  `lib/overview.ts` import `tools/review-coverage`, which is why `src/tools/**` is in the web
  project too. Nothing in the renderer imports main, preload internals, or `cli/`.
- **main → `src/shared/` including `src/shared/node/`.**
- **preload → `src/shared/ipc.ts` only,** and that module takes `IpcContract` from
  `ipc-schemas.ts` with `import type` so it erases. The sandboxed preload must not pull zod in.
- **cli → `src/shared/`, `src/shared/node/`, `src/tools/`,** plus exactly one main file:
  `src/main/review/guard.ts`, imported only by `cli/exit-gate.test.ts`, whose claim is that the
  *app's* importer accepts what the CLI emits.
- **Nothing imports the renderer.**

### What enforces it

Four tsconfig projects, all with the same strictness flags. They are the enforcement, not
documentation of it — the first three below are `composite`, so an import across a boundary is
`TS6307` ("not listed within the file list of project") at typecheck time rather than a Vite build
error or a runtime crash in the window.

- `tsconfig.node.json` — main + preload + shared, plus the root `electron.vite.config.*` and
  `vitest.config.*`, which have to be typechecked somewhere.
- `tsconfig.web.json` — renderer + shared + tools (and `src/preload/*.d.ts`, which is the `Window`
  augmentation, not preload code), with everything under `src/shared/node/` **excluded**. That
  exclusion is one direction of the boundary.
- `tsconfig.shared.json` — everything under `src/shared/` except `node/` and the tests, with
  `"types": []`. Deliberately *not* composite — it needs no project graph, because its check is
  the empty `types`: dropping `@types/node` is the other direction of the boundary, so a stray
  `import { join } from "node:path"` in renderer-bound shared code becomes `TS2591` instead of
  prose nobody runs.
- `tsconfig.tools.json` — `cli/` + `src/tools/` + shared + that one guard file.

`tsconfig.json` is the editor's solution file and references the first three (not `shared`, which
is a boundary check, not a program to get IntelliSense from). `bun run typecheck` runs `tsgo`
(`@typescript/native-preview`) over all four; `typecheck:slow` is the same under real `tsc`.

If you add a directory, decide which project owns it before writing code in it.

## Conventions

**zod at every boundary, in both directions.** Disk, IPC, the CLI's stdin, `argv` — everything
untrusted is parsed, never trusted. `src/shared/ipc-schemas.ts` is one row per channel and the only
place a payload shape is written down: main validates with those schemas and the renderer's types
are `z.infer` of the same objects, so the checks performed and the types compiled against are one
declaration. Responses are validated too, which is the half most typed-IPC libraries skip. Import
style is zod v4's `import * as z from "zod"` everywhere; `rvw schema` derives its JSON Schema from
the same `ReviewArtifact` via `z.toJSONSchema`, so the published shape cannot drift from the
enforced one.

**Discriminated unions, closed so a new variant breaks the build.** Two forms, both compile-time,
and which one a site uses is not arbitrary:

- `return assertNever(x)` (`src/shared/assert.ts`) as the last arm — `DiffScreen.tsx`,
  `lib/git-failure-message.ts`, `lib/selection.ts`, `main/git/ops.ts`, `shared/diff/patch.ts`,
  `cli/coverage-report.ts`. The same trick closes an `if`/`else if` chain (`shared/diff/walk.ts`).
- A value-returning `switch` with *no* `default:` at all, where `noImplicitReturns` (on in every
  project via `@electron-toolkit/tsconfig`) makes an unhandled variant a compile error on its own:
  `tools/review-validator.ts`'s `describeProblem`, `lib/selection.ts`'s brush reducer.

Either way, don't replace such a switch with a lookup object, and don't add a `default:` that
returns a fallback — the build-breakage is exactly the property being bought. The one deliberate
exception is `shared/markdown.ts`, which walks mdast's open node union and must have a default.
(`switch (event.key)` in the keyboard handlers is not one of these: that is an open string set.)

**Typed failure objects, not thrown errors, at boundaries.** A boundary answers
`{ ok: true; … } | { ok: false; … }` rather than throwing: `GitRunResult`, `GitResult`,
`ReviewOpenResponse`, `RangeResult`, `CoverageResult`, `EmitResult`, `SkillsResult`. The failure
payload is *not* uniform, so read the type before assuming — the git and IPC ones carry a `code`
the caller switches on (`GitRunFailure`, `GitFailure`, `ReviewOpenFailure`), `RangeResult` carries
a `CliError`, `CoverageResult` a bare string tag, `EmitResult` a list of `ValidationProblem`s,
`SkillsResult` a message. A caught `unknown` is normalized once, by `errorMessage` / `errnoCode`
in `src/shared/errors.ts` — don't grow a sixth private errno sniff. Failure *codes* cross the wire;
the sentence a human reads is composed at the edge that shows it (`lib/git-failure-message.ts`,
`lib/review-open-failure-message.ts`, `cli/errors.ts`).

**Pure core, effectful shell.** Stated in the headers of `src/tools/*`, `cli/app.ts`, `cli/index.ts`
and most of `renderer/lib/`. The pure half takes its inputs as arguments — including `now`
(`relative-time.ts`) and the process surface (`cli/context.ts`'s `LocalContext`) — so it is testable
without mutating a global, spawning git, or building a temp repo. The shell owns spawning, reading,
writing and the exit code. When something is hard to test, the answer here has always been to move
the decision into the pure half rather than to add a mocking layer.

**Persist inputs, re-derive everything else.** A session stores refs and a commit selection anchored
to SHAs; the log, the branch list and the patch are re-derived from git on load, so the diff
reflects the repo now. A comment's authored anchor is persisted; its placed line is recomputed.
`src/shared/session.ts` states it on the `Session` schema, and `src/shared/review.ts` cites it
back by name as "the session.ts inputs-not-derived precedent".

## The renderer

The review store is nine zustand slices under `stores/review/`, composed by `stores/review.ts`,
whose header is the map. The rules that keep it a tree rather than a mesh:

- No slice imports another slice or reads another's state directly. Cross-slice work goes through
  `get()` — `get().syncSessions()`, `get().scheduleSessionWriteBack()`.
- Every arrow points *down* at the shared shape: `slice.ts` (`SessionSlice`, `setSlice`,
  `withSlice`), `slice-factory.ts` (the one slice literal there is), `state.ts` (`ReviewState`),
  `tab-strip.ts`, `effects.ts` (the three git errands).
- `createReviewStore()` is a factory, not a bare `create()`, because an instance owns mutable
  things that are not state — two write-back debouncers, the in-flight hydration promise, three
  counters. Tests build their own instance; `useReviewStore` is the app's one.
- The referential-equality no-op guards in the setters exist to prevent renders. Don't introduce
  immer, which would break them.

Other renderer-wide rules:

- `@/` resolves to `src/renderer/src` and nothing else (identically in `electron.vite.config.ts`,
  `vite.preview.config.mts`, `vitest.config.ts` and `tsconfig.web.json`). `src/shared/` is therefore
  always a relative path — which is how you can tell at a glance that an import crosses the
  renderer boundary. Components use `@/`; `lib/` and `stores/` mostly use relative paths.
- **Rail sections read the store; rows take props.** A section is a region mounted once and can name
  its own state (`LayerList` → layers, `CommentsPanel` → comments); anything drawn once per item
  takes what it needs. `components/ReviewRail.tsx` states the rule, `components/rail.tsx` owns the
  shared row/section vocabulary so four widgets in one column cannot drift apart again.
- **Keyboard.** `lib/shortcuts.ts` is the vocabulary — the sheet, the tooltips and the recents
  footer all derive from it, and advertising an unregistered key is a type error. It is deliberately
  *not* a dispatch table: handlers stay in the short switch beside the state they act on, guarded by
  `lib/shortcut-guard.ts` (`shortcutBlocked`, `isEditable`, `modalOpen`). Chords that must fire
  from anywhere — ⌘T, ⌘W, ⇧⌘O, ⌘1…⌘9, ⌃⇥ — are menu accelerators in `main/menu.ts` instead,
  precisely because those window handlers stand down inside a text field and under a modal.
- **DOM lookups use `getElementById`, never `querySelector("#" + id)`.** The ids are data — a layer
  id like `reviewer:uncovered`, a session uuid — and `:` in a selector throws `SyntaxError` inside a
  mount effect, which blanks the app. `dom-ids.test.ts` asserts this against the source;
  `unicorn/prefer-query-selector` is off for the same reason.
- **Styling.** Tailwind v4, tokens from `design/globals.css` (hand-maintained — read
  `design/README.md` before touching it), classes merged through `cn()` in `lib/utils.ts`. Reach for
  the existing recipe before writing a fourth: `ui/surface.ts`'s `POPOVER_SURFACE` for opaque
  floating surfaces, `Glass.tsx` + `ui/dialog.tsx`'s glass variants for the ones the reader's work
  shows through, `cva` variants on `ui/button.tsx` for chrome.
- **The diff surface is `@pierre/diffs`.** The app owns the parse (`shared/diff/patch.ts`), the one
  line walk (`shared/diff/walk.ts`), anchoring (`shared/diff/anchor.ts`) and the slots
  (`components/diff/*`); rendering, highlighting and the worker pool are the library's. Render props
  handed to `CodeView` must be passed by name — an inline arrow rebuilds every portal on every
  render, which `DiffView.test.ts` asserts against the source.

## Main

- One `electron-store` for everything main persists *at app level* (`main/store.ts`): settings, the
  onboarding flag, window geometry. One atomic write path (temp file + rename), one file to reason
  about, one place a test can redirect. Each owner validates its own keys on read and carries the
  other owners' keys through a whole-file write untouched. Two things are deliberately outside it:
  sessions are their own `electron-store` (`sessions.ts` → `sessions.json`, with a version envelope
  and per-session salvage), and read progress is one small JSON per review under `~/.rvw`
  (`review/progress.ts`). Don't fold either into `store.ts`.
- `main/ipc-registry.ts` is the only place an IPC payload is trusted: the sender frame is checked
  first, then the request is parsed, then the response is parsed. A registration site passes no
  schema — the pair is looked up by channel — so it cannot pass the wrong one.
- git is spawned directly: `git/runner.ts` is argv-only (never a shell), with an explicit output
  cap that fails as a typed `outputOverflow`, a timeout, and child tracking so quit can kill
  in-flight processes. It is Electron-free so the whole git layer tests under plain node.
  `git/ops.ts` is the domain layer above it, `git/parse.ts` the NUL-record parsing.
- `shared/node/git-diff.ts` holds `DIFF_CONFIG`/`DIFF_ARGS`/`hardenedGitEnv` so the app and the CLI
  produce byte-identical patches. Drift there breaks anchor placement against an embedded patch.

## The CLI

`cli/app.ts` is pure data — one route map over six verbs (`emit`, `check`, `diff`, `open`, `schema`,
`skills`), no process, no I/O — so tests bind it to capturing streams and `cli/index.ts` binds it to
the real process. The exit-code contract is closed: 0 ready, 1 review problems, 2 cannot-run, and
nothing else leaves the process. Use `process.exitCode`, never `process.exit()` — on macOS stdout to
a pipe is async and `exit()` discards what is still buffered, which is how `rvw diff` once silently
truncated. `LocalContext` carries the whole process surface a verb reads (cwd, env, platform, home,
stdin) so no test has to `chdir` or redefine `process.platform`.

The shebang must stay `#!/usr/bin/env node`: `bun build` treats a `bun` shebang as a bun-only
artifact and emits a bundle that throws inside Stricli under the Node that Electron embeds.
`build:cli` writes `dist/rvw.js` *and* `dist/package.json` (`{"type":"module"}`); both ship, and the
installed `/usr/local/bin/rvw` is a shim that execs the app's copy, so editing `cli/` mid-session
means re-running `bun run build:cli`.

## Tests

`vitest run`, node environment, **no DOM**. Every test file is `.ts`; nothing renders React, and
there is no jsdom or testing-library. That is a deliberate constraint, and the answers to it are:

- Extract the decision into a pure function and test that (most of `lib/`, all of `tools/`).
- When the invariant is real but nothing in the toolchain can see it, assert it **against the
  source**: `dom-ids.test.ts`, `DiffView.test.ts`, `index.css.test.ts`, `themes.test.ts`. Each of
  those files opens with why it exists in that form.
- Genuinely DOM-only code (`shortcut-guard.ts`, `focus-regions.ts`'s `visibleRegions`) is left
  untested rather than tested against a stub, and says so.

Fixtures are shared, never re-hand-rolled: `src/shared/diff/fixtures.ts` (patches),
`cli/fixtures.ts` (real temp git repos via `mkdtempSync`, plus the `rvw` spawn helpers),
`src/renderer/src/stores/__fixtures__/bridge.ts` (a fake `window.reviewer`), and
`createSessionSlice` for store state. `cli/bundle.setup.ts` is a `globalSetup` that builds
`dist/rvw.js` once so parallel CLI suites don't race on it. `src/renderer/src/dev/preview.ts` is the
hand-driven preview harness that seeds the stores for eyeballing screens.

## Gates

```bash
bun run check   # tsgo × 4 projects, then oxlint, then oxfmt --check
bun run test    # vitest
```

Both must be clean before you are done; CI runs them plus `bun run build`, and a macOS job that
packages the app and runs `bun run check:package` against the real `.app`. That last one exists
because two shipped defects were invisible to every other check: `files:` in `electron-builder.yml`
is an **allowlist** (electron-builder does not read `.gitignore`, so scratch directories and agent
worktrees would otherwise ship), and `extraResources` must carry the CLI's module manifest beside
its bundle. Widening either is a deliberate edit.

Formatting is `oxfmt`, linting is `oxlint`; there is no prettier or eslint despite the
`.prettierignore` filename, which oxfmt reads by convention.

To see it run: `bun run dev` (builds the CLI bundle, then `electron-vite dev`), or `bun run
dev:fresh` to reset this machine to a first launch first. There is no npm script for
`vite.preview.config.mts` — the browser-only preview is run ad hoc.

## Decisions already made — don't re-litigate these

Each of these was examined and kept deliberately. Reversing one needs a new reason, not a fresh
first impression.

- **Direct `git` invocation, not `simple-git` / `isomorphic-git`.** The runner already gives
  argv-only spawning, a byte cap with a typed failure, a timeout, `GIT_*` env scrubbing and
  kill-on-quit. `simple-git` provides none of them and you would rebuild all of it around the
  library; `isomorphic-git` has no working-tree diff porcelain and no equivalent of the byte-stable
  `DIFF_CONFIG`/`DIFF_ARGS` contract the app and CLI depend on agreeing about.
- **The hand-rolled IPC registry.** It validates request *and* response against the one schema
  table. `electron-trpc` would add a router, superjson and observables to buy nothing that isn't
  already there.
- **`shared/assert.ts`, `lib/fuzzy.ts`, `lib/relative-time.ts`.** A handful of lines each, and
  each an exact fit for its one caller-set. A ranked fuzzy matcher would require a sortable tree,
  which `@pierre/trees` is not; and `date-fns`/`dayjs` to replace the `Intl` call producing
  `"7h"`/`"3d"`/`"2mo"` is strictly worse.
- **Delegating the diff render to `@pierre/diffs`.** The app's job stops at the parse, the walk and
  the anchors. Do not reimplement highlighting or the worker pool — `DiffWorkerPool.tsx` is
  configuration, not a pool.
- **`main/review/open-queue.ts`, not `p-queue`.** The queue is incidental; the point is the
  window-ready gate.
- **The substring diff search.** Find-in-diff wants substring, not tokens; a full-text index would
  be slower to build and semantically wrong.
- **The hand-rolled tab drag in `TabBar.tsx`.** One drag surface in the whole app.
- **No `immer`** (breaks the no-op guards), **no `tinykeys`/`react-hotkeys-hook`** (the guard is
  already centralized and the handlers are five-line switches), **no `dnd-kit`**, **no fuzzy-search
  library**, **no `electron-window-state`** (last published 2022, unmaintained; and the clamp
  against `screen.getAllDisplays()` that `main/window-state.ts` performs is the part naive
  implementations get wrong, which is why this was rolled rather than installed).
