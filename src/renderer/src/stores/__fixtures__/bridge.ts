import { vi } from "vitest";
import { MULTI_STATUS_PATCH } from "../../../../shared/diff/fixtures";
import type { BranchList, LogEntry } from "../../../../shared/git";
import type { ReviewerBridge } from "../../../../shared/ipc";
import { NO_PROGRESS } from "../../../../shared/review-progress";
import type { Session } from "../../../../shared/session";

// The preload bridge, stubbed whole, for the store suites — every one of them runs against a
// `window.reviewer` and none of them runs against Electron. It lives here rather than in one
// test file because all three store suites need the same thing and only the *answers* differ:
// a suite overrides the two or three members it is about, and inherits a plausible reply for
// everything else. Adding a bridge method is then one edit here rather than one per suite.
//
// Every member is a `vi.fn()`, so a test can assert on any of them without arranging for it
// first, and the canned answers below are the ones the assertions in those suites are written
// against — which is why the values they are made of are exported alongside.

/** The id `createSession` hands back, so a test can name the session it just opened. */
export const SESSION_ID = "11111111-1111-4111-8111-111111111111";

export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);

export function commitEntry(sha: string): LogEntry {
  return {
    kind: "commit",
    commit: {
      sha,
      shortSha: sha.slice(0, 7),
      author: "t",
      authoredAt: "2026-07-04T00:00:00+00:00",
      subject: "subject",
    },
  };
}

/** A dirty working tree over two commits — the log `getCommitLog` answers with, and the
 * reason a freshly opened repo brushes the uncommitted row. */
export const DIRTY_ENTRIES: LogEntry[] = [
  { kind: "uncommitted" },
  commitEntry(SHA_A),
  commitEntry(SHA_B),
];

export const BRANCH_LIST: BranchList = {
  branches: ["main", "feature/x"],
  defaultBranch: "main",
  currentBranch: "feature/x",
};

/** A whole bridge, with `overrides` winning over the canned answers. */
export function makeBridge(overrides: Partial<ReviewerBridge> = {}): ReviewerBridge {
  return {
    getThemeSelection: vi.fn(),
    setThemeSelection: vi.fn(),
    getCliStatus: vi.fn().mockResolvedValue({
      supported: true,
      installed: true,
      path: "/usr/local/bin/rvw",
      shadowedBy: null,
    }),
    installCli: vi.fn().mockResolvedValue({
      status: {
        supported: true,
        installed: true,
        path: "/usr/local/bin/rvw",
        shadowedBy: null,
      },
      problem: null,
    }),
    getOnboarded: vi.fn().mockResolvedValue(true),
    completeOnboarding: vi.fn(),
    openRepo: vi.fn().mockResolvedValue({
      ok: true,
      value: { kind: "opened", repo: { path: "/repo", name: "repo" } },
    }),
    openReview: vi.fn().mockResolvedValue({ ok: true, value: { kind: "canceled" } }),
    openReviewByPath: vi.fn().mockResolvedValue({ ok: true, value: { kind: "canceled" } }),
    listRecentReviews: vi.fn().mockResolvedValue({
      dir: "/home/dev/.rvw/reviews",
      reviews: [],
      truncated: 0,
      unreadable: false,
    }),
    saveReviewJson: vi.fn().mockResolvedValue({ ok: true, value: { kind: "canceled" } }),
    saveReviewMarkdown: vi.fn().mockResolvedValue({ ok: true, value: { kind: "canceled" } }),
    getPathForFile: vi.fn().mockReturnValue(null),
    listBranches: vi.fn().mockResolvedValue({ ok: true, value: BRANCH_LIST }),
    getCommitLog: vi.fn().mockResolvedValue({ ok: true, value: { entries: DIRTY_ENTRIES } }),
    getDiff: vi.fn().mockResolvedValue({ ok: true, value: { patch: MULTI_STATUS_PATCH } }),
    getFileContents: vi.fn().mockResolvedValue({ ok: true, value: { kind: "absent" } }),
    listSessions: vi.fn().mockResolvedValue({ sessions: [], activeSessionId: null }),
    createSession: vi.fn().mockImplementation((request: { source: Session["source"] }) =>
      Promise.resolve({
        id: SESSION_ID,
        source: request.source,
        base: null,
        head: null,
        commitSelection: null,
        selectedFilePath: null,
        scrollTop: 0,
        comments: [],
        layers: [],
        overview: null,
        reviewDiff: null,
        reviewSubrange: null,
        reviewOrigin: null,
        reviewPath: null,
        ...NO_PROGRESS,
      } satisfies Session),
    ),
    updateSession: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    setActiveSession: vi.fn().mockResolvedValue(undefined),
    reorderSessions: vi.fn().mockResolvedValue(undefined),
    onOpenRepoCommand: vi.fn().mockReturnValue(() => {}),
    onOpenReviewCommand: vi.fn().mockReturnValue(() => {}),
    onOpenRecentReviewsCommand: vi.fn().mockReturnValue(() => {}),
    onExportReviewJsonCommand: vi.fn().mockReturnValue(() => {}),
    onExportReviewMarkdownCommand: vi.fn().mockReturnValue(() => {}),
    onCopyCommentPromptCommand: vi.fn().mockReturnValue(() => {}),
    onCopyAllCommentsPromptCommand: vi.fn().mockReturnValue(() => {}),
    onSessionsChanged: vi.fn().mockReturnValue(() => {}),
    onNewTabCommand: vi.fn().mockReturnValue(() => {}),
    onCloseTabCommand: vi.fn().mockReturnValue(() => {}),
    onCycleTabCommand: vi.fn().mockReturnValue(() => {}),
    onActivateTabCommand: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
}

/** The same bridge, installed on a stubbed `window` — the arrangement every store action
 * needs, since they all read `window.reviewer` at the moment they run. `vi.unstubAllGlobals`
 * takes it back down. */
export function stubBridge(overrides: Partial<ReviewerBridge> = {}): ReviewerBridge {
  const bridge = makeBridge(overrides);
  vi.stubGlobal("window", { reviewer: bridge });
  return bridge;
}
