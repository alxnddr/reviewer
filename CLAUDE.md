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
| `src/main/pull-request/` | Review Pull Request…: find a checkout, fetch the PR into it with the reader's own git credentials, give it a worktree. Only `handlers.ts` imports Electron. |
| `src/main/github/` | The one HTTP boundary to GitHub: the inbox and PR reads, the diff check, the in-memory token vault, posting pending comments. Only `handlers.ts` imports Electron at runtime; `net.request` is handed in. |
| `src/preload/` | The sandboxed bridge. Bundles `shared/ipc.ts` and nothing heavier. |
| `src/renderer/src/` | The React app: `components/`, `lib/` (pure helpers + hooks), `stores/` (zustand), `dev/` (the preview harness). |
| `src/tools/` | Review tooling that is pure and I/O-free: schema emission, validation, artifact assembly, coverage. Shared by the CLI *and* the renderer. |
| `cli/` | `rvw`: the Stricli app, its six verbs, and the effectful shell around them. |
| `design/` | The palette. `globals.css` is consumed; the rest is provenance — see `design/README.md`. |
| `skills/` | The agent-facing review skill `rvw skills` points at. Shipped as `extraResources`. |
| `scripts/` | `reset-state.mjs` (back to a first launch), `gen-icon.mjs`, `check-package.mjs` (asserts on the packaged artifact), `check-bundle.mjs` (asserts on the built renderer), `pack-cli.mjs` + `install-cli.sh` (`rvw` without the app, for Linux). |

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
place a channel is paired with its payload shapes, which are declared beside their domain
(`review-ipc.ts`, `pull-request-ipc.ts`, `github-ipc.ts`, `github-posting.ts`, …): main validates
with those schemas and the renderer's types are `z.infer` of the same objects, so the checks
performed and the types compiled against are one declaration. Responses are validated too, which is
the half most typed-IPC libraries skip. Import style is zod v4's `import * as z from "zod"`
everywhere; `rvw schema` derives its JSON Schema from the same `ReviewArtifact` via
`z.toJSONSchema`, so the published shape cannot drift from the enforced one.

**Discriminated unions, closed so a new variant breaks the build.** Two forms, both compile-time,
and which one a site uses is not arbitrary:

- `return assertNever(x)` (`src/shared/assert.ts`) as the last arm — `DiffScreen.tsx`,
  `lib/git-failure-message.ts`, `lib/github-failure-message.ts`, `lib/selection.ts`,
  `main/git/ops.ts`, `shared/diff/patch.ts`, `cli/coverage-report.ts`. The same trick closes an
  `if`/`else if` chain (`shared/diff/walk.ts`).
- A value-returning `switch` with *no* `default:` at all, where `noImplicitReturns` (on in every
  project via `@electron-toolkit/tsconfig`) makes an unhandled variant a compile error on its own:
  `tools/review-validator.ts`'s `describeProblem`, `lib/selection.ts`'s brush reducer.

Either way, don't replace such a switch with a lookup object, and don't add a `default:` that
returns a fallback — the build-breakage is exactly the property being bought. The one deliberate
exception is `shared/markdown.ts`, which walks mdast's open node union and must have a default.
(`switch (event.key)` in the keyboard handlers is not one of these: that is an open string set.)

