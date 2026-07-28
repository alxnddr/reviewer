import type { BranchList, LogEntry } from "../../../shared/git";
import type { Comment, ReviewLayer, ReviewOverview } from "../../../shared/review";
import {
  buildHugeAdditionPatch,
  buildManyFilesPatch,
  buildPathsPatch,
  MULTI_STATUS_PATCH,
} from "../lib/diff/fixtures";
import { parsePatch, type PatchFile } from "../lib/diff/patch";
import {
  markFilesRead,
  NO_COLLAPSED_FILES,
  NO_READ_FILES,
  withCollapsed,
} from "../lib/read-progress";
import { useOnboardingStore } from "../stores/onboarding";
import { useReviewStore, type SessionSlice } from "../stores/review";

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

/** Fixture comments over MULTI_STATUS_PATCH: two placed on covered lines (one
 * with an inline `code` ref, to show the sans/mono split) and one whose range
 * drifted off the diff, pinned outdated to its file header. */
function fixtureComments(): Comment[] {
  return [
    {
      file: "greet.ts",
      side: "additions",
      startLine: 4,
      endLine: 6,
      body: "Extract this into a `formatGreeting` helper — `shout` and `greet` will both want it.",
      id: "c0000000-0000-4000-8000-000000000001",
    },
    {
      file: "added.txt",
      side: "additions",
      startLine: 1,
      endLine: 1,
      body: "Give this file a header comment so its purpose is obvious.",
      id: "c0000000-0000-4000-8000-000000000002",
    },
    {
      file: "greet.ts",
      side: "additions",
      startLine: 80,
      endLine: 82,
      body: "This block moved since the review was written — check it still holds.",
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
      "`bodyPreview` folds every run of whitespace, so a body that opens with a fenced block loses the fence and reads as prose. Worth keeping the first line only.",
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
        "This layer introduces the public greeting surface. `greet.ts` gains a `shout()` helper that composes over the existing `greet()`, so the two share one formatting path rather than drifting apart.\n\nThe fixture file [added.txt](added.txt) ships alongside as the smoke test — open it to confirm the new entry point reads cleanly. Callers still reach the API through `greet.ts`; nothing downstream changes shape.",
      ranges: [
        { file: "greet.ts", side: "additions", startLine: 4, endLine: 6 },
        { file: "added.txt", side: "additions", startLine: 1, endLine: 2 },
      ],
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
    body: [
      "The greeting API grows a second entry point. `greet.ts` keeps its existing `greet()` and gains `shout()` on top of it, so both share **one formatting path** instead of drifting apart as callers pick sides.",
      "Everything else in the range is bookkeeping: [notes.txt](notes.txt) gets a copy pass, `added.txt` lands as the smoke test for the new entry point, and a dead file goes away. Read the greeting layer first — the rest only makes sense once the shape of the API is in your head.",
      "## Reading order",
      "- `greet.ts` first — the API is the argument of the change\n- [notes.txt](notes.txt) after, *only* if you own the docs\n- the deletion last; it explains itself",
      "> The fixture prose deliberately walks every block the grammar renders, so the doc is its own preview.",
      "```ts\nexport function shout(name: string): string {\n  return `${greet(name).toUpperCase()}!`;\n}\n```",
    ].join("\n\n"),
  };
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

/** A derived sibling slice for the tab-strip states; id must be a unique uuid. */
function siblingSlice(ordinal: number, name: string): SessionSlice {
  const digit = (ordinal % 10).toString();
  return {
    id: `${digit.repeat(8)}-${digit.repeat(4)}-4000-8000-${digit.repeat(12)}`,
    repo: { path: `/preview/${name}`, name },
    log: null,
    branches: null,
    brush: null,
    base: null,
    head: null,
    selection: null,
    diff: { phase: "idle" },
    selectedFilePath: null,
    scrollTop: 0,
    commitSelection: null,
    comments: [],
    layers: [],
    reviewDiff: null,
    reviewSubrange: null,
    reviewOrigin: null,
    overview: null,
    overviewOpen: false,
    lastChapterId: null,
    activeLayerId: null,
    activeCommentId: null,
    readFiles: NO_READ_FILES,
    collapsedFiles: NO_COLLAPSED_FILES,
    needsDerive: true,
    requestTicket: 0,
  };
}

/** Adds inactive sibling tabs around whatever state already seeded the active
 * session — key insertion order is tab order, so `before`/`after` place them. */
function seedSiblingTabs(before: string[], after: string[]): void {
  const state = useReviewStore.getState();
  const sessions: Record<string, SessionSlice> = {};
  for (const [index, name] of before.entries()) {
    const sibling = siblingSlice(index + 1, name);
    sessions[sibling.id] = sibling;
  }
  Object.assign(sessions, state.sessions);
  for (const [index, name] of after.entries()) {
    const sibling = siblingSlice(before.length + index + 1, name);
    sessions[sibling.id] = sibling;
  }
  useReviewStore.setState({ sessions });
}

/** Boots the store as if one hydrated, derived session were active. */
function seedSession(overrides: Partial<SessionSlice>): void {
  const slice: SessionSlice = {
    id: FIXTURE_SESSION_ID,
    repo: { path: "/preview/fixture", name: "fixture" },
    log: { phase: "loaded", entries: fixtureEntries() },
    branches: { phase: "loaded", list: FIXTURE_BRANCHES },
    brush: { anchor: 0, focus: 0 },
    // A fresh session lists the branch it is standing on and compares to nothing; the
    // states that show a comparison set `base` themselves.
    base: null,
    head: FIXTURE_BRANCHES.currentBranch,
    selection: { kind: "uncommitted" },
    diff: { phase: "empty" },
    selectedFilePath: null,
    scrollTop: 0,
    commitSelection: { kind: "uncommitted" },
    comments: [],
    layers: [],
    reviewDiff: null,
    reviewSubrange: null,
    reviewOrigin: null,
    overview: null,
    overviewOpen: false,
    lastChapterId: null,
    activeLayerId: null,
    activeCommentId: null,
    readFiles: NO_READ_FILES,
    collapsedFiles: NO_COLLAPSED_FILES,
    needsDerive: false,
    requestTicket: 1,
    ...overrides,
  };
  useReviewStore.setState({
    boot: "ready",
    sessions: { [slice.id]: slice },
    activeSessionId: slice.id,
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
        lastChapterId: null,
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
        reviewOrigin: { ...source, patch: null },
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
      });
      seedSiblingTabs(["reviewer"], ["web-app"]);
      break;
    }
    case "tabs-overflow": {
      const files = parsePatch(MULTI_STATUS_PATCH, "preview:tabs-overflow");
      seedSession({
        diff: { phase: "loaded", loadId: 1, files },
        selectedFilePath: files[0]?.path ?? null,
      });
      seedSiblingTabs(
        ["reviewer", "api-server", "very-long-repository-name", "dotfiles"],
        ["notes", "pierre-diffs", "electron-vite", "playground"],
      );
      break;
    }
    case "open-failure": {
      const files = parsePatch(MULTI_STATUS_PATCH, "preview:open-failure");
      seedSession({
        diff: { phase: "loaded", loadId: 1, files },
        selectedFilePath: files[0]?.path ?? null,
      });
      seedSiblingTabs(["reviewer"], []);
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
      useReviewStore.setState({ boot: "ready", sessions: {}, activeSessionId: null });
      const installed = state === "onboarding-cli-installed";
      useOnboardingStore.setState({
        open: true,
        step: state === "onboarding" ? 0 : state === "onboarding-prompt" ? 2 : 1,
        cli: { supported: true, installed, path: "/usr/local/bin/rvw", shadowedBy: null },
      });
      break;
    }
    case "no-sessions": {
      // The empty state proper: the guide already run, nothing open. Same card, same
      // backdrop, inside the content pane rather than over the whole window.
      useReviewStore.setState({ boot: "ready", sessions: {}, activeSessionId: null });
      useOnboardingStore.setState({
        open: false,
        cli: { supported: true, installed: true, path: "/usr/local/bin/rvw", shadowedBy: null },
      });
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
    default:
      console.error(`Unknown preview state: ${state}`);
  }
}
