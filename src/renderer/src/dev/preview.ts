import type { BranchList, LogEntry } from "../../../shared/git";
import type { RecentReview } from "../../../shared/review-ipc";
import {
  importReview,
  type Comment,
  type ReviewLayer,
  type ReviewOverview,
  type ReviewVerdict,
} from "../../../shared/review";
import {
  buildHugeAdditionPatch,
  buildManyFilesPatch,
  buildPathsPatch,
  MOVED_BLOCK_PATCH,
  MULTI_STATUS_PATCH,
  GUIDE_DEPS_PATCH,
  OUTLINE_PATCH,
} from "../../../shared/diff/fixtures";
import { parsePatch, type PatchFile } from "../../../shared/diff/patch";
import {
  markFilesRead,
  NO_COLLAPSED_FILES,
  NO_READ_FILES,
  withCollapsed,
} from "../lib/read-progress";
import { initialFolds } from "../lib/initial-folds";
import { NO_RESOLUTIONS, withResolution } from "../../../shared/comment-resolution";
import { useOnboardingStore } from "../stores/onboarding";
import { promptFor, usePullRequestStore } from "../stores/pull-request";
import { useSettingsStore } from "../stores/settings";
import { SETTINGS_DEFAULTS } from "../../../shared/settings";
import type { PullRequestWorktree } from "../../../shared/pull-request-ipc";
import type { GitHubInbox } from "../../../shared/github-ipc";
import { useRecentReviewsStore } from "../stores/recent-reviews";
import { useGitHubStore } from "../stores/github";
import { NO_POSTING } from "../lib/github-posting";
import { createSessionSlice, useReviewStore, type SessionSlice } from "../stores/review";

const HOUR_MS = 3600 * 1000;

const SUBJECTS = [
  "Fix worker pool teardown on window close",
  "Add rename detection to patch parser",
  "Extract diff toolbar composite",
  "Tune traffic-light offsets for hiddenInset",
  "Cap git output at 32 MiB",
  "Wire theme flip into the worker pool",
  "Parse NUL-separated log records",
  "Handle unborn HEAD in commit log",
];

/** A dirty repo's log: the uncommitted pseudo-entry over recent commits. */
function fixtureEntries(): LogEntry[] {
  const commits: LogEntry[] = SUBJECTS.map((subject, index) => {
    const sha = index.toString(16).repeat(40).slice(0, 40);
    return {
      kind: "commit",
      commit: {
        sha,
        shortSha: sha.slice(0, 7),
        author: index % 3 === 0 ? "alex" : "mira",
        authoredAt: new Date(Date.now() - (index + 1) * 7 * HOUR_MS).toISOString(),
        subject,
      },
    };
  });
  return [{ kind: "uncommitted" }, ...commits];
}

const FIXTURE_BRANCHES: BranchList = {
  branches: [
    "main",
    "feature/brush-selection",
    "feature/worker-pool",
    "fix/theme-flip",
    "chore/gates",
  ],
  defaultBranch: "main",
  currentBranch: "feature/brush-selection",
};

const FIXTURE_SESSION_ID = "00000000-0000-4000-8000-000000000000";

/** Fixture comments over MULTI_STATUS_PATCH: two placed on covered lines (one an
 * inline `code` ref for the sans/mono split, one a markdown body — a bold lead, a
 * list, a fenced snippet — since an agent-authored comment is prose, not a line of
 * plain text) and one whose range drifted off the diff, pinned outdated to its file
 * header. */
function fixtureComments(): Comment[] {
  return [
    {
      file: "greet.ts",
      side: "additions",
      startLine: 4,
      endLine: 6,
      body: "Extract this into a `formatGreeting` helper — `shout` and `greet` will both want it.",
      severity: "minor",
      tag: "refactor",
      // The agent's text for the change's author, with a reference in it, so the postable
      // block and its Copy can be eyeballed beside a finding written to the reader. The other
      // two comments carry none, and show nothing for it — a comment the agent wrote no
      // postable for is not for posting.
      postable:
        "Could the greeting live in a `formatGreeting` helper? [`shout`](greet.ts:5-7) will want the same string, and one helper keeps the two from drifting.",
      id: "c0000000-0000-4000-8000-000000000001",
    },
    {
      file: "added.txt",
      side: "additions",
      startLine: 1,
      endLine: 1,
      body: [
        "**[BUG]** the header is written before the file is opened, so a failed open leaves a *half-written* file behind.",
        "",
        "- move the write under the open",
        "- drop the partial on the error path",
        "",
        "```ts",
        "const handle = await open(path);",
        "await handle.write(HEADER);",
        "```",
      ].join("\n"),
      severity: "blocking",
      // A free label beside a closed level, and a folded receipt under the body: between
      // this comment and the two around it the scene carries all three severity tones, a
      // reserved tag and an invented one, so the pills can be compared in one screenshot.
      tag: "data loss",
      evidence: [
        "```",
        "$ bun test writer",
        "1 failed: leaves no file behind on a failed open",
        "```",
      ].join("\n"),
      id: "c0000000-0000-4000-8000-000000000002",
    },
    {
      file: "greet.ts",
      side: "additions",
      startLine: 80,
      endLine: 82,
      body: "This block moved since the review was written — check it still holds.",
      tag: "pre-existing",
      id: "c0000000-0000-4000-8000-000000000003",
    },
  ];
}

/** The paths a review-sized comment load spreads over: deep and shallow, two files
 * sharing a name, one long enough that its directory has to give way in the rail. */
const MANY_COMMENT_PATHS = [
  "src/renderer/src/components/CommentsPanel.tsx",
  "src/renderer/src/components/CommentThread.tsx",
  "src/renderer/src/lib/diff/comment-navigation.ts",
  "src/shared/review.ts",
  "README.md",
];

/** A review's worth of comments over `MANY_COMMENT_PATHS`: several per file, bodies
 * from a few words to a full paragraph, inline `code` runs, two anchors that drifted
 * off the diff (outdated) and two on a file the diff never carried (stranded). What
 * the sidebar list has to stay scannable under. */