**Typed failure objects, not thrown errors, at boundaries.** A boundary answers
`{ ok: true; … } | { ok: false; … }` rather than throwing: `GitRunResult`, `GitResult`,
`ReviewOpenResponse`, `PullRequestResult`, `GitHubResult`, `GitHubPostAnswer`,
`GitHubSetTokenResponse`, `RangeResult`, `CoverageResult`, `EmitResult`, `SkillsResult`. The
failure payload is *not* uniform, so read the type before assuming — the git, GitHub and IPC ones
carry a `code` the caller switches on (`GitRunFailure`, `GitFailure`, `ReviewOpenFailure`,
`PullRequestFailure` — which carries a whole `GitFailure` in its `git` arm — `GitHubFailure`,
`GitHubPostFailure`, `GitHubTokenRefusal`, the last two extending `GitHubFailure`'s arms),
`RangeResult` carries a `CliError`, `CoverageResult` a bare string tag, `EmitResult` a list of
`ValidationProblem`s, `SkillsResult` a message. A caught `unknown` is normalized once, by
`errorMessage` / `errnoCode` in `src/shared/errors.ts` — don't grow a sixth private errno sniff.
Failure *codes* cross the wire; the sentence a human reads is composed at the edge that shows it
(`lib/git-failure-message.ts`, `lib/review-open-failure-message.ts`,
`lib/pull-request-failure-message.ts`, `lib/github-failure-message.ts`, `cli/errors.ts`). No
GitHub `message` text ever reaches a failure; GraphQL errors are mapped by `type`. The one
deliberate exception to "codes, not text" is git's `remoteFailed`, which carries one line of the
remote's stderr: a local git failure is the app's business and a code says all a reader can act
on, but a remote's is open-ended — a proxy, TLS interception, an org enforcing SAML SSO — and its
own sentence is the only actionable thing there is. Main chooses and scrubs that line
(`remoteFailureDetail`: control and bidi characters stripped, URL credentials redacted, capped);
`shared/git.ts` states the exception on `GitFailure`. Don't add a second.

**Pure core, effectful shell.** Stated in the headers of `src/tools/*`, `cli/app.ts`, `cli/index.ts`
and most of `renderer/lib/`. The pure half takes its inputs as arguments — including `now`
(`relative-time.ts`) and the process surface (`cli/context.ts`'s `LocalContext`) — so it is testable
without mutating a global, spawning git, or building a temp repo. Where the core needs an effect,
the effect is injected: the GitHub client's `GitHubTransport`, `PullRequestDeps` for the PR flow, so each runs under plain node with no Electron. The shell owns
spawning, reading, writing and the exit code. When something is hard to test, the answer here has
always been to move the decision into the pure half rather than to add a mocking layer.

**Persist inputs, re-derive everything else.** A session stores refs and a commit selection anchored
to SHAs; the log, the branch list and the patch are re-derived from git on load, so the diff
reflects the repo now. A comment's authored anchor is persisted; its placed line is recomputed.
`src/shared/session.ts` states it on the `Session` schema, and `src/shared/review.ts` cites it
back by name as "the session.ts inputs-not-derived precedent".

**The app never submits a review, and the build holds it.** Posting puts comments on a PR as
*pending* review comments, which only the reader sees until they press Submit on GitHub. A token
with Pull requests: write can also submit, approve and request changes, and none can be narrowed
below that, so the guarantee is code. `main/github/client.ts` can POST exactly one thing: a
`GraphqlDocument` — a literal union of the constants in `graphql-documents.ts`, which no other
string satisfies — to a hard-coded `/graphql`. Those constants hold three mutations, none of which
publishes: start a pending review (no `event`), add a thread to it, delete a pending comment.
`main/github/never-submit.test.ts` holds this against the source, reading string literals off the
TypeScript AST: no submit mutation, `event` key or event value anywhere in non-test files under
`src/main/`, `src/preload/` or `src/shared/`; outside `client.ts` no request body and no other way
onto the network; outside `graphql-documents.ts` no string containing `mutation`; each mutation's
input keys whitelisted.
`cli/no-github-credentials.test.ts` holds the other side: nothing under `cli/`, nor anything in the
shipped `dist/rvw.js`, names `api.github.com` or reads `GITHUB_TOKEN` / `GH_TOKEN`, so nothing an
agent can make `rvw` do talks to GitHub. Never add a fourth mutation without reading that test's
header.

## The renderer

The review store is ten zustand slices under `stores/review/`, composed by `stores/review.ts`,
whose header is the map. The rules that keep it a tree rather than a mesh:

- No slice imports another slice or reads another's state directly. Cross-slice work goes through
  `get()` — `get().syncSessions()`, `get().scheduleSessionWriteBack()`.
- Every arrow points *down* at the shared shape: `slice.ts` (`SessionSlice`, `setSlice`,
  `withSlice`), `slice-factory.ts` (the one slice literal there is), `state.ts` (`ReviewState`),
  `tab-strip.ts`, `effects.ts` (the three git errands).
- What belongs to no session is not a slice. `stores/pull-request.ts` is Review Pull Request…'s
  dialog — the checkout found, the base, the worktree made, the inbox — which happens before the
  agent has written the review that will become a session; `stores/github.ts` is main's
  *description* of the tokens it holds (kind, login, owner, expiry), never a token. Neither reads
  another store: what the PR dialog needs from settings (the prompt template, the login) arrives as
  an argument.
- `createReviewStore()` is a factory, not a bare `create()`, because an instance owns mutable
  things that are not state — two write-back debouncers, the in-flight hydration promise, three
  counters. Tests build their own instance; `useReviewStore` is the app's one.
- The referential-equality no-op guards in the setters exist to prevent renders. Don't introduce
  immer, which would break them.

Other renderer-wide rules:

- **Settings are one contract, `src/shared/settings.ts`, and one store, `stores/settings.ts`.** The
  schema is what main persists, what the `settings:get`/`settings:set` rows validate, and what the
  renderer's store holds, so a new setting is one key there plus one row in
  `lib/settings-catalog.ts` (which `settings-catalog.test.ts` insists on). Stored values are only
  the reader's *choices* — `resolveSettings` fills the rest — so a reset is a key removed, not a
  default written down, and the dialog can tell which rows to offer a reset on. Every key salvages
  on its own (`.catch(undefined)`): a hand-edited font size costs that setting, never the file.
  The dialog (`components/SettingsDialog.tsx`) is tabs, one section at a time, with a search
  that cuts across them; the code-font row lists the monospace families installed on the
  machine (`lib/local-fonts.ts`: Chromium's `queryLocalFonts`, each family measured on a canvas
  because the API has no monospace flag) behind the bundled Geist Mono.
  `lib/apply-settings.ts` is the only module that turns the resolved record into DOM state (the
  theme on `<html>`, the `--diffs-*` typography variables, the `--code-font` hook that
  `design/globals.css` leaves in the `--font-mono` token); the store takes it as an injected
  function so its tests run without a document. The one app-wide preference *not* in there is the
  split ⇄ unified diff layout (`stores/ui-prefs.ts`, localStorage): it is a working mode flipped
  from the title bar, deliberately kept where it was. A catalog row is a closed union of kinds —
  `select`, `number`, `font`, `boolean`, a multi-line `text` (the PR prompt template, with its
  placeholders and the schema's own `maxLength`) and a one-line `line` held to a format by its
  `accept` (the GitHub username). The
  GitHub token block (`components/settings/GitHubTokens.tsx`) sits in the dialog but is **not a
  setting**: a token never enters `Settings`, the settings store or the disk.
- `@/` resolves to `src/renderer/src` and nothing else (identically in `electron.vite.config.ts`,
  `vite.preview.config.mts`, `vitest.config.ts` and `tsconfig.web.json`). `src/shared/` is therefore
  always a relative path — which is how you can tell at a glance that an import crosses the
  renderer boundary. Components use `@/`; `lib/` and `stores/` mostly use relative paths.
- **Rail sections read the store; rows take props.** A section is a region mounted once and can name
  its own state (`LayerList` → layers, `CommentsPanel` → comments); anything drawn once per item
  takes what it needs. `components/ReviewRail.tsx` states the rule, `components/rail.tsx` owns the
  shared row/section vocabulary so four widgets in one column cannot drift apart again.
- **The start screen's foot line is the only entry to a plain session drawn in the window.** `PlainDiffFoot` in `components/StartScreen.tsx` — "No review to read? Open a repository ⌘O…" — calls the same `openRepository` as File ▸ Open Repository… and the `?` sheet's row, and takes its key from `lib/shortcuts.ts`. It is one faint `text-xs` line pinned under the list, not a third heading, a button or a `+` menu: a plain diff is a different errand from reading a review, so it stays out of the sight path (heading, prompt, heading, list) while still being words on the one screen a person with no review is standing on. The screen names two things; keep it at two. `StartScreen.tsx`'s header holds the argument, including why the two doors that used to sit at that foot do not come back. Review Pull Request… — someone else's PR, and the inbox of PRs requesting the reader's review — is a third errand and is reached only from File (⇧⌘P) and the `?` sheet, never from this screen (`main/menu.ts` and `PullRequestDialog.tsx` both say so).
- **The overview reopens where the reader left it until they navigate by their own hand — a *trip*.** The act that closes the document starts one (`docTrip` on the slice) and the next navigation act ends it, as does the reader dismissing it (`dismissDocTrip`); while it is live a glass pill floats bottom-centre over the diff — "← Back to overview", a divider, a × — in the place and the glass of the overview's own "Start reviewing" island, and it, `o` and the rail's Overview row all return to the exact scroll position. Once the trip has ended the pill is gone and the document is a hub again, opening on the section of the chapter now soloed, else on the position (`planDocReturn` in `lib/scroll.ts` holds the ranking; `components/DocReturnPill.tsx` holds the argument for the pill, including why the `↩` that used to trail the rail's Overview row does not come back). `DiffView` owns the bottom-centre of the pane as one column, because the pill and the comment stepper can be up together. `leaveDoc(slice)` and `enterDoc(slice)` in `stores/review/slice.ts` are the only spellings of closing and opening the document — one expression that both starts and ends trips, with `endDocTrip()` beside them for the × — and `stores/review/doc-trip.test.ts` holds the literal `overviewOpen: false` out of every other file, so a new navigation action cannot forget to end one; the document's own doors that do two things (`openLayerFile`, `openLayerComment`) are single store actions because a second call would arrive with the document closed and end the trip the first began. Scrolling, folding, find, marks and writing a comment are never navigation, and there is no timer; a position in pixels is only exact because `MermaidDiagram` recalls a diagram it has already drawn in its first render (`createDrawnDiagrams`), so the page is its final height when the position is served.
- **A comment's `postable` is the agent's or nobody's.** `postable` is the comment as it would be
  posted to the PR's author, written by the agent during the review (`skills/present-review`
  teaches it). `components/CommentPostable.tsx` draws it beside `CommentBody`, never inside it, and
  the app never offers to write one — no "write postable" action, nothing seeded from `body` — only
  to refine an existing one, where saving it empty removes it. Every way it leaves the app (Copy,
  Copy & open on GitHub, main's poster) goes through the one function `shared/postable-comment.ts`,
  so what is copied and what is posted cannot differ.
- **Keyboard.** `lib/shortcuts.ts` is the vocabulary — the sheet, the tooltips and the recents
  footer all derive from it, and advertising an unregistered key is a type error. It is deliberately
  *not* a dispatch table: handlers stay in the short switch beside the state they act on, guarded by
  `lib/shortcut-guard.ts` (`shortcutBlocked`, `isEditable`, `modalOpen`). Chords that must fire
  from anywhere — ⌘T, ⌘W, ⇧⌘O, ⇧⌘P, ⌘1…⌘9, ⌃⇥ — are menu accelerators in `main/menu.ts` instead,
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
- **A ```` ```mermaid ```` fence is drawn on the artifact's prose and nowhere else.** `Markdown`'s `diagrams` prop is opt-in: the overview and the layer descriptions pass it, the comment surfaces do not, and there a fence stays its source. `lib/mermaid.ts` is the pure half (the fence read, `MERMAID_CONFIG`, the fallback decisions); `components/MermaidDiagram.tsx` is the effectful one, and its header is the argument for the renderer's one insertion of markup derived from artifact text — read it before touching the config or upgrading mermaid. A diagram is drawn in the app's palette, not one of mermaid's: `lib/apply-settings.ts` reads the theme's tokens back off the document as `#rrggbb` (`readPalette` — mermaid's colour maths throws on `oklch()`), `lib/mermaid.ts` maps them to `themeVariables` over the hardened `MERMAID_CONFIG`, and mermaid is re-`initialize`d once per theme, with every mounted diagram redrawing because the resolved theme is a dependency of its effect. A new palette token a diagram needs goes in `DIAGRAM_TOKENS`, which a test holds against every theme block in `design/globals.css`. Three rules are held against the source by `MermaidDiagram.test.ts`: mermaid's code is reached only through `import("mermaid")` (an `import type` erases; a static import moves the largest dependency in the app into the entry chunk), `dangerouslySetInnerHTML` appears in that one file, and the comment surfaces never pass `diagrams`. No `rehype-raw`, ever — the diagram must not become a general HTML escape hatch.
- **The diff surface is `@pierre/diffs`.** The app owns the parse (`shared/diff/patch.ts`), the one
  line walk (`shared/diff/walk.ts`), anchoring (`shared/diff/anchor.ts`) and the slots
  (`components/diff/*`); rendering, highlighting and the worker pool are the library's. Render props
  handed to `CodeView` must be passed by name — an inline arrow rebuilds every portal on every
  render, which `DiffView.test.ts` asserts against the source.

## Main

- One `electron-store` for everything main persists *at app level* (`main/store.ts`): the reader's
  settings (`shared/settings.ts`, through `main/settings.ts` and `main/user-settings.ts`), the
  onboarding flag, window geometry, the relocations a reader made (`review/relocations.ts`), and
  the checkout remembered per GitHub repository (`pull-request/checkouts.ts`'s
  `pullRequestCheckouts` — memory about the machine, not a preference, so not a `Settings` key).
  One atomic write path (temp file + rename), one file to reason about, one place a test can
  redirect. Each owner validates its own keys on read and carries the other owners' keys through a
  whole-file write untouched. Two things are deliberately outside it: sessions are their own
  `electron-store` (`sessions.ts` → `sessions.json`, with a version envelope and per-session
  salvage), and read progress is one small JSON per review under `app.getPath("userData")/progress`
  (`review/progress.ts`, wired in `main/index.ts`). That file also carries Layer C's posting record
  (its `github` key, `GitHubPostRecord`), because main is its only writer — after each comment
  GitHub accepts — and on the session the renderer's debounced write-back could put an older
  record over a newer one (`shared/review-progress.ts`); the two writers are queued per file and
  each carries the other's half through. Don't fold either into `store.ts`. Progress, and Review
  Pull Request…'s worktrees (`userData/worktrees`), are *not* in `~/.rvw` — that directory is the
  CLI's, and `rvw emit` owns every byte of `~/.rvw/reviews`. The GitHub token is in none of these:
  see `main/github/` below.
- `main/ipc-registry.ts` is the only place an IPC payload is trusted: the sender frame is checked
  first, then the request is parsed, then the response is parsed. A registration site passes no
  schema — the pair is looked up by channel — so it cannot pass the wrong one.
- git is spawned directly: `git/runner.ts` is argv-only (never a shell), with an explicit output
  cap that fails as a typed `outputOverflow`, a timeout, and child tracking so quit can kill
  in-flight processes. An operation that reaches a remote runs `detached`, so a timeout, a Cancel
  (its `AbortSignal`) or quit signals git's whole process group and the ssh or `git-remote-https`
  it started goes with it; a timeout or Cancel is SIGTERM, then SIGKILL after `KILL_GRACE_MS`,
  because git cleans up after itself on SIGTERM and not on SIGKILL. A checkout is never handed a
  signal: a worktree stopped halfway is a truncated tree an agent could be sent to review. It is
  Electron-free so the whole git layer tests under plain node. `git/ops.ts` is the domain layer
  above it, `git/parse.ts` the NUL-record parsing.
- `shared/node/git-diff.ts` holds `DIFF_CONFIG`/`DIFF_ARGS`/`hardenedGitEnv` so the app and the CLI
  produce byte-identical patches. Drift there breaks anchor placement against an embedded patch.
- `main/pull-request/` is Review Pull Request…, and **the reader's checkout is not touched**
  (`flow.ts`'s header says what each step writes; `flow.test.ts` proves it). One fetch, run with
  `--refmap=` (and `--no-tags`, `--no-write-fetch-head`) so it writes exactly its two refspecs: the
  PR's head to `refs/rvw/pr/<owner>/<repo>/<n>` — never a branch, in the common git dir so every
  worktree sees it, and namespaced by repository because a fork and its upstream both have a #12 —
  and the base to `refs/remotes/<remote>/<base>`. The review gets a detached worktree at
  `userData/worktrees/<owner>/<repo>-<n>`, lowercased (`worktrees.ts`: the flat
  `<owner>-<repo>-<n>` is ambiguous once names hold `-`). Names enter refs only through
  `shared/pull-request.ts`'s `refComponent` (lowercased, `.` written `%2e`), because `.github`,
  `x.lock` and `a..b` are repositories GitHub allows and ref components git refuses.
  `refs/rvw/placed/…` records what the flow last checked out, so a force-pushed PR doesn't make the
  worktree's old head read as the reader's own commits. Every operation on the PR's tree runs under
  `UNTRUSTED_TREE_CONFIG` (`git/ops.ts`: no hooks, no fsmonitor, no submodule recursion), because
  it is someone else's code on the reader's machine. Writes are queued per repository, worktree and
  clone target (`queue.ts`; the keys and why are in `handlers.ts`). A worktree is moved or removed
  only when it holds no work, and only by the reader: cleanup is manual.
- `main/github/` is the one HTTP boundary to GitHub — nothing else opens a connection there, and
  git's own fetches never pass through it. `client.ts`'s header is the argument: an allowlist of
  exactly `https://api.github.com` (a call names a path, never a URL; a redirect is followed by the
  client, for a GET, to the same origin only), a timeout over the whole exchange, a response size
  cap, zod on every answer, typed `GitHubFailure` codes, and an ETag cache and a rate-limit gate
  both keyed by who asked (`authScope`), so an answer fetched with a token is never served to an
  anonymous call. The transport is injected; in the app it is `net-transport.ts` over Electron's
  `net.request` — Chromium's stack, so the system proxy and trust store apply — because `net.fetch`
  under Electron 43 cannot hand a redirect back unfollowed. The token lives in `credentials.ts`'s
  closure, in main's memory, until quit: **memory-only by design until the app is signed**, since
  an unsigned app's Keychain item is readable by anything that gets JavaScript to run as Reviewer.
  It leaves that closure only as a `bearer` function the client calls; IPC answers describe a
  token, never carry one. `posting.ts` posts pending comments — every read first, then the
  writes — and `exposure.ts` refuses tokens and posting
  for a packaged run started with a debugging, logging or proxy switch.
- Two seams reach the OS through `shell.openExternal`, deliberately separate: `external-links.ts`
  admits https only (a link in a comment must never reach `file:` or a custom scheme), and
  `open-in-editor.ts` admits exactly the editor schemes in `shared/editors.ts`, on a path proven
  inside the session's checkout by realpath. Don't widen either to serve the other.

## The CLI

`cli/app.ts` is pure data — one route map over six verbs (`emit`, `check`, `diff`, `open`, `schema`,
`skills`), no process, no I/O — so tests bind it to capturing streams and `cli/index.ts` binds it to
the real process. The exit-code contract is closed: 0 ready, 1 review problems, 2 cannot-run, and
nothing else leaves the process. Use `process.exitCode`, never `process.exit()` — on macOS stdout to
a pipe is async and `exit()` discards what is still buffered, which is how `rvw diff` once silently
truncated. `LocalContext` carries the whole process surface a verb reads (cwd, env, platform, home,
stdin) so no test has to `chdir` or redefine `process.platform`.

The shebang must stay `#!/usr/bin/env node`: `bun build` treats a `bun` shebang as a bun-only
artifact and emits a bundle that throws inside Stricli under any other runtime — and `rvw` runs
under the reader's own `node`, the one on their PATH, which both launchers `exec`
(`main/cli-install.ts`'s shim, `scripts/install-cli.sh`'s). Never under the app's binary: nothing
uses `ELECTRON_RUN_AS_NODE`, and the packaged app's `runAsNode` fuse forbids it. `build:cli` writes
`dist/rvw.js` *and* `dist/package.json` (`{"type":"module"}`); both ship, and the installed
`/usr/local/bin/rvw` is a shim that execs the app's copy, so editing `cli/` mid-session means
re-running `bun run build:cli`.

## Tests

`vitest run`, node environment, **no DOM**. Every test file is `.ts`; nothing renders React, and
there is no jsdom or testing-library. That is a deliberate constraint, and the answers to it are:

- Extract the decision into a pure function and test that (most of `lib/`, all of `tools/`).
- When the invariant is real but nothing in the toolchain can see it, assert it **against the
  source**: `dom-ids.test.ts`, `DiffView.test.ts`, `index.css.test.ts`, `themes.test.ts`,
  `main/github/never-submit.test.ts` (on the TypeScript AST), `cli/no-github-credentials.test.ts`
  (on `cli/` and on the built `dist/rvw.js`). Each of those files opens with why it exists in that
  form.
- Genuinely DOM-only code (`shortcut-guard.ts`, `focus-regions.ts`'s `visibleRegions`) is left
  untested rather than tested against a stub, and says so.

Fixtures are shared, never re-hand-rolled: `src/shared/diff/fixtures.ts` (patches),
`cli/fixtures.ts` (real temp git repos via `mkdtempSync`, plus the `rvw` spawn helpers),
`src/main/github/fixtures.ts` (GitHub's JSON, cut down from live answers, for a fake transport — no
test touches the network), `src/renderer/src/stores/__fixtures__/bridge.ts` (a fake
`window.reviewer`), and `createSessionSlice` for store state. `main/pull-request/flow.test.ts` plays
GitHub with a local bare repository and `url.<base>.insteadOf`. `cli/bundle.setup.ts` is a
`globalSetup` that builds `dist/rvw.js` once so parallel CLI suites don't race on it. A suite that
spawns real processes sets its own budget per file (`vi.setConfig`, `SPAWN_SUITE_TIMEOUT_MS` in
`cli/fixtures.ts`, or per test like `flow.test.ts`'s `SLOW_MS`) rather than raising the global 5s
default: macOS scans a newly written executable on its first run, which alone has taken 38s.
`src/renderer/src/dev/preview.ts` is the hand-driven preview harness that seeds the stores for
eyeballing screens.

## Gates

```bash
bun run check   # tsgo × 4 projects, then oxlint, then oxfmt --check
bun run test    # vitest
```

Both must be clean before you are done; CI runs them plus `bun run build` and then `bun run
check:bundle` against what that built — mermaid must be outside everything the window loads at
launch and reachable only by a dynamic import, which is the bundler's to break with no line of
`src/` changing — and a macOS job that
packages the app and runs `bun run check:package` against the real `.app`; the release workflow
runs it again on the `.app` it ships. That last one exists because two shipped defects were
invisible to every other check: `files:` in `electron-builder.yml` is an **allowlist**
(electron-builder does not read `.gitignore`, so scratch directories and agent worktrees would
otherwise ship), and `extraResources` must carry the CLI's module manifest beside its bundle.
Widening either is a deliberate edit.

It also reads the Electron binary itself, because what it checks there is bytes in a Mach-O that
no test and no yaml can see. `electronFuses:` in `electron-builder.yml` turns off `runAsNode`,
`NODE_OPTIONS` and the inspector arguments and turns on `onlyLoadAppFromAsar` and embedded asar
integrity — closing the ways to run code *as* Reviewer, which the Keychain trusts — and
`check:package` reads the wire back with `@electron/fuses`' `getCurrentFuseWire` (not the
`electron-fuses read` CLI, which misprints Electron 43's ninth fuse), so a renamed option fails CI
instead of shipping an unfused app. Then `codesign --verify --deep --strict`: flipping a fuse
invalidates the linker's ad-hoc signature, and an unsigned build re-signs only because of
`resetAdHocDarwinSignature: true` — drop it and the app does not launch. Asar integrity only fully
holds once the app is signed; unsigned, whoever can edit `app.asar` can rewrite the hash in
`Info.plist` and re-sign ad hoc. The yaml's comments carry each fuse's reason.

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
- **GitHub credentials: no `gh`, nothing wider than needed, nothing on disk yet.** `gh`'s token has
  `repo`, `read:org` and `gist` scopes that cannot be removed, and `gh auth token` prints it to any
  process, so it is never delegated to. A fine-grained token is accepted after one call with it; a
  classic one only when `X-OAuth-Scopes` is exactly `public_repo`; every other prefix is refused
  before it is sent anywhere (`main/github/credentials.ts`). The token is pasted once per launch
  and held in memory: a `safeStorage` "remember" waits for signing and notarization, because until
  then it would only slow an agent down while telling the reader it was safe. Reviewer never runs
  the reader's agent either; it prepares a worktree and copies a prompt.
- **No prompt before posting, Touch ID or otherwise.** Posting is a click in the window — Post on
  a card, or Post all, which skips comments marked skipped or disagree — and it only ever makes
  pending drafts the reader submits on GitHub. `rvw` cannot post, and a run that another program
  could drive is refused by `exposure.ts`. A Touch ID check was built and removed: it guarded a
  click the reader had just made, and turning it off needed Touch ID too, which cost a settings
  refusal and two failure states for no protection drafts lacked.
- **No `immer`** (breaks the no-op guards), **no `tinykeys`/`react-hotkeys-hook`** (the guard is
  already centralized and the handlers are five-line switches), **no `dnd-kit`**, **no fuzzy-search
  library**, **no `electron-window-state`** (last published 2022, unmaintained; and the clamp
  against `screen.getAllDisplays()` that `main/window-state.ts` performs is the part naive
  implementations get wrong, which is why this was rolled rather than installed).