function manyFixtureComments(): Comment[] {
  const bodies: [file: string, startLine: number, endLine: number, body: string][] = [
    [
      "src/renderer/src/components/CommentsPanel.tsx",
      4,
      9,
      // Markdown as an agent writes it: a bold tag, then the finding. What the rail row
      // has to strip back to words, since `**[BUG]**` spends a narrow row's opening
      // characters on punctuation.
      "**[BUG]** the preview renders the body verbatim, so a `**[BUG]**` lead reads as punctuation in the rail.\n\n- strip the markup for the row\n- keep the mono runs",
    ],
    ["src/renderer/src/components/CommentsPanel.tsx", 14, 14, "Name this."],
    [
      "src/renderer/src/components/CommentsPanel.tsx",
      22,
      26,
      "The grouping walks the ordered list twice — once here and once in `orderedComments`. One pass would do.",
    ],
    [
      "src/renderer/src/components/CommentsPanel.tsx",
      900,
      902,
      "This anchor drifted off the diff — it should pin to the file header.",
    ],
    [
      "src/renderer/src/components/CommentThread.tsx",
      7,
      7,
      "Why does the card own its own focus ring instead of taking the shell's?",
    ],
    [
      "src/renderer/src/components/CommentThread.tsx",
      31,
      35,
      "Discarding mid-edit drops the draft with no confirmation. The editor is the one place in the app where a click can destroy typed text.",
    ],
    [
      "src/renderer/src/lib/diff/comment-navigation.ts",
      12,
      18,
      "`orderedComments` re-resolves every anchor on each call and the panel calls it per render — memoised at the call site today, which is the wrong place for it to be true.",
    ],
    ["src/renderer/src/lib/diff/comment-navigation.ts", 44, 44, "Stable sort assumed here."],
    [
      "src/renderer/src/lib/diff/comment-navigation.ts",
      777,
      780,
      "Left over from the pre-frozen-review placement rule.",
    ],
    [
      "src/shared/review.ts",
      3,
      6,
      "The schema says `body` is a human sentence but nothing enforces a length — an agent emitting a whole essay here renders a card taller than the diff it annotates.",
    ],
    ["src/shared/review.ts", 20, 22, "`side` should default to `additions`."],
    ["README.md", 2, 2, "Say what `rvw open` does before the install instructions."],
    [
      "src/main/review/save.ts",
      40,
      44,
      "The write-back debounce outlives the session it belongs to.",
    ],
    ["src/main/review/save.ts", 61, 61, "Swallowed error."],
  ];
  return bodies.map(([file, startLine, endLine, body], index) => ({
    file,
    side: "additions",
    startLine,
    endLine,
    body,
    id: `c0000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
  }));
}

/** Ordered layers over MULTI_STATUS_PATCH: authored reading order, an overlapping
 * file (greet.ts appears in two layers), and a last layer whose range references a
 * file the diff no longer carries — the outdated fail-soft state. */
function fixtureLayers(): ReviewLayer[] {
  return [
    {
      id: "layer-greeting",
      label: "Add greeting API",
      summary: "New shout() built on greet()",
      description:
        "This layer introduces the public greeting surface. `greet.ts` gains a [`shout()` helper](greet.ts:5-7) that composes over the existing `greet()`, so the two share one formatting path rather than drifting apart.\n\nThe fixture file [added.txt](added.txt) ships alongside as the smoke test — open it to confirm the new entry point reads cleanly. Callers still reach the API through `greet.ts`; nothing downstream changes shape.",
      ranges: [
        { file: "greet.ts", side: "additions", startLine: 4, endLine: 6 },
        { file: "added.txt", side: "additions", startLine: 1, endLine: 2 },
      ],
      // The chapter's key hunk is the new function, not `added.txt` beside it — the case the
      // computed first-hunk excerpt gets wrong — and its picture is a skeleton whose lines
      // fall in two chapters, so the derived badges have more than one number to show.
      focus: { file: "greet.ts", side: "additions", startLine: 5, endLine: 7 },
      visual: {
        kind: "skeleton",
        caption: "What a greeting now goes through",
        lines: [
          { depth: 0, code: "greet(name: string): string", status: "same" },
          {
            depth: 1,
            code: "`hello ${name}`",
            status: "removed",
            at: { file: "greet.ts", side: "deletions", startLine: 2, endLine: 2 },
          },
          {
            depth: 1,
            code: "`hi ${name}`",
            status: "added",
            note: "reworded in its own chapter",
            at: { file: "greet.ts", side: "additions", startLine: 2, endLine: 2 },
          },
          {
            depth: 0,
            code: "shout(name: string): string",
            status: "added",
            at: { file: "greet.ts", side: "additions", startLine: 5, endLine: 5 },
          },
          {
            depth: 1,
            code: "greet(name).toUpperCase()",
            status: "added",
            note: "one formatting path",
            at: { file: "greet.ts", side: "additions", startLine: 6, endLine: 6 },
          },
        ],
      },
    },
    {
      id: "layer-housekeeping",
      label: "Housekeeping",
      summary: "The bookkeeping around the new entry point",
      description:
        "Three small slices that share nothing but their smallness: a copy pass, a rename, and a deletion. They are grouped so the reading order can put them together and move on — read the group if you want the whole sweep, or a section if you own that file.",
      ranges: [],
    },
    {
      id: "layer-notes",
      label: "Refresh the notes",
      summary: "Capitalise and extend the list",
      parent: "layer-housekeeping",
      description:
        "Small copy pass over [notes.txt](notes.txt): the second item is capitalised and a new trailing entry is appended. No code path depends on this file — it is reading material only.",
      ranges: [{ file: "notes.txt", side: "additions", startLine: 6, endLine: 6 }],
      focus: { file: "notes.txt", side: "additions", startLine: 6, endLine: 6 },
    },
    {
      id: "layer-rename",
      label: "Reword the greeting",
      summary: "hello → hi (greet.ts, shared with the API layer)",
      parent: "layer-housekeeping",
      ranges: [{ file: "greet.ts", side: "additions", startLine: 2, endLine: 2 }],
    },
    {
      id: "layer-cleanup",
      label: "Delete dead file",
      summary: "Remove doomed.txt",
      parent: "layer-housekeeping",
      ranges: [{ file: "doomed.txt", side: "deletions", startLine: 1, endLine: 2 }],
      focus: { file: "doomed.txt", side: "deletions", startLine: 1, endLine: 2 },
    },
    {
      id: "layer-legacy",
      label: "Retire legacy config",
      summary: "Range drifted — file no longer in the diff",
      description:
        "This layer targeted [config/legacy.ts](config/legacy.ts), which has since dropped out of the diff — so its file link is inert and soloing it lands on the dead-end. The prose still explains the intent even when the code is gone.",
      ranges: [{ file: "config/legacy.ts", side: "additions", startLine: 10, endLine: 12 }],
    },
  ];
}

/** The tour doc over the same fixture: a title, prose that exercises the whole grammar —
 * both reference forms (a resolving `[label](path)` link and an inline `code` span that
 * names a file), emphasis, a heading, a list, a quote, and a fence — and nothing about
 * the layers: the doc's layer sections are derived from them. */
function fixtureOverview(): ReviewOverview {
  return {
    title: "Add a shout() greeting and refresh the notes",
    // The guide's front: one sentence, the steps in order, and a flow whose changed boxes
    // each point at a hunk the preview's patch carries — so every one wears a derived badge
    // (greet → the rename chapter, shout and its call → the greeting chapter) and the two
    // unchanged boxes wear none.
    lede: "`greet.ts` gains [shout()](greet.ts:5-7), a second entry point built on `greet()`, so the two share one formatting path.",
    steps: [
      "Reword `greet()`'s template from hello to hi",
      "Add [shout()](greet.ts:5-7) on top of `greet()`",
      "Refresh [notes.txt](notes.txt) and delete `doomed.txt`",
    ],
    visual: {
      kind: "flow",
      caption: "How a caller reaches a greeting",
      nodes: [
        { id: "caller", label: "caller", status: "same" },
        {
          id: "greet",
          label: "greet()",
          status: "changed",
          note: "hello → hi",
          at: { file: "greet.ts", side: "additions", startLine: 2, endLine: 2 },
        },
        {
          id: "shout",
          label: "shout()",
          status: "added",
          note: "new entry point",
          at: { file: "greet.ts", side: "additions", startLine: 5, endLine: 6 },
        },
        { id: "upper", label: "toUpperCase()", status: "same" },
      ],
      edges: [
        { from: "caller", to: "greet", label: "name" },
        { from: "caller", to: "shout", label: "name", status: "added" },
        { from: "shout", to: "greet", status: "added" },
        { from: "shout", to: "upper", status: "added" },
      ],
    },
    // Now the folded "Reviewer's notes"; it still walks the whole prose grammar.
    body: [
      "The greeting API grows a second entry point. `greet.ts` keeps its existing `greet()` and gains [shout()](greet.ts:5-7) on top of it, so both share **one formatting path** instead of drifting apart as callers pick sides — the template [it used to build inline](greet.ts:2@deletions) is gone.",
      "Everything else in the range is bookkeeping: [notes.txt](notes.txt) gets a copy pass, `added.txt` lands as the smoke test for the new entry point, and a dead file goes away. Read the greeting layer first — the rest only makes sense once the shape of the API is in your head.",
      "## Reading order",
      "- `greet.ts` first — the API is the argument of the change\n- [notes.txt](notes.txt) after, *only* if you own the docs\n- the deletion last; it explains itself",
      "> The fixture prose deliberately walks every block the grammar renders, so the doc is its own preview.",
      "```ts\nexport function shout(name: string): string {\n  return `${greet(name).toUpperCase()}!`;\n}\n```",
    ].join("\n\n"),
    // The author's one judgement, so the doc's title line and every recents row drawn from
    // this fixture carry the chip the two surfaces have to agree about.
    verdict: "caution",
  };
}

/** The guide scene's layers over `OUTLINE_PATCH` — the "retry blob reads" change Capy's guide
 * illustrates, so the preview can be held against that picture: a core chapter with a skeleton,
 * a chapter with neither visual nor focus (its card is the computed first range), a group with
 * two parts (one with a `focus`), and a skim chapter. Line numbers are the patch's own. */
function guideLayers(): ReviewLayer[] {
  const blob = (side: "additions" | "deletions", startLine: number, endLine: number) =>
    ({ file: "src/blob.ts", side, startLine, endLine }) as const;
  return [
    {
      id: "guide-retry",
      label: "Retry blob reads with backoff",
      summary: "A failed read is retried, never cached",
      description:
        "[`loadBlob`](src/blob.ts:4-5) now goes through `withRetry`, which backs off and tries again on a network error. The session cache is gone, so nothing can replay an old failure.\n\nThe sync loop asks the client for the same retry, and [`backoff()`](tools/sync.py:23-24) caps the delay at thirty seconds.",
      ranges: [
        blob("additions", 2, 5),
        blob("deletions", 3, 13),
        { file: "tools/sync.py", side: "additions", startLine: 14, endLine: 14 },
        { file: "tools/sync.py", side: "additions", startLine: 21, endLine: 24 },
        // `GUIDE_DEPS_PATCH`: the retry helper added, the session cache deleted, the viewer
        // rewired from one to the other — what the Deps tab draws.
        { file: "src/retry.ts", side: "additions", startLine: 1, endLine: 6 },
        { file: "src/cache.ts", side: "deletions", startLine: 1, endLine: 8 },
        { file: "web/viewer.ts", side: "deletions", startLine: 1, endLine: 1 },
        { file: "web/viewer.ts", side: "additions", startLine: 1, endLine: 1 },
        { file: "web/viewer.ts", side: "deletions", startLine: 5, endLine: 5 },
        { file: "web/viewer.ts", side: "additions", startLine: 5, endLine: 5 },
      ],
      focus: blob("additions", 4, 5),
      visual: {
        kind: "skeleton",
        caption: "How a blob read reaches the network",
        lines: [
          { depth: 0, code: "loadBlob(path)", status: "removed", at: blob("deletions", 5, 5) },
          {
            depth: 0,
            code: "loadBlob(path, attempts = 3)",
            status: "added",
            at: blob("additions", 4, 4),
          },
          {
            depth: 1,
            code: "blobCache.get(path)",
            status: "removed",
            note: "a cached failure was returned for the rest of the session",
            at: blob("deletions", 6, 8),
          },
          {
            depth: 1,
            code: "withRetry(() => fetchBlob(path), attempts)",
            status: "added",
            note: "backs off and tries again on a network error",
            at: blob("additions", 5, 5),
          },
          { depth: 2, code: "fetchBlob(path)", status: "same" },
          {
            depth: 1,
            code: "blobCache.set(path, read)",
            status: "removed",
            at: blob("deletions", 11, 11),
          },
          {
            depth: 0,
            code: "Syncer.send(item, retry=True)",
            status: "added",
            note: "the sync loop asks for the same retry",
            at: { file: "tools/sync.py", side: "additions", startLine: 14, endLine: 14 },
          },
        ],
      },
    },
    {
      id: "guide-manifest",
      label: "Record each attempt in the manifest",
      summary: "The manifest says which attempt produced a blob",
      description:
        "`Manifest.record` takes the attempt number and stores `path#attempt`, and `patchText` rebuilds patch text from the fresh read. The size warning moves from 100 entries to 500, since retries now add entries.",
      ranges: [blob("additions", 8, 10), blob("additions", 15, 16), blob("additions", 21, 21)],
    },
    {
      id: "guide-server",
      label: "Name the server and trim the handlers",
      summary: "Two small edits the retry work made necessary",
      description:
        "The health check reports which server answered, so a retried request can be traced; and the handler the old cache needed goes away.",
      ranges: [],
    },
    {
      id: "guide-server-name",
      label: "Give the server a name",
      summary: "serve takes a name and the health check prints it",
      parent: "guide-server",
      ranges: [
        { file: "cmd/server.go", side: "additions", startLine: 5, endLine: 10 },
        { file: "cmd/server.go", side: "additions", startLine: 19, endLine: 19 },
      ],
      focus: { file: "cmd/server.go", side: "additions", startLine: 9, endLine: 10 },
    },
    {
      id: "guide-server-handlers",
      label: "Drop the unused handler",
      summary: "third() had no caller once the cache was gone",
      parent: "guide-server",
      ranges: [
        { file: "src/handlers.ts", side: "additions", startLine: 7, endLine: 7 },
        { file: "src/handlers.ts", side: "deletions", startLine: 7, endLine: 11 },
      ],
    },
    {
      id: "guide-install",
      label: "Install script and docs",
      summary: "A helper for the copy, and one line of README",
      skim: true,
      ranges: [
        {
          file: "scripts/install.sh",
          side: "additions",
          startLine: 4,
          endLine: 9,
          note: "install_bin wraps the copy",
        },
        { file: "README.md", side: "additions", startLine: 4, endLine: 4 },
      ],
    },
  ];
}

function guideOverview(): ReviewOverview {
  const blob = (side: "additions" | "deletions", startLine: number, endLine: number) =>
    ({ file: "src/blob.ts", side, startLine, endLine }) as const;
  return {
    title: "Retry blob reads with backoff instead of caching failures",
    verdict: "ready",
    lede: "A single failed blob read used to stick in the session cache, so one network blip broke every diff that touched that file until a reload.",
    steps: [
      "Reads go through `withRetry`, which backs off and tries again before giving up.",
      "The blob cache is gone, so nothing replays an old failure.",
      "The manifest records which attempt produced each blob.",
      "The server and the install script pick up two small follow-ons.",
    ],
    visual: {
      kind: "flow",
      caption: "How a blob read reaches the network",
      nodes: [
        { id: "sync", label: "Syncer.sync()", status: "same" },
        {
          id: "load",
          label: "loadBlob()",
          status: "changed",
          note: "async, takes attempts",
          at: blob("additions", 4, 4),
        },
        {
          id: "cache",
          label: "blobCache",
          status: "removed",
          note: "replayed failures",
          at: blob("deletions", 3, 3),
        },
        {
          id: "retry",
          label: "withRetry()",
          status: "added",
          note: "backs off on network errors",
          at: blob("additions", 5, 5),
        },
        { id: "fetch", label: "fetchBlob()", status: "same" },
        {
          id: "record",
          label: "Manifest.record()",
          status: "changed",
          at: blob("additions", 15, 16),
        },
        {
          id: "backoff",
          label: "backoff()",
          status: "added",
          at: { file: "tools/sync.py", side: "additions", startLine: 23, endLine: 24 },
        },
      ],
      edges: [
        { from: "sync", to: "load", label: "path" },
        { from: "load", to: "cache", status: "removed" },
        { from: "load", to: "retry", status: "added" },
        { from: "retry", to: "fetch", label: "attempt", status: "added" },
        { from: "retry", to: "backoff", label: "delay", status: "added" },
        { from: "load", to: "record", label: "path" },
      ],
    },
    body: "The retry budget is per call, not per host; if the network is down for longer than the budget, reads fail exactly as before, just later. Worth a follow-up to share one budget across a sync.",
  };
}

/** A real artifact, handed in by whoever drives the browser: `window.reviewerPreviewArtifact =
 * { bytes, patch }` set before load (Playwright's `addInitScript`). Lets a visual check run the
 * guide over an artifact `rvw emit` produced, against the patch it was written for, without
 * copying either into the repository. */
type PreviewArtifact = { bytes: string; patch: string };

function injectedArtifact(): PreviewArtifact | null {
  const value: unknown = (window as { reviewerPreviewArtifact?: unknown }).reviewerPreviewArtifact;
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const { bytes, patch } = value as Partial<PreviewArtifact>;
  return typeof bytes === "string" && typeof patch === "string" ? { bytes, patch } : null;
}

/** Marks the named files read, exactly as the app does: signed against their own content
 * and folded away in the code view, so a preview can't show a state the real gestures
 * cannot produce. */
function readFixture(
  files: PatchFile[],
  paths: string[],
): Pick<SessionSlice, "readFiles" | "collapsedFiles"> {
  const wanted = new Set(paths);
  const marked = files.filter((file) => wanted.has(file.path));
  return {
    readFiles: markFilesRead(NO_READ_FILES, marked, true),
    collapsedFiles: withCollapsed(NO_COLLAPSED_FILES, paths, true),
  };
}

/** One inactive tab to seed beside the active one. A `title` makes it a *review* session,
 * which is what the strip is mostly full of in practice and what the naming rule is really
 * about; without one it is a plain repository session, named after its folder. */
type SiblingSpec = { name: string; title?: string; head?: string };

/** A derived sibling slice for the tab-strip states; id must be a unique uuid. */
function siblingSlice(ordinal: number, spec: SiblingSpec): SessionSlice {
  const digit = (ordinal % 10).toString();
  const { name, title } = spec;
  const repo = { path: `/preview/${name}`, name };
  const head = spec.head ?? `feature/${name}`;
  const review = title === undefined ? null : { ...repo, base: "main", head };
  // Everything else is the factory's default, which is what an unactivated tab holds: nothing
  // walked, nothing loaded, `needsDerive` still set.
  return createSessionSlice(
    { id: `${digit.repeat(8)}-${digit.repeat(4)}-4000-8000-${digit.repeat(12)}`, repo },
    {
      reviewDiff: review === null ? null : { kind: "refs", base: review.base, head: review.head },
      reviewOrigin:
        review === null
          ? null
          : {
              repo,
              base: review.base,
              head: review.head,
              patch: null,
              reviewedHead: null,
              pr: null,
            },
      overview: title === undefined ? null : { title },
    },
  );
}

/** Adds inactive sibling tabs around whatever state already seeded the active
 * session — key insertion order is tab order, so `before`/`after` place them. */
function seedSiblingTabs(before: SiblingSpec[], after: SiblingSpec[]): void {
  const state = useReviewStore.getState();
  const sessions: Record<string, SessionSlice> = {};
  for (const [index, spec] of before.entries()) {
    const sibling = siblingSlice(index + 1, spec);
    sessions[sibling.id] = sibling;
  }
  Object.assign(sessions, state.sessions);
  for (const [index, spec] of after.entries()) {
    const sibling = siblingSlice(before.length + index + 1, spec);
    sessions[sibling.id] = sibling;
  }
  // The strip is explicit state (see `tabs`), so a seeded store has to seed it too — one stop
  // per session, in this order, plus whatever start tabs the state opened afterwards.
  useReviewStore.setState({
    sessions,
    tabs: Object.keys(sessions).map((id) => ({ kind: "session", id })),
  });
}

/** The reviews directory as the start screen sees it: a spread of ages so every date band is
 * inhabited, an untitled review (named by its range), one that could not be read, one
 * self-contained artifact, and — since most rows carry none — a few at each stage of being
 * read, so the resume marks can be seen against the untouched rows they have to stand out
 * from. Seeded rather than fetched — the gates run in a plain browser, where there is no
 * bridge to answer `reviews:recent`. */
function fixtureRecents(): RecentReview[] {
  const rows: [
    hoursAgo: number,
    repo: string,
    title: string | null,
    comments: number,
    progress: RecentReview["progress"],
    verdict: ReviewVerdict | null,
  ][] = [
    [
      1,
      "reviewer",
      "Name tabs after the review, not the repository",
      4,
      { read: 3, total: 11 },
      "caution",
    ],
    [5, "reviewer", "Drop the env-var fallback from settings", 2, null, "ready"],
    [9, "api-server", "Split the ingest worker in two", 7, { read: 14, total: 16 }, "blocked"],
    [26, "api-server", null, 1, null, null],
    [50, "dotfiles", "Move the shell config under XDG", 0, { read: 4, total: 4 }, "ready"],
    [96, "reviewer", "Anchor comments against the real diff", 11, null, null],
    [200, "web-app", "Rewrite the onboarding flow", 3, { read: 1, total: 23 }, "caution"],
    [400, "notes", "Retire the legacy exporter", 5, null, null],
    [1400, "playground", "First pass at the parser", 2, null, null],
  ];
  const reviews: RecentReview[] = rows.map(
    ([hoursAgo, repo, title, comments, progress, verdict], index) => ({
      path: `/Users/demo/.rvw/reviews/${repo}-main-feature-${index}.reviewer.json`,
      modified: new Date(Date.now() - hoursAgo * HOUR_MS).toISOString(),
      summary: {
        repoPath: `/Users/demo/work/${repo}`,
        repoName: repo,
        base: "main",
        head: index % 3 === 0 ? `feature/branch-${index}` : "a".repeat(40),
        title,
        comments,
        layers: (index % 4) + 1,
        portable: index === 2,
        // Most rows carry one and some do not, which is the mix the list has to read well
        // in: a chip column that is only sometimes filled is the thing to look at.
        verdict,
      },
      progress,
    }),
  );
  // A file named like an artifact that is not one: listed, and honest about it.
  reviews.splice(3, 0, {
    path: "/Users/demo/.rvw/reviews/half-written-emit.reviewer.json",
    modified: new Date(Date.now() - 20 * HOUR_MS).toISOString(),
    summary: null,
    progress: null,
  });
  return reviews;
}

/** Puts the recents store where a real one lands after a read, so the start screen's list is
 * populated in the browser. `extra` pads the count past what the screen shows, which is what
 * makes the "search all N" door and the "most recent of N" footnote appear. */
function seedRecents(reviews: RecentReview[], extra = 0): void {
  const padded = [
    ...reviews,
    ...Array.from({ length: extra }, (_, index) => ({
      path: `/Users/demo/.rvw/reviews/older-${index}.reviewer.json`,
      modified: new Date(Date.now() - (2000 + index * 24) * HOUR_MS).toISOString(),
      summary: {
        repoPath: "/Users/demo/work/reviewer",
        repoName: "reviewer",
        base: "main",
        head: `feature/old-${index}`,
        title: `An older review (${index})`,
        comments: index % 5,
        layers: 1,
        portable: false,
        verdict: null,
      },
      progress: null,
    })),
  ];
  useRecentReviewsStore.setState({
    phase: "loaded",
    dir: "/Users/demo/.rvw/reviews",
    reviews: padded,
    truncated: 0,
    unreadable: false,
    query: "",
    activeIndex: padded.length > 0 ? 0 : -1,
  });
}

/** Boots the store as if one hydrated, derived session were active. */
function seedSession(overrides: Partial<SessionSlice>): void {
  const slice = createSessionSlice(
    { id: FIXTURE_SESSION_ID, repo: { path: "/preview/fixture", name: "fixture" } },
    {
      log: { phase: "loaded", entries: fixtureEntries() },
      branches: { phase: "loaded", list: FIXTURE_BRANCHES },
      brush: { anchor: 0, focus: 0 },
      // A fresh session lists the branch it is standing on and compares to nothing, so `base`
      // stays at the factory's null; the states that show a comparison set it themselves.
      head: FIXTURE_BRANCHES.currentBranch,
      selection: { kind: "uncommitted" },
      diff: { phase: "empty" },
      commitSelection: { kind: "uncommitted" },
      // Already derived, with a ticket past the initial one — the state this boots into is
      // one an activation has already been through.
      needsDerive: false,
      requestTicket: 1,
      ...overrides,
    },
  );
  useReviewStore.setState({
    boot: "ready",
    sessions: { [slice.id]: slice },
    tabs: [{ kind: "session", id: slice.id }],
    activeSessionId: slice.id,
  });
}

/** The inbox's rows (B5): four pull requests waiting on the reader, one a draft, one opened by
 * an app, aged from minutes to weeks. */
function fixtureInbox(): GitHubInbox {
  const ago = (hours: number): string => new Date(Date.now() - hours * HOUR_MS).toISOString();
  const pr = (owner: string, repo: string, number: number) =>
    ({ host: "github.com", owner, repo, number }) as const;
  return {
    items: [
      {
        pullRequest: pr("acme", "widget", 482),
        title: "Retry flaky uploads with exponential backoff",
        author: "mira",
        updatedAt: ago(0.3),
        draft: false,
      },
      {
        pullRequest: pr("acme", "gadget", 97),
        title: "Move the settings schema into shared and validate it on read",
        author: "alex",
        updatedAt: ago(5),
        draft: true,
      },
      {
        pullRequest: pr("tooling", "lint-rules", 1204),
        title: "Bump @typescript/native-preview from 7.0.0-dev.20260901 to 7.0.0-dev.20260929",
        author: "dependabot[bot]",
        updatedAt: ago(30),
        draft: false,
      },
      {
        pullRequest: pr("acme", "widget", 455),
        title: "Document the worktree layout",
        author: "sam",
        updatedAt: ago(24 * 16),
        draft: false,
      },
    ],
    total: 4,
    incomplete: false,
  };
}

/** Review Pull Request…'s dialog over the start screen, in one of its states: the pull request
 * found and prepared (the prompt, a worktree list with a clean row and one kept for its
 * changes), no checkout known (Locate and the clone), or a refusal under the fetch. GitHub's
 * answer rides along: the prepared scene has the title, state and base from GitHub; the failure
 * scene has GitHub's refusal (a private repository) under the local guess. */
function seedPullRequestDialog(kind: "prepared" | "not-found" | "failure" | "busy"): void {
  useReviewStore.setState({ boot: "ready", sessions: {}, tabs: [], activeSessionId: null });
  useOnboardingStore.setState({
    open: false,
    cli: { supported: true, installed: true, path: "/usr/local/bin/rvw", shadowedBy: null },
  });
  seedRecents(fixtureRecents(), 14);
  const pr = { host: "github.com", owner: "acme", repo: "widget", number: 482 } as const;
  const root = "/Users/you/Library/Application Support/Reviewer/worktrees";
  const rows: PullRequestWorktree[] = [
    {
      path: `${root}/acme/widget-482`,
      pullRequest: pr,
      checkout: "/Users/you/code/widget",
      head: "4f1c2a9b7d3e5f60718293a4b5c6d7e8f9012345",
      changes: "none",
      branch: null,
      locked: null,
    },
    {
      path: `${root}/acme/widget-471`,
      pullRequest: { ...pr, number: 471 },
      checkout: "/Users/you/code/widget",
      head: "9a8b7c6d5e4f30211203948576afbecd01234567",
      changes: "commits",
      branch: null,
      locked: null,
    },
    {
      path: `${root}/acme/widget-455`,
      pullRequest: { ...pr, number: 455 },
      checkout: "/Users/you/code/widget",
      head: "1a2b3c4d5e6f708192a3b4c5d6e7f80912345678",
      changes: "uncommitted",
      branch: null,
      locked: null,
    },
  ];
  const checkout = {
    repo: { path: "/Users/you/code/widget", name: "widget" },
    remote: "upstream",
  };
  const result = {
    worktree: `${root}/acme/widget-482`,
    head: "4f1c2a9b7d3e5f60718293a4b5c6d7e8f9012345",
    // GitHub named the base in the prepared scene, so the prompt compares against it.
    base: kind === "prepared" ? "upstream/release/2.4" : "upstream/main",
    change: "created",
  } as const;
  usePullRequestStore.setState({
    open: true,
    input: "https://github.com/acme/widget/pull/482",
    target: pr,
    checkout:
      kind === "not-found"
        ? { kind: "notFound" }
        : { kind: "found", checkout, suggested: { name: "main", from: "remoteHead" } },
    base: kind === "prepared" ? "release/2.4" : "main",
    info:
      kind === "failure"
        ? { phase: "failed", failure: { code: "notFound" } }
        : {
            phase: "loaded",
            info: {
              title: "Retry flaky uploads with exponential backoff",
              state: "open",
              draft: kind === "busy",
              base: kind === "prepared" ? "release/2.4" : "main",
              head: "4f1c2a9b7d3e5f60718293a4b5c6d7e8f9012345",
            },
          },
    inbox: { phase: "idle" },
    busy: kind === "busy" ? "preparing" : null,
    // The busy scene also asks to confirm a removal, so both in-place states are in one shot.
    confirmingRemoval: kind === "busy" ? `${root}/acme/widget-482` : null,
    failure: kind === "failure" ? { code: "git", failure: { code: "authFailed" } } : null,
    prepared:
      kind === "prepared"
        ? { result, prompt: promptFor(SETTINGS_DEFAULTS.pullRequestPrompt, pr, result) }
        : null,
    worktrees: { phase: "loaded", rows: kind === "not-found" ? [] : rows },
  });
}

/** Dev-only: `?state=<name>` seeds the store with a fixture so every diff-area state
 * is reachable by URL for the visual gates (shoot/checks run in a plain browser,
 * where no bridge and no repository exist). Dead code in production builds — the
 * import in main.tsx is guarded by `import.meta.env.DEV`. */
export function applyPreviewState(): void {
  const state = new URLSearchParams(window.location.search).get("state");
  if (state === null) {
    return;
  }

  switch (state) {
    case "loading":
      seedSession({
        log: { phase: "loading" },
        branches: { phase: "loading" },
        brush: null,
        selection: null,
        commitSelection: null,
        diff: { phase: "loading" },
      });
      break;
    case "empty":
      seedSession({ diff: { phase: "empty" } });
      break;
    case "error":
      seedSession({ diff: { phase: "failed", failure: { code: "unknownRevision" } } });
      break;
    case "log-error": {
      const failure = { code: "notARepo", path: "/preview/fixture" } as const;
      seedSession({
        log: { phase: "failed", failure },
        branches: { phase: "failed", failure },
        brush: null,
        selection: null,
        commitSelection: null,
        diff: { phase: "failed", failure },
      });
      break;
    }
    case "brush": {
      const files = parsePatch(MULTI_STATUS_PATCH, "preview:brush");
      seedSession({
        brush: { anchor: 0, focus: 3 },
        diff: { phase: "loaded", loadId: 1, files },
        selectedFilePath: files[0]?.path ?? null,
      });
      break;
    }
    case "branches": {
      const files = parsePatch(MULTI_STATUS_PATCH, "preview:branches");
      seedSession({
        base: "main",
        selection: {
          kind: "branches",
          base: "main",
          head: "feature/brush-selection",
        },
        diff: { phase: "loaded", loadId: 1, files },
        selectedFilePath: files[0]?.path ?? null,
      });
      break;
    }
    case "branch-empty":
      seedSession({
        base: "main",
        // What `base..head` actually walks: only the commits head adds, and never the
        // working-tree row — a comparison is between two committed refs.
        log: { phase: "loaded", entries: fixtureEntries().slice(1, 4) },
        brush: { anchor: 0, focus: 2 },
        selection: {
          kind: "branches",
          base: "main",
          head: "feature/brush-selection",
        },
        diff: { phase: "empty" },
      });
      break;
    case "loaded": {
      const files = parsePatch(MULTI_STATUS_PATCH, "preview:loaded");
      seedSession({
        diff: { phase: "loaded", loadId: 1, files },
        selectedFilePath: files[0]?.path ?? null,
      });
      break;
    }
    case "comments": {
      const files = parsePatch(MULTI_STATUS_PATCH, "preview:comments");
      seedSession({
        diff: { phase: "loaded", loadId: 1, files },
        selectedFilePath: files[0]?.path ?? null,
        comments: fixtureComments(),
      });
      break;
    }
    case "moved": {
      // A function that moved between two files and was re-indented on the way — the patch
      // `moved.test.ts` is built on — with a comment parked on the destination's first line,
      // which is the collision the render half had to settle: the note on top, the card under
      // it, both on line 3 of `src/moved-to.ts`. The other end carries the mirror note.
      const files = parsePatch(MOVED_BLOCK_PATCH, "preview:moved");
      seedSession({
        diff: { phase: "loaded", loadId: 1, files },
        selectedFilePath: files[0]?.path ?? null,
        comments: [
          {
            file: "src/moved-to.ts",
            side: "additions",
            startLine: 3,
            endLine: 3,
            body: "Worth a test now that it is on its own — `formatTitle` has three branches.",
            severity: "minor",
            tag: "refactor",
            id: "c0000000-0000-4000-8000-000000000031",
          },
        ],
      });
      break;
    }
    case "comments-pr": {
      // The same comments on a review that names its pull request: the postable block gains
      // "Copy & open on GitHub" beside Copy. The reviewed head is two commits back in
      // `fixtureEntries`, so the button's tooltip carries the moved-branch warning.
      const files = parsePatch(MULTI_STATUS_PATCH, "preview:comments-pr");
      seedSession({
        diff: { phase: "loaded", loadId: 1, files },
        selectedFilePath: files[0]?.path ?? null,
        comments: fixtureComments(),
        reviewDiff: { kind: "refs", base: "main", head: "feature/brush-selection" },
        reviewOrigin: {
          repo: { path: "/preview/fixture", name: "fixture" },
          base: "main",
          head: "feature/brush-selection",
          patch: null,
          reviewedHead: "2".repeat(40),
          pr: { host: "github.com", owner: "acme", repo: "fixture", number: 42 },
        },
      });
      break;
    }
    case "comments-pr-github": {
      // `comments-pr` after GitHub answered the check (B4) at the reviewed commit: its diff
      // leaves the first comment's lines out, so that card's postable block carries the note
      // beside Copy & open on GitHub. The reviewed head is GitHub's head, so the button's tooltip
      // drops the moved-branch warning — GitHub outranks the local branch.
      const files = parsePatch(MULTI_STATUS_PATCH, "preview:comments-pr-github");
      const reviewedHead = "2".repeat(40);
      seedSession({
        diff: { phase: "loaded", loadId: 1, files },
        selectedFilePath: files[0]?.path ?? null,
        comments: fixtureComments(),
        reviewDiff: { kind: "refs", base: "main", head: "feature/brush-selection" },
        reviewOrigin: {
          repo: { path: "/preview/fixture", name: "fixture" },
          base: "main",
          head: "feature/brush-selection",
          patch: null,
          reviewedHead,
          pr: { host: "github.com", owner: "acme", repo: "fixture", number: 42 },
        },
        githubCheck: {
          status: "checked",
          check: {
            kind: "compared",
            head: reviewedHead,
            outside: ["c0000000-0000-4000-8000-000000000001"],
          },
          staleBecause: null,
        },
      });
      break;
    }
    case "comments-pr-posting":
    case "comments-pr-head-moved": {
      // Layer C on the same review, with a token for its owner held in main: one comment
      // pending on GitHub (with Remove), one whose last post failed (the quiet "Not posted" note,
      // beside its Post), and one that went out with a submitted review. The rail's foot carries
      // Post all (1) and Open on GitHub. `-head-moved` adds the one
      // question posting asks: the pull request moved past the reviewed commit.
      const files = parsePatch(MULTI_STATUS_PATCH, `preview:${state}`);
      const reviewedHead = "2".repeat(40);
      const [first, second, third] = fixtureComments();
      const comments: Comment[] = [
        ...(first === undefined ? [] : [first]),
        ...(second === undefined
          ? []
          : [
              {
                ...second,
                postable:
                  "Opening the file before writing the header would keep a failed open from leaving a half-written file behind.",
              },
            ]),
        ...(third === undefined
          ? []
          : [{ ...third, postable: "Does this still hold after the block moved?" }]),
      ];
      useGitHubStore.setState({
        status: {
          tokens: [{ kind: "fineGrained", login: "you", owner: "acme", expiresAt: null }],
          exposedBy: [],
        },
      });
      seedSession({
        diff: { phase: "loaded", loadId: 1, files },
        selectedFilePath: files[0]?.path ?? null,
        comments,
        reviewDiff: { kind: "refs", base: "main", head: "feature/brush-selection" },
        reviewOrigin: {
          repo: { path: "/preview/fixture", name: "fixture" },
          base: "main",
          head: "feature/brush-selection",
          patch: null,
          reviewedHead,
          pr: { host: "github.com", owner: "acme", repo: "fixture", number: 42 },
        },
        // A review opened from its file — the one kind that can post (`noRecord` otherwise).
        reviewPath: "/preview/fixture.reviewer.json",
        posting: {
          ...NO_POSTING,
          posted: {
            comments: {
              ...(first === undefined
                ? {}
                : { [first.id]: { state: "pending" as const, postable: null } }),
              ...(third === undefined
                ? {}
                : { [third.id]: { state: "submitted" as const, postable: null } }),
            },
            unverified: null,
          },
          outcomes:
            second === undefined
              ? {}
              : { [second.id]: { kind: "failed", failure: { code: "network" } } },
          headMoved:
            state === "comments-pr-head-moved" && second !== undefined
              ? { head: "9".repeat(40), ids: [second.id] }
              : null,
        },
      });
      break;
    }
    case "comments-resolved": {
      // The same three comments with the reader's marks on two of them: one addressed, one
      // disagreed with, one still open. What this scene is for is the comparison the design
      // rests on — the author's coloured pills against the reader's greyscale mark, and the
      // warning-toned drift row against both — plus the rail's "1 of 3 open" and the two-way
      // copy menu that only exists once something is marked.
      const files = parsePatch(MULTI_STATUS_PATCH, "preview:comments-resolved");
      const comments = fixtureComments();
      let resolvedComments = NO_RESOLUTIONS;
      const [first, , drifted] = comments;
      if (first !== undefined) {
        resolvedComments = withResolution(resolvedComments, first, "addressed");
      }
      if (drifted !== undefined) {
        resolvedComments = withResolution(resolvedComments, drifted, "disagree");
      }
      seedSession({
        diff: { phase: "loaded", loadId: 1, files },
        selectedFilePath: files[0]?.path ?? null,
        comments,
        resolvedComments,
      });
      break;
    }
    case "comments-many": {
      // A review-sized comment load: what the sidebar list is really sized for.
      const files = parsePatch(buildPathsPatch(MANY_COMMENT_PATHS, 40), "preview:comments-many");
      const comments = manyFixtureComments();
      seedSession({
        diff: { phase: "loaded", loadId: 1, files },
        selectedFilePath: files[0]?.path ?? null,
        comments,
        activeCommentId: comments[6]?.id ?? null,
      });
      break;
    }
    case "layers": {
      const files = parsePatch(MULTI_STATUS_PATCH, "preview:layers");
      seedSession({
        diff: { phase: "loaded", loadId: 1, files },
        selectedFilePath: files[0]?.path ?? null,
        comments: fixtureComments(),
        layers: fixtureLayers(),
      });
      break;
    }
    case "overview": {
      // Where a review with a tour doc opens: the doc on the content surface, the rail's
      // Overview row selected beside it.
      const files = parsePatch(MULTI_STATUS_PATCH, "preview:overview");
      seedSession({
        diff: { phase: "loaded", loadId: 1, files },
        selectedFilePath: files[0]?.path ?? null,
        comments: fixtureComments(),
        layers: fixtureLayers(),
        overview: fixtureOverview(),
        overviewOpen: true,
      });
      break;
    }
    case "overview-wide": {
      // A doc whose layers span more files than a section lists, plus a rollup with its
      // sections under it: the file lists collapse, and the nesting is named in words
      // rather than indented, so every section keeps the same reading width.
      const files = parsePatch(buildManyFilesPatch(14, 4), "preview:overview-wide");
      const range = (index: number) =>
        ({
          file: `src/file-${String(index).padStart(2, "0")}.ts`,
          side: "additions",
          startLine: 1,
          endLine: 4,
        }) as const;
      seedSession({
        diff: { phase: "loaded", loadId: 1, files },
        selectedFilePath: files[0]?.path ?? null,
        layers: [
          {
            id: "wide",
            label: "Generated surface",
            summary: "Every module gains a constant table",
            description: "The bulk of the change.",
            ranges: Array.from({ length: 9 }, (_, index) => range(index)),
          },
          {
            id: "rollup",
            label: "Follow-on wiring",
            summary: "Everything that had to move once the tables existed",
            description:
              "The generated surface is inert until something reads it. This group is that something: the callers first, then the tests that pin them.",
            ranges: [],
          },
          {
            id: "rollup-a",
            label: "Callers",
            summary: "Point the callers at the table",
            description: "Two call sites, one direct and one behind a re-export.",
            parent: "rollup",
            ranges: [],
          },
          {
            id: "rollup-a1",
            label: "The direct call",
            summary: "The module that reads the table itself",
            parent: "rollup-a",
            ranges: [range(9)],
          },
          {
            id: "rollup-a2",
            label: "The re-export",
            summary: "The barrel that forwards it",
            parent: "rollup-a",
            ranges: [range(10)],
          },
          {
            id: "rollup-b",
            label: "Tests",
            summary: "Cover the new table",
            parent: "rollup",
            ranges: [range(11)],
          },
        ],
        overview: {
          title: "Generate the constant tables",
          body: "A wide, mechanical change: every module under `src/` gains a generated constant table, then two follow-on slices wire the callers and the tests.\n\nRead the generated surface once, then skim — the interesting review is in the follow-on layers.",
        },
        overviewOpen: true,
      });
      break;
    }
    case "overview-skim": {
      // The mechanical chapter and the moved branch, on one screen — the two halves of the
      // `skim` + `reviewedHead` release. A skim section is the same section set denser, with
      // the chip on its heading and on its index row; the drift line sits under the headline
      // stats, which is the one place the doc says *when* the review is from.
      const paths = [
        "src/engine.ts",
        "src/util.ts",
        "bun.lock",
        "generated/api-client.ts",
        "generated/schema.ts",
        "dist/bundle.min.js",
      ];
      const files = parsePatch(buildPathsPatch(paths, 4), "preview:overview-skim");
      const range = (file: string) =>
        ({ file, side: "additions", startLine: 1, endLine: 4 }) as const;
      const source = { path: "/preview/fixture", name: "fixture" };
      // A note per range, which is where the two halves of this scene meet: the skim chapter
      // is a list of paths nobody will open, so the line beside each one is the whole of what
      // the reader gets from it. The engine chapter carries them too, to show the same slot
      // at a section's full width — and `src/util.ts` deliberately carries none, since a row
      // without one is what the empty slot has to look like beside a row with one.
      const noted = (file: string, note: string) => ({ ...range(file), note });
      const skimLayers: ReviewLayer[] = [
        {
          id: "engine",
          label: "The retry budget",
          summary: "Retries now back off per host rather than per request",
          description:
            "The engine holds one budget per host and the util reads it. Everything below this chapter follows from that one decision.",
          // `src/util.ts` as a whole-file range (`{ file }`), the form an author writes for a
          // file the chapter owns outright — it must read exactly like the line range beside it.
          ranges: [noted("src/engine.ts", "holds the per-host budget"), { file: "src/util.ts" }],
        },
        {
          id: "mechanical",
          label: "Generated and locked",
          summary: "The regenerated client, its schema, the lockfile and the bundle",
          skim: true,
          ranges: [
            noted("bun.lock", "axios 1.6 → 1.7, one transitive bump"),
            noted("generated/api-client.ts", "regenerated from the schema below — no hand edits"),
            // Exactly the schema's 120-character cap, so the scene shows the longest note
            // there can be: it truncates against the row's measure rather than wrapping it,
            // and the hover carries the rest.
            noted(
              "generated/schema.ts",
              "the retry fields the engine reads, and nothing else moved in it — regenerated whenever the upstream API contract changes",
            ),
            noted("dist/bundle.min.js", "checked-in build output, regenerated"),
          ],
        },
      ];
      seedSession({
        diff: { phase: "loaded", loadId: 1, files },
        selectedFilePath: files[0]?.path ?? null,
        reviewDiff: { kind: "refs", base: "main", head: "feature/brush-selection" },
        reviewOrigin: {
          repo: source,
          base: "main",
          head: "feature/brush-selection",
          patch: null,
          // Two commits back in `fixtureEntries`, so the doc says the branch has moved twice
          // since — the case the field exists for.
          reviewedHead: "2".repeat(40),
          pr: null,
        },
        layers: skimLayers,
        // What the first diff load would have written (`lib/initial-folds.ts`): the harness
        // seeds slices directly rather than through `runDiffLoad`, so a scene that wants to
        // show the state *after* a load has to carry its result.
        collapsedFiles: withCollapsed(NO_COLLAPSED_FILES, initialFolds(files, skimLayers), true),
        overview: {
          title: "Back off per host",
          body: "The retry budget moves from the request to the host. One chapter of argument, and one of output the generator produced from it.",
          verdict: "ready",
        },
        overviewOpen: true,
      });
      break;
    }
    case "guide":
    case "guide-chapter": {
      // The guide over a change worth a guide: a flow on the front, a skeleton in the first
      // chapter, a group with parts, a skim chapter, and an outline with something in it. The
      // `-chapter` variant is the band above the diff for that first chapter.
      // `GUIDE_DEPS_PATCH` rides along so the Map card's Deps tab has a rewiring to draw.
      const files = parsePatch(OUTLINE_PATCH + GUIDE_DEPS_PATCH, "preview:guide");
      const layers = guideLayers();
      const chapter = state === "guide-chapter";
      seedSession({
        diff: { phase: "loaded", loadId: 1, files },
        selectedFilePath: files[0]?.path ?? null,
        layers,
        overview: guideOverview(),
        comments: [
          {
            id: "c0000000-0000-4000-8000-000000000900",
            file: "src/blob.ts",
            side: "additions",
            startLine: 5,
            endLine: 5,
            body: "`attempts` defaults to 3 here and to nothing in `sync.py` — say which one wins.",
            severity: "important",
          },
        ],
        ...(chapter ? { activeLayerId: "guide-retry" } : { overviewOpen: true }),
        ...readFixture(files, chapter ? [] : ["cmd/server.go"]),
        collapsedFiles: withCollapsed(NO_COLLAPSED_FILES, initialFolds(files, layers), true),
      });
      break;
    }
    case "artifact":
    case "artifact-chapter": {
      const injected = injectedArtifact();
      if (injected === null) {
        break;
      }
      let next = 0;
      const imported = importReview(injected.bytes, {
        newId: () => `c0000000-0000-4000-8000-${String((next += 1)).padStart(12, "0")}`,
      });
      if (!imported.ok) {
        console.error(imported.reason);
        break;
      }
      const files = parsePatch(injected.patch, "preview:artifact");
      const { review } = imported;
      const firstLayer = review.layers.find((layer) => layer.visual !== undefined) ?? null;
      seedSession({
        diff: { phase: "loaded", loadId: 1, files },
        selectedFilePath: files[0]?.path ?? null,
        layers: review.layers,
        overview: review.overview,
        comments: review.comments,
        ...(state === "artifact-chapter"
          ? { activeLayerId: firstLayer?.id ?? review.layers[0]?.id ?? null }
          : { overviewOpen: true }),
        collapsedFiles: withCollapsed(NO_COLLAPSED_FILES, initialFolds(files, review.layers), true),
      });
      break;
    }
    case "reading": {
      // Part-way through the walkthrough: the first chapter finished (its files folded away
      // in the code view), the second started. What the rail's rings, the band's control,
      // the tree's ticks and its status line all have to read correctly at once.
      const files = parsePatch(MULTI_STATUS_PATCH, "preview:reading");
      seedSession({
        diff: { phase: "loaded", loadId: 1, files },
        selectedFilePath: files[0]?.path ?? null,
        comments: fixtureComments(),
        layers: fixtureLayers(),
        ...readFixture(files, ["added.txt", "notes.txt"]),
      });
      break;
    }
    case "reading-overview": {
      // The same progress, seen from the hub: the headline's own tally, a ring per section,
      // ticks down the file lists, and a footer that offers the chapter to resume into
      // rather than the first one.
      const files = parsePatch(MULTI_STATUS_PATCH, "preview:reading-overview");
      seedSession({
        diff: { phase: "loaded", loadId: 1, files },
        selectedFilePath: files[0]?.path ?? null,
        comments: fixtureComments(),
        layers: fixtureLayers(),
        overview: fixtureOverview(),
        overviewOpen: true,
        ...readFixture(files, ["added.txt", "notes.txt"]),
      });
      break;
    }
    case "commits-many": {
      // The log at the cap `git log` is given (LOG_MAX_COUNT): what the picker's
      // virtualization is for, and the state to watch a drag-brush in.
      const entries: LogEntry[] = [{ kind: "uncommitted" }];
      for (let index = 0; index < 2000; index += 1) {
        const sha = index.toString(16).padStart(40, "0");
        entries.push({
          kind: "commit",
          commit: {
            sha,
            shortSha: sha.slice(0, 7),
            author: index % 3 === 0 ? "alex" : "mira",
            authoredAt: new Date(Date.now() - (index + 1) * HOUR_MS).toISOString(),
            subject: `${SUBJECTS[index % SUBJECTS.length]} (#${index})`,
          },
        });
      }
      seedSession({
        diff: { phase: "empty" },
        log: { phase: "loaded", entries },
        brush: { anchor: 0, focus: 0 },
      });
      break;
    }
    case "review-picker": {
      // A review session with its picker forced open (no diff to fall back to): the
      // review-scoped selector — the review's own commits, narrowed to two of them, and
      // no way out to another diff. Its endpoints are named by the bar above it.
      const source = {
        repo: { path: "/preview/fixture", name: "fixture" },
        base: "main",
        head: "feature/brush-selection",
      } as const;
      const entries = fixtureEntries();
      const first = entries[3];
      const last = entries[2];
      seedSession({
        diff: { phase: "empty" },
        selection: null,
        log: { phase: "loaded", entries },
        brush: { anchor: 2, focus: 3 },
        comments: fixtureComments(),
        layers: fixtureLayers(),
        reviewOrigin: { ...source, patch: null, reviewedHead: null, pr: null },
        reviewDiff: { kind: "refs", base: source.base, head: source.head },
        reviewSubrange:
          first !== undefined &&
          first.kind === "commit" &&
          last !== undefined &&
          last.kind === "commit"
            ? { kind: "commitRange", first: first.commit.sha, last: last.commit.sha }
            : null,
      });
      break;
    }
    case "layers-solo": {
      const files = parsePatch(MULTI_STATUS_PATCH, "preview:layers-solo");
      seedSession({
        diff: { phase: "loaded", loadId: 1, files },
        selectedFilePath: files[0]?.path ?? null,
        comments: fixtureComments(),
        layers: fixtureLayers(),
        activeLayerId: "layer-greeting",
      });
      break;
    }
    case "layers-outdated": {
      const files = parsePatch(MULTI_STATUS_PATCH, "preview:layers-outdated");
      seedSession({
        diff: { phase: "loaded", loadId: 1, files },
        selectedFilePath: files[0]?.path ?? null,
        comments: fixtureComments(),
        layers: fixtureLayers(),
        // The last layer's only range references a file the diff no longer carries,
        // so soloing it resolves to zero files — the dead-end empty state.
        activeLayerId: "layer-legacy",
      });
      break;
    }
    case "many": {
      const files = parsePatch(buildManyFilesPatch(24, 2000), "preview:many");
      seedSession({
        diff: { phase: "loaded", loadId: 1, files },
        selectedFilePath: files[0]?.path ?? null,
      });
      break;
    }
    case "huge": {
      const files = parsePatch(buildHugeAdditionPatch(100_000), "preview:huge");
      seedSession({
        diff: { phase: "loaded", loadId: 1, files },
        selectedFilePath: files[0]?.path ?? null,
      });
      break;
    }
    case "tabs": {
      const files = parsePatch(MULTI_STATUS_PATCH, "preview:tabs");
      seedSession({
        diff: { phase: "loaded", loadId: 1, files },
        selectedFilePath: files[0]?.path ?? null,
        // A review session, so the active tab is named by its title like the strip's others.
        overview: fixtureOverview(),
        reviewOrigin: {
          repo: { path: "/preview/fixture", name: "fixture" },
          base: "main",
          head: "feature/brush-selection",
          patch: null,
          reviewedHead: null,
          pr: null,
        },
        reviewDiff: { kind: "refs", base: "main", head: "feature/brush-selection" },
      });
      seedSiblingTabs(
        [{ name: "reviewer", title: "Name tabs after the review, not the repository" }],
        [{ name: "web-app" }],
      );
      break;
    }
    case "tabs-overflow": {
      const files = parsePatch(MULTI_STATUS_PATCH, "preview:tabs-overflow");
      seedSession({
        diff: { phase: "loaded", loadId: 1, files },
        selectedFilePath: files[0]?.path ?? null,
      });
      seedSiblingTabs(
        [
          { name: "reviewer", title: "Drop the env-var fallback from settings" },
          { name: "api-server", title: "Split the ingest worker in two" },
          { name: "very-long-repository-name" },
          // Two tabs whose reviews were given the same title, in the same project: the
          // qualifier has to fall through to the branch to tell them apart.
          { name: "dotfiles", title: "Move the shell config under XDG", head: "xdg" },
          { name: "dotfiles", title: "Move the shell config under XDG", head: "xdg-2" },
        ],
        [
          { name: "notes", title: "Retire the legacy exporter" },
          { name: "pierre-diffs" },
          { name: "electron-vite" },
          { name: "playground", title: "First pass at the parser" },
        ],
      );
      break;
    }
    case "open-failure": {
      const files = parsePatch(MULTI_STATUS_PATCH, "preview:open-failure");
      seedSession({
        diff: { phase: "loaded", loadId: 1, files },
        selectedFilePath: files[0]?.path ?? null,
      });
      seedSiblingTabs([{ name: "reviewer" }], []);
      useReviewStore.setState({
        openFailure: { code: "notARepo", path: "/Users/demo/Downloads/not-a-repo" },
      });
      break;
    }
    // The first-run guide, at each of its three stops and in the two states step two can be
    // found in. Outside Electron there is no bridge to answer "is rvw installed", so the
    // launcher status is seeded here — it is the one thing on the card the browser cannot
    // discover, and the step reads completely differently on either side of it.
    case "onboarding":
    case "onboarding-cli":
    case "onboarding-cli-installed":
    case "onboarding-prompt": {
      useReviewStore.setState({ boot: "ready", sessions: {}, tabs: [], activeSessionId: null });
      const installed = state === "onboarding-cli-installed";
      useOnboardingStore.setState({
        open: true,
        step: state === "onboarding" ? 0 : state === "onboarding-prompt" ? 2 : 1,
        cli: { supported: true, installed, path: "/usr/local/bin/rvw", shadowedBy: null },
      });
      break;
    }
    case "no-sessions": {
      // The start screen proper: the guide already run, nothing open, a machine with a
      // history of reviews behind it. The prompt at the top, the banded list under it, and
      // more reviews than the page shows — so the handoff to the picker is visible too.
      useReviewStore.setState({ boot: "ready", sessions: {}, tabs: [], activeSessionId: null });
      useOnboardingStore.setState({
        open: false,
        cli: { supported: true, installed: true, path: "/usr/local/bin/rvw", shadowedBy: null },
      });
      seedRecents(fixtureRecents(), 14);
      break;
    }
    case "start-first-run": {
      // The same screen on a machine that has never had a review on it: nothing to come
      // back to, so the list is the sentence that says so and the two other ways in.
      useReviewStore.setState({ boot: "ready", sessions: {}, tabs: [], activeSessionId: null });
      useOnboardingStore.setState({
        open: false,
        cli: { supported: true, installed: true, path: "/usr/local/bin/rvw", shadowedBy: null },
      });
      seedRecents([]);
      break;
    }
    case "start-tab": {
      // The start screen as a *tab*, opened over a review that stays open behind it: the
      // strip carries both kinds of tab, and the start tab is the selected one.
      const files = parsePatch(MULTI_STATUS_PATCH, "preview:start-tab");
      seedSession({
        diff: { phase: "loaded", loadId: 1, files },
        selectedFilePath: files[0]?.path ?? null,
        comments: fixtureComments(),
        layers: fixtureLayers(),
        overview: fixtureOverview(),
        reviewOrigin: {
          repo: { path: "/preview/fixture", name: "fixture" },
          base: "main",
          head: "feature/brush-selection",
          patch: null,
          reviewedHead: null,
          pr: null,
        },
        reviewDiff: { kind: "refs", base: "main", head: "feature/brush-selection" },
      });
      seedSiblingTabs(
        [{ name: "reviewer", title: "Drop the env-var fallback from settings" }],
        [{ name: "web-app" }],
      );
      useReviewStore.getState().openStartTab();
      useOnboardingStore.setState({
        open: false,
        cli: { supported: true, installed: true, path: "/usr/local/bin/rvw", shadowedBy: null },
      });
      seedRecents(fixtureRecents(), 14);
      break;
    }
    case "start-cli-missing": {
      // The standing "rvw is not installed" notice over the start screen. The one overlap the
      // document's top inset is sized for: the pill floats at `top-13`, and the screen's own
      // first line is the same conversation it is having.
      useReviewStore.setState({ boot: "ready", sessions: {}, tabs: [], activeSessionId: null });
      useOnboardingStore.setState({
        open: false,
        cli: { supported: true, installed: false, path: "/usr/local/bin/rvw", shadowedBy: null },
      });
      seedRecents(fixtureRecents(), 14);
      break;
    }
    case "cli-shadowed": {
      // Installed, and still unreachable: another launcher answers to `rvw` first.
      const files = parsePatch(MULTI_STATUS_PATCH, "preview:cli-shadowed");
      seedSession({
        diff: { phase: "loaded", loadId: 1, files },
        selectedFilePath: files[0]?.path ?? null,
      });
      useOnboardingStore.setState({
        open: false,
        cli: {
          supported: true,
          installed: true,
          path: "/usr/local/bin/rvw",
          shadowedBy: "~/.local/bin/rvw",
        },
      });
      break;
    }
    case "cli-banner": {
      // The standing notice over a working session: what it has to stay legible against,
      // and the one place the app's glass sits above the diff at the top of the window.
      const files = parsePatch(MULTI_STATUS_PATCH, "preview:cli-banner");
      seedSession({
        diff: { phase: "loaded", loadId: 1, files },
        selectedFilePath: files[0]?.path ?? null,
        comments: fixtureComments(),
      });
      useOnboardingStore.setState({
        open: false,
        cli: { supported: true, installed: false, path: "/usr/local/bin/rvw", shadowedBy: null },
      });
      break;
    }
    case "settings": {
      // The settings sheet over the start screen, for eyeballing a row's control. Two tokens
      // held — a fine-grained one for an organisation with an expiry, and a classic public_repo
      // one — so Settings ▸ GitHub shows both kinds of row.
      seedPullRequestDialog("not-found");
      usePullRequestStore.setState({ open: false });
      useGitHubStore.setState({
        status: {
          tokens: [
            {
              kind: "fineGrained",
              login: "you",
              owner: "acme",
              expiresAt: new Date(Date.now() + 40 * 24 * HOUR_MS).toISOString(),
            },
            { kind: "classic", login: "you", owner: null, expiresAt: null },
          ],
          exposedBy: [],
        },
      });
      useSettingsStore.getState().openDialog();
      break;
    }
    case "pr-dialog":
      seedPullRequestDialog("prepared");
      break;
    case "pr-dialog-not-found":
      seedPullRequestDialog("not-found");
      break;
    case "pr-dialog-failure":
      seedPullRequestDialog("failure");
      break;
    case "pr-dialog-busy":
      seedPullRequestDialog("busy");
      break;
    case "pr-dialog-inbox":
    case "pr-dialog-inbox-limited":
    case "pr-dialog-no-username": {
      // The dialog as it opens, before anything is pasted: the inbox under the address — its
      // rows; a spent search limit over the last rows it had; or, with no username in
      // Settings, the one-line pointer there. No bridge in the browser, so the store's own
      // refresh stands down and the seeded state is what shows.
      seedPullRequestDialog("not-found");
      if (state !== "pr-dialog-no-username") {
        void useSettingsStore.getState().update({ githubUsername: "you" });
      }
      usePullRequestStore.setState({
        input: "",
        target: null,
        checkout: { kind: "none" },
        info: { phase: "idle" },
        inbox:
          state === "pr-dialog-inbox-limited"
            ? {
                phase: "failed",
                login: "you",
                rows: fixtureInbox(),
                failure: {
                  code: "rateLimited",
                  resetAt: Date.now() + 7 * 60 * 1000,
                  scope: "anonymous",
                },
              }
            : { phase: "loaded", login: "you", rows: fixtureInbox(), fetchedAt: Date.now() },
      });
      break;
    }
    default:
      console.error(`Unknown preview state: ${state}`);
  }
}
