import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchList, BranchName, DiffResponse, LogEntry } from "../../../shared/git";
import type { ReviewerBridge } from "../../../shared/ipc";
import type { Session, SessionSnapshot } from "../../../shared/session";
import {
  importReview,
  reviewOriginFor,
  ReviewArtifact,
  type Comment,
  type ImportedReview,
  type ReviewLayer,
  type ReviewOrigin,
  type ReviewOverview,
  type ReviewStamp,
} from "../../../shared/review";
import { buildCommentItems, type CommentSlot } from "../lib/diff/comment-annotations";
import { MULTI_STATUS_PATCH } from "../lib/diff/fixtures";
import { parsePatch } from "../lib/diff/patch";
import { NO_COLLAPSED_FILES, NO_READ_FILES } from "../lib/read-progress";
import { resolveLayerScroll, stepLayer } from "../lib/layers";
import { UNCOVERED_LAYER_ID } from "../lib/coverage";
import { createScrollCapture, SCROLL_CAPTURE_DEBOUNCE_MS } from "../lib/scroll";
import { useReviewStore, WRITE_BACK_DEBOUNCE_MS, type SessionSlice } from "./review";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ID_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function commitEntry(sha: string): LogEntry {
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

const DIRTY_ENTRIES: LogEntry[] = [{ kind: "uncommitted" }, commitEntry(SHA_A), commitEntry(SHA_B)];

const BRANCH_LIST: BranchList = {
  branches: ["main", "feature/x"],
  defaultBranch: "main",
  currentBranch: "feature/x",
};

function makeBridge(overrides: Partial<ReviewerBridge>): ReviewerBridge {
  return {
    getThemeSelection: vi.fn(),
    setThemeSelection: vi.fn(),
    openRepo: vi.fn().mockResolvedValue({
      ok: true,
      value: { kind: "opened", repo: { path: "/repo", name: "repo" } },
    }),
    openReview: vi.fn().mockResolvedValue({ ok: true, value: { kind: "canceled" } }),
    openReviewByPath: vi.fn().mockResolvedValue({ ok: true, value: { kind: "canceled" } }),
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
        mode: "commits",
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
      } satisfies Session),
    ),
    updateSession: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    setActiveSession: vi.fn().mockResolvedValue(undefined),
    reorderSessions: vi.fn().mockResolvedValue(undefined),
    onOpenRepoCommand: vi.fn().mockReturnValue(() => {}),
    onOpenReviewCommand: vi.fn().mockReturnValue(() => {}),
    onExportReviewJsonCommand: vi.fn().mockReturnValue(() => {}),
    onExportReviewMarkdownCommand: vi.fn().mockReturnValue(() => {}),
    onSessionsChanged: vi.fn().mockReturnValue(() => {}),
    onCloseTabCommand: vi.fn().mockReturnValue(() => {}),
    onCycleTabCommand: vi.fn().mockReturnValue(() => {}),
    onActivateTabCommand: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
}

function resetStore(): void {
  useReviewStore.setState({
    boot: "ready",
    sessions: {},
    activeSessionId: null,
    openFailure: null,
    reviewOpenFailure: null,
    reviewExportFailure: null,
    diffStyle: "split",
  });
}

function active(): SessionSlice {
  const state = useReviewStore.getState();
  if (state.activeSessionId === null) {
    throw new Error("no active session");
  }
  const slice = state.sessions[state.activeSessionId];
  if (slice === undefined) {
    throw new Error("active session id names no slice");
  }
  return slice;
}

function slice(id: string): SessionSlice {
  const found = useReviewStore.getState().sessions[id];
  if (found === undefined) {
    throw new Error(`no slice for ${id}`);
  }
  return found;
}

function patchActive(partial: Partial<SessionSlice>): void {
  const state = useReviewStore.getState();
  const current = active();
  useReviewStore.setState({
    sessions: { ...state.sessions, [current.id]: { ...current, ...partial } },
  });
}

async function openFixtureRepo(bridge: ReviewerBridge): Promise<void> {
  vi.stubGlobal("window", { reviewer: bridge });
  await useReviewStore.getState().openRepository();
}

function storedSession(id: string, repoPath: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    source: { kind: "local", repo: { path: repoPath, name: repoPath.slice(1) } },
    mode: "commits",
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
    ...overrides,
  };
}

/** A refs review session: the pin and the authored origin are always paired
 * (createFromReview sets both), so `reviewOrigin` — the review-session marker — is
 * never absent when `reviewDiff` is present. */
function refsReviewSession(id: string, repoPath: string, base: string, head: string): Session {
  return storedSession(id, repoPath, {
    reviewDiff: { kind: "refs", base, head },
    reviewOrigin: {
      source: { kind: "local", repo: { path: repoPath, name: repoPath.slice(1) }, base, head },
      patch: null,
    },
  });
}

/** A frozen review session: its embedded patch is both the pin and the origin's
 * frozen patch, so the diff renders off git and the endpoints stay read-only. */
function frozenReviewSession(id: string, repoPath: string, patch: string): Session {
  return storedSession(id, repoPath, {
    reviewDiff: { kind: "frozenPatch", patch },
    reviewOrigin: {
      source: {
        kind: "local",
        repo: { path: repoPath, name: repoPath.slice(1) },
        base: "main",
        head: SHA_A,
      },
      patch,
    },
  });
}

async function hydrateWith(bridge: ReviewerBridge, snapshot: SessionSnapshot): Promise<void> {
  vi.mocked(bridge.listSessions).mockResolvedValue(snapshot);
  vi.stubGlobal("window", { reviewer: bridge });
  useReviewStore.setState({ boot: "pending" });
  await useReviewStore.getState().hydrate();
}

function totalBridgeCalls(bridge: ReviewerBridge): number {
  return Object.values(bridge).reduce(
    (sum, member) => sum + (vi.isMockFunction(member) ? member.mock.calls.length : 0),
    0,
  );
}

beforeEach(resetStore);
afterEach(() => {
  // Pending debounce timers must not fire into a later test: flush them against
  // this test's bridge (or into the void) before the window stub goes away.
  if (typeof window === "undefined") {
    vi.stubGlobal("window", {});
  }
  useReviewStore.getState().flushWriteBacks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useReviewStore.openRepository", () => {
  it("loads log and branches, brushes the newest entry, and renders its diff", async () => {
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);

    const state = active();
    expect(state.repo).toEqual({ path: "/repo", name: "repo" });
    expect(state.mode).toBe("commits");
    expect(state.log).toEqual({ phase: "loaded", entries: DIRTY_ENTRIES });
    expect(state.branches).toEqual({ phase: "loaded", list: BRANCH_LIST });
    expect(state.brush).toEqual({ anchor: 0, focus: 0 });
    expect(state.selection).toEqual({ kind: "uncommitted" });
    expect(state.diff.phase).toBe("loaded");
    if (state.diff.phase === "loaded") {
      expect(state.diff.files.map((file) => file.path)).toEqual(
        parsePatch(MULTI_STATUS_PATCH, "test").map((file) => file.path),
      );
    }
    expect(state.selectedFilePath).toBe("added.txt");
    expect(bridge.getDiff).toHaveBeenCalledWith({
      repoPath: "/repo",
      selection: { kind: "uncommitted" },
    });
  });

  it("creates the session in main and activates it", async () => {
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);

    expect(bridge.createSession).toHaveBeenCalledWith({
      source: { kind: "local", repo: { path: "/repo", name: "repo" } },
    });
    expect(useReviewStore.getState().activeSessionId).toBe(SESSION_ID);
  });

  it("preselects base = default branch and head = current branch", async () => {
    await openFixtureRepo(makeBridge({}));

    expect(active().base).toBe("main");
    expect(active().head).toBe("feature/x");
  });

  it("stays session-less when the dialog is canceled", async () => {
    await openFixtureRepo(
      makeBridge({
        openRepo: vi.fn().mockResolvedValue({ ok: true, value: { kind: "canceled" } }),
      }),
    );

    expect(useReviewStore.getState().sessions).toEqual({});
    expect(useReviewStore.getState().activeSessionId).toBeNull();
  });

  it("surfaces a failed log as a typed failure in the diff pane, never a crash", async () => {
    await openFixtureRepo(
      makeBridge({
        getCommitLog: vi
          .fn()
          .mockResolvedValue({ ok: false, failure: { code: "notARepo", path: "/repo" } }),
      }),
    );

    const state = active();
    expect(state.log).toEqual({ phase: "failed", failure: { code: "notARepo", path: "/repo" } });
    expect(state.diff).toEqual({
      phase: "failed",
      failure: { code: "notARepo", path: "/repo" },
    });
  });

  it("keeps commits mode working when only the branch listing fails", async () => {
    const bridge = makeBridge({
      listBranches: vi.fn().mockResolvedValue({ ok: false, failure: { code: "timeout" } }),
    });
    await openFixtureRepo(bridge);

    const state = active();
    expect(state.branches).toEqual({ phase: "failed", failure: { code: "timeout" } });
    expect(state.diff.phase).toBe("loaded");
  });

  it("shows empty, not a selection, for a repo with no commits and a clean tree", async () => {
    await openFixtureRepo(
      makeBridge({
        getCommitLog: vi.fn().mockResolvedValue({ ok: true, value: { entries: [] } }),
      }),
    );

    const state = active();
    expect(state.brush).toBeNull();
    expect(state.selection).toBeNull();
    expect(state.diff.phase).toBe("empty");
  });

  it("reports a failed open on the empty state when no session exists", async () => {
    await openFixtureRepo(
      makeBridge({
        openRepo: vi.fn().mockResolvedValue({ ok: false, failure: { code: "gitMissing" } }),
      }),
    );

    expect(useReviewStore.getState().sessions).toEqual({});
    expect(useReviewStore.getState().openFailure).toEqual({ code: "gitMissing" });
  });

  it("a failed open with a session active stays app-level and leaves the slice untouched", async () => {
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);
    const before = active();

    vi.mocked(bridge.openRepo).mockResolvedValue({
      ok: false,
      failure: { code: "notARepo", path: "/picked" },
    });
    await useReviewStore.getState().openRepository();

    expect(useReviewStore.getState().openFailure).toEqual({ code: "notARepo", path: "/picked" });
    expect(active()).toBe(before);
  });

  it("does nothing without the bridge (browser gate run)", async () => {
    vi.stubGlobal("window", {});

    await useReviewStore.getState().openRepository();

    expect(useReviewStore.getState().sessions).toEqual({});
  });

  it("a canceled second open does not strand the first open's in-flight fetches", async () => {
    let resolveLog: (value: unknown) => void = () => {};
    const bridge = makeBridge({
      getCommitLog: vi.fn().mockReturnValue(
        new Promise((resolve) => {
          resolveLog = resolve;
        }),
      ),
    });
    vi.stubGlobal("window", { reviewer: bridge });
    const first = useReviewStore.getState().openRepository();

    vi.mocked(bridge.openRepo).mockResolvedValue({ ok: true, value: { kind: "canceled" } });
    await useReviewStore.getState().openRepository();

    resolveLog({ ok: true, value: { entries: DIRTY_ENTRIES } });
    await first;

    expect(active().diff.phase).toBe("loaded");
  });
});

describe("brush selection driving the diff", () => {
  it("extending the brush requests the commitRangeWithUncommitted span", async () => {
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);

    useReviewStore.getState().applyBrush({ type: "extend", index: 1 });
    await vi.waitFor(() => {
      expect(active().diff.phase).toBe("loaded");
    });

    expect(active().selection).toEqual({
      kind: "commitRangeWithUncommitted",
      first: SHA_A,
    });
    expect(bridge.getDiff).toHaveBeenLastCalledWith({
      repoPath: "/repo",
      selection: { kind: "commitRangeWithUncommitted", first: SHA_A },
    });
  });

  it("a commit-only span maps to commitRange first=oldest last=newest", async () => {
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);

    useReviewStore.getState().applyBrush({ type: "set", index: 1 });
    useReviewStore.getState().applyBrush({ type: "extend", index: 2 });
    await vi.waitFor(() => {
      expect(active().selection).toEqual({
        kind: "commitRange",
        first: SHA_B,
        last: SHA_A,
      });
    });
  });

  it("previewBrush moves the range without loading; commitBrush loads it", async () => {
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);
    const callsAfterOpen = vi.mocked(bridge.getDiff).mock.calls.length;

    useReviewStore.getState().previewBrush({ type: "extend", index: 2 });
    expect(active().brush).toEqual({ anchor: 0, focus: 2 });
    expect(vi.mocked(bridge.getDiff).mock.calls.length).toBe(callsAfterOpen);

    useReviewStore.getState().commitBrush();
    await vi.waitFor(() => {
      expect(vi.mocked(bridge.getDiff).mock.calls.length).toBe(callsAfterOpen + 1);
    });
  });

  it("re-selecting the already-loaded range does not refetch", async () => {
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);
    const callsAfterOpen = vi.mocked(bridge.getDiff).mock.calls.length;

    useReviewStore.getState().applyBrush({ type: "set", index: 0 });
    await Promise.resolve();

    expect(vi.mocked(bridge.getDiff).mock.calls.length).toBe(callsAfterOpen);
  });

  it("a vanished repo surfaces as a typed failure on the next selection", async () => {
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);
    vi.mocked(bridge.getDiff).mockResolvedValue({
      ok: false,
      failure: { code: "notARepo", path: "/repo" },
    });

    useReviewStore.getState().applyBrush({ type: "extend", index: 1 });
    await vi.waitFor(() => {
      expect(active().diff).toEqual({
        phase: "failed",
        failure: { code: "notARepo", path: "/repo" },
      });
    });
  });

  it("a deleted ref surfaces as a typed failure, never a crash", async () => {
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);
    vi.mocked(bridge.getDiff).mockResolvedValue({
      ok: false,
      failure: { code: "unknownRevision" },
    });

    useReviewStore.getState().applyBrush({ type: "extend", index: 2 });
    await vi.waitFor(() => {
      expect(active().diff).toEqual({
        phase: "failed",
        failure: { code: "unknownRevision" },
      });
    });
  });
});

describe("branch mode driving the diff", () => {
  it("switching modes requests base...head for the preselected pair", async () => {
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);

    useReviewStore.getState().setMode("branches");
    await vi.waitFor(() => {
      expect(active().selection).toEqual({
        kind: "branches",
        base: "main",
        head: "feature/x",
      });
    });
    expect(bridge.getDiff).toHaveBeenLastCalledWith({
      repoPath: "/repo",
      selection: { kind: "branches", base: "main", head: "feature/x" },
    });
  });

  it("swap exchanges base and head and reloads", async () => {
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);
    useReviewStore.getState().setMode("branches");
    await vi.waitFor(() => {
      expect(active().diff.phase).toBe("loaded");
    });

    useReviewStore.getState().swapBranches();
    await vi.waitFor(() => {
      expect(active().selection).toEqual({
        kind: "branches",
        base: "feature/x",
        head: "main",
      });
    });
  });

  it("an identical pair with no delta reads as empty, not an error", async () => {
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);
    vi.mocked(bridge.getDiff).mockResolvedValue({ ok: true, value: { patch: "" } });

    useReviewStore.getState().setMode("branches");
    await vi.waitFor(() => {
      expect(active().diff.phase).toBe("empty");
    });
  });

  it("switching to branch mode after a failed branch listing shows that failure", async () => {
    const bridge = makeBridge({
      listBranches: vi.fn().mockResolvedValue({ ok: false, failure: { code: "timeout" } }),
    });
    await openFixtureRepo(bridge);

    useReviewStore.getState().setMode("branches");
    await vi.waitFor(() => {
      expect(active().diff).toEqual({
        phase: "failed",
        failure: { code: "timeout" },
      });
    });
  });
});

describe("review-pinned diff", () => {
  it("reproduces a refs-pinned review's authored base..head, off the branch pickers", async () => {
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [refsReviewSession(ID_A, "/repo-a", "main", SHA_A)],
      activeSessionId: ID_A,
    });

    await vi.waitFor(() => {
      expect(slice(ID_A).diff.phase).toBe("loaded");
    });
    // The pinned refs drive the diff request as a reviewRefs selection — the branch
    // pickers stay at their seeded defaults, never carrying the review's sha.
    expect(bridge.getDiff).toHaveBeenCalledWith({
      repoPath: "/repo-a",
      selection: { kind: "reviewRefs", base: "main", head: SHA_A },
    });
    expect(slice(ID_A).selection).toEqual({ kind: "reviewRefs", base: "main", head: SHA_A });
    expect(slice(ID_A).base).toBe("main");
    expect(slice(ID_A).commitSelection).toBeNull();
    expect(slice(ID_A).reviewSubrange).toBeNull();
    // The commit list is the review's own base..head range, not HEAD's history.
    expect(bridge.getCommitLog).toHaveBeenCalledWith({
      repoPath: "/repo-a",
      range: { base: "main", head: SHA_A },
    });
  });

  it("renders a frozen embedded patch directly, never round-tripping through git:diff", async () => {
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [frozenReviewSession(ID_A, "/repo-a", MULTI_STATUS_PATCH)],
      activeSessionId: ID_A,
    });

    await vi.waitFor(() => {
      expect(slice(ID_A).diff.phase).toBe("loaded");
    });
    const expected = parsePatch(MULTI_STATUS_PATCH, "x");
    const loaded = slice(ID_A).diff;
    expect(loaded.phase === "loaded" && loaded.files.map((file) => file.path)).toEqual(
      expected.map((file) => file.path),
    );
    // Frozen renders off git entirely: no diff selection, and getDiff is never hit.
    expect(slice(ID_A).selection).toBeNull();
    expect(slice(ID_A).reviewDiff).toEqual({ kind: "frozenPatch", patch: MULTI_STATUS_PATCH });
    expect(bridge.getDiff).not.toHaveBeenCalled();
  });

  it("lands a non-empty but unparseable frozen patch in the visible unreadable state", async () => {
    // A tampered/garbage embedded patch parses to zero files while carrying bytes;
    // that must surface as the typed `unreadable` phase (DiffScreen shows "Diff
    // unavailable"), never a blank `loaded` diff or a crash.
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [frozenReviewSession(ID_A, "/repo-a", "not a patch at all")],
      activeSessionId: ID_A,
    });

    await vi.waitFor(() => {
      expect(slice(ID_A).diff.phase).toBe("unreadable");
    });
    expect(bridge.getDiff).not.toHaveBeenCalled();
  });

  it("narrows to a subset of the review's commits, keeping the pin, then resets to the full review", async () => {
    // A review session stays scoped to its review: brushing a subset re-derives the
    // diff of just those commits while the pin persists, so resetting returns to the
    // exact authored diff (never a jump to some other branch/commit).
    const reviewEntries: LogEntry[] = [commitEntry(SHA_A), commitEntry(SHA_B)];
    const bridge = makeBridge({
      getCommitLog: vi.fn().mockResolvedValue({ ok: true, value: { entries: reviewEntries } }),
    });
    await hydrateWith(bridge, {
      sessions: [refsReviewSession(ID_A, "/repo-a", "main", SHA_A)],
      activeSessionId: ID_A,
    });
    await vi.waitFor(() => {
      expect(slice(ID_A).diff.phase).toBe("loaded");
    });
    // Full review by default: the pin drives, no subrange, and the whole range brushed.
    expect(slice(ID_A).reviewSubrange).toBeNull();
    expect(slice(ID_A).brush).toEqual({ anchor: 0, focus: 1 });

    // Narrow to the newest commit alone.
    useReviewStore.getState().applyBrush({ type: "set", index: 0 });
    await vi.waitFor(() => {
      expect(slice(ID_A).selection).toEqual({ kind: "commitRange", first: SHA_A, last: SHA_A });
    });
    // The pin is kept — narrowing never leaves the review — and the subrange persists.
    expect(slice(ID_A).reviewDiff).toEqual({ kind: "refs", base: "main", head: SHA_A });
    expect(slice(ID_A).reviewSubrange).toEqual({ kind: "commitRange", first: SHA_A, last: SHA_A });
    expect(slice(ID_A).commitSelection).toBeNull();

    // Reset returns to the whole review: no subrange, the diff back on the pinned refs.
    useReviewStore.getState().resetReviewSubrange();
    await vi.waitFor(() => {
      expect(slice(ID_A).selection).toEqual({ kind: "reviewRefs", base: "main", head: SHA_A });
    });
    expect(slice(ID_A).reviewSubrange).toBeNull();
    expect(slice(ID_A).brush).toEqual({ anchor: 0, focus: 1 });
  });
});

describe("useReviewStore.selectAdjacentFile", () => {
  beforeEach(() => {
    const files = parsePatch(MULTI_STATUS_PATCH, "test");
    const seeded: SessionSlice = {
      id: SESSION_ID,
      repo: { path: "/repo", name: "repo" },
      mode: "commits",
      log: null,
      branches: null,
      brush: null,
      base: null,
      head: null,
      selection: null,
      diff: { phase: "loaded", loadId: 1, files },
      selectedFilePath: files[0]?.path ?? null,
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
      needsDerive: false,
      requestTicket: 1,
    };
    useReviewStore.setState({
      boot: "ready",
      sessions: { [SESSION_ID]: seeded },
      activeSessionId: SESSION_ID,
    });
  });

  it("steps forward and back through the changed files", () => {
    useReviewStore.getState().selectAdjacentFile(1);
    expect(active().selectedFilePath).toBe("doomed.txt");
    useReviewStore.getState().selectAdjacentFile(-1);
    expect(active().selectedFilePath).toBe("added.txt");
  });

  it("clamps at both ends", () => {
    useReviewStore.getState().selectAdjacentFile(-1);
    expect(active().selectedFilePath).toBe("added.txt");
    patchActive({ selectedFilePath: "notes.txt" });
    useReviewStore.getState().selectAdjacentFile(1);
    expect(active().selectedFilePath).toBe("notes.txt");
  });

  it("ignores navigation while no diff is loaded", () => {
    patchActive({ diff: { phase: "loading" }, selectedFilePath: null });
    useReviewStore.getState().selectAdjacentFile(1);
    expect(active().selectedFilePath).toBeNull();
  });
});

describe("session hydration", () => {
  it("derives the active session only; a second session derives once on first activation", async () => {
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [
        storedSession(ID_A, "/repo-a"),
        storedSession(ID_B, "/repo-b"),
        storedSession(ID_C, "/repo-c"),
      ],
      activeSessionId: ID_B,
    });

    expect(useReviewStore.getState().boot).toBe("ready");
    expect(bridge.getCommitLog).toHaveBeenCalledTimes(1);
    expect(bridge.getCommitLog).toHaveBeenCalledWith({ repoPath: "/repo-b", range: null });
    expect(bridge.listBranches).toHaveBeenCalledTimes(1);
    expect(bridge.getDiff).toHaveBeenCalledTimes(1);
    expect(slice(ID_B).diff.phase).toBe("loaded");
    expect(slice(ID_A).diff.phase).toBe("idle");
    expect(slice(ID_C).diff.phase).toBe("idle");

    useReviewStore.getState().activateSession(ID_A);
    await vi.waitFor(() => {
      expect(slice(ID_A).diff.phase).toBe("loaded");
    });
    expect(bridge.getCommitLog).toHaveBeenCalledTimes(2);
    expect(bridge.getCommitLog).toHaveBeenLastCalledWith({ repoPath: "/repo-a", range: null });

    useReviewStore.getState().activateSession(ID_B);
    useReviewStore.getState().activateSession(ID_A);
    expect(bridge.getCommitLog).toHaveBeenCalledTimes(2);
    expect(bridge.listBranches).toHaveBeenCalledTimes(2);
    expect(bridge.getDiff).toHaveBeenCalledTimes(2);
  });

  it("hydration restores both modes' inputs, file, and scroll into the slice", async () => {
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [
        storedSession(ID_A, "/repo-a", {
          mode: "commits",
          base: "main",
          head: "feature/x",
          commitSelection: { kind: "commitRangeWithUncommitted", first: SHA_A },
          selectedFilePath: "doomed.txt",
          scrollTop: 240,
        }),
      ],
      activeSessionId: ID_A,
    });

    const restored = slice(ID_A);
    expect(restored.mode).toBe("commits");
    expect(restored.base).toBe("main");
    expect(restored.head).toBe("feature/x");
    expect(restored.brush).toEqual({ anchor: 0, focus: 1 });
    expect(restored.selection).toEqual({ kind: "commitRangeWithUncommitted", first: SHA_A });
    expect(restored.scrollTop).toBe(240);
    // The persisted file focus survives because the fresh diff still contains it.
    expect(restored.selectedFilePath).toBe("doomed.txt");
    expect(restored.diff.phase).toBe("loaded");
  });

  it("switching away and back yields the identical slice with zero bridge calls", async () => {
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [
        storedSession(ID_A, "/repo-a", {
          commitSelection: { kind: "commitRangeWithUncommitted", first: SHA_A },
          selectedFilePath: "notes.txt",
          base: "main",
          head: "feature/x",
        }),
        storedSession(ID_B, "/repo-b"),
      ],
      activeSessionId: ID_A,
    });
    const before = slice(ID_A);

    useReviewStore.getState().activateSession(ID_B);
    await vi.waitFor(() => {
      expect(slice(ID_B).diff.phase).toBe("loaded");
    });
    expect(slice(ID_A)).toBe(before);

    const callsBeforeReturn = totalBridgeCalls(bridge);
    useReviewStore.getState().activateSession(ID_A);

    expect(totalBridgeCalls(bridge)).toBe(callsBeforeReturn);
    const after = slice(ID_A);
    expect(after).toBe(before);
    expect(after.selection).toEqual({ kind: "commitRangeWithUncommitted", first: SHA_A });
    expect(after.brush).toEqual({ anchor: 0, focus: 1 });
    expect(after.base).toBe("main");
    expect(after.head).toBe("feature/x");
    expect(after.selectedFilePath).toBe("notes.txt");
  });

  it("a getDiff response resolving after a tab switch mutates only its originating slice", async () => {
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [storedSession(ID_A, "/repo-a"), storedSession(ID_B, "/repo-b")],
      activeSessionId: ID_A,
    });
    let resolveDiff: (value: DiffResponse) => void = () => {};
    vi.mocked(bridge.getDiff).mockReturnValueOnce(
      new Promise<DiffResponse>((resolve) => {
        resolveDiff = resolve;
      }),
    );

    useReviewStore.getState().applyBrush({ type: "extend", index: 1 });
    expect(slice(ID_A).diff.phase).toBe("loading");

    useReviewStore.getState().activateSession(ID_B);
    await vi.waitFor(() => {
      expect(slice(ID_B).diff.phase).toBe("loaded");
    });
    const bDiff = slice(ID_B).diff;

    resolveDiff({ ok: true, value: { patch: MULTI_STATUS_PATCH } });
    await vi.waitFor(() => {
      expect(slice(ID_A).diff.phase).toBe("loaded");
    });

    expect(slice(ID_A).selection).toEqual({ kind: "commitRangeWithUncommitted", first: SHA_A });
    expect(slice(ID_B).diff).toBe(bDiff);
    expect(useReviewStore.getState().activeSessionId).toBe(ID_B);
  });

  it("a failed derivation surfaces as a typed GitFailure in that session only", async () => {
    const bridge = makeBridge({
      getCommitLog: vi
        .fn()
        .mockImplementation(({ repoPath }: { repoPath: string }) =>
          Promise.resolve(
            repoPath === "/repo-b"
              ? { ok: false, failure: { code: "notARepo", path: repoPath } }
              : { ok: true, value: { entries: DIRTY_ENTRIES } },
          ),
        ),
    });
    await hydrateWith(bridge, {
      sessions: [storedSession(ID_A, "/repo-a"), storedSession(ID_B, "/repo-b")],
      activeSessionId: ID_A,
    });
    expect(slice(ID_A).diff.phase).toBe("loaded");

    useReviewStore.getState().activateSession(ID_B);
    await vi.waitFor(() => {
      expect(slice(ID_B).log).toEqual({
        phase: "failed",
        failure: { code: "notARepo", path: "/repo-b" },
      });
    });
    expect(slice(ID_B).diff).toEqual({
      phase: "failed",
      failure: { code: "notARepo", path: "/repo-b" },
    });
    expect(slice(ID_A).log).toEqual({ phase: "loaded", entries: DIRTY_ENTRIES });
    expect(slice(ID_A).diff.phase).toBe("loaded");
  });

  it("a mode switch during first-activation derivation does not strand the session", async () => {
    let resolveLog: (value: unknown) => void = () => {};
    const bridge = makeBridge({
      getCommitLog: vi.fn().mockReturnValue(
        new Promise((resolve) => {
          resolveLog = resolve;
        }),
      ),
    });
    vi.mocked(bridge.listSessions).mockResolvedValue({
      sessions: [storedSession(ID_A, "/repo-a")],
      activeSessionId: ID_A,
    });
    vi.stubGlobal("window", { reviewer: bridge });
    useReviewStore.setState({ boot: "pending" });
    const hydration = useReviewStore.getState().hydrate();
    await vi.waitFor(() => {
      expect(slice(ID_A).log).toEqual({ phase: "loading" });
    });

    useReviewStore.getState().setMode("branches");

    resolveLog({ ok: true, value: { entries: DIRTY_ENTRIES } });
    await hydration;

    expect(slice(ID_A).log).toEqual({ phase: "loaded", entries: DIRTY_ENTRIES });
    expect(slice(ID_A).branches).toEqual({ phase: "loaded", list: BRANCH_LIST });
    await vi.waitFor(() => {
      expect(slice(ID_A).diff.phase).toBe("loaded");
    });
    expect(slice(ID_A).selection).toEqual({
      kind: "branches",
      base: "main",
      head: "feature/x",
    });
  });

  it("a persisted selection whose SHAs left the log degrades to the typed empty selection", async () => {
    const missingFirst = "d".repeat(40);
    const missingLast = "e".repeat(40);
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [
        storedSession(ID_A, "/repo-a", {
          commitSelection: { kind: "commitRange", first: missingFirst, last: missingLast },
        }),
      ],
      activeSessionId: ID_A,
    });

    const restored = slice(ID_A);
    expect(restored.log).toEqual({ phase: "loaded", entries: DIRTY_ENTRIES });
    expect(restored.brush).toBeNull();
    expect(restored.selection).toBeNull();
    expect(restored.diff).toEqual({ phase: "empty" });
    // No brush means no diff to request — a mis-ranged fetch would show up here.
    expect(bridge.getDiff).not.toHaveBeenCalled();
    // The stale-but-valid SHAs stay persisted: degrading the view must not
    // downgrade what main holds on disk.
    expect(restored.commitSelection).toEqual({
      kind: "commitRange",
      first: missingFirst,
      last: missingLast,
    });
  });

  it("boots a many-tab store deriving only the active session — no spawn stampede", async () => {
    const bridge = makeBridge({});
    const stored = Array.from({ length: 12 }, (_, index) =>
      storedSession(randomUUID(), `/repo-${index}`),
    );
    const activeSession = stored[6];
    const otherSession = stored[0];
    if (activeSession === undefined || otherSession === undefined) {
      throw new Error("fixture sessions missing");
    }
    await hydrateWith(bridge, { sessions: stored, activeSessionId: activeSession.id });

    // Exactly the active repo spawned git; every other tab is still un-derived.
    expect(bridge.getCommitLog).toHaveBeenCalledTimes(1);
    expect(bridge.getCommitLog).toHaveBeenCalledWith({
      repoPath: activeSession.source.repo.path,
      range: null,
    });
    expect(bridge.listBranches).toHaveBeenCalledTimes(1);
    expect(bridge.getDiff).toHaveBeenCalledTimes(1);
    for (const session of stored) {
      expect(slice(session.id).diff.phase).toBe(session === activeSession ? "loaded" : "idle");
    }

    // Activating one other tab derives it exactly once; the rest stay idle.
    useReviewStore.getState().activateSession(otherSession.id);
    await vi.waitFor(() => {
      expect(slice(otherSession.id).diff.phase).toBe("loaded");
    });
    expect(bridge.getCommitLog).toHaveBeenCalledTimes(2);
    expect(bridge.getCommitLog).toHaveBeenLastCalledWith({
      repoPath: otherSession.source.repo.path,
      range: null,
    });
    expect(bridge.getDiff).toHaveBeenCalledTimes(2);
  });

  it("a deleted branch ref surfaces as unknownRevision on restore, in that tab only", async () => {
    const bridge = makeBridge({
      getDiff: vi
        .fn()
        .mockImplementation(({ repoPath }: { repoPath: string }) =>
          Promise.resolve(
            repoPath === "/repo-b"
              ? { ok: false, failure: { code: "unknownRevision" } }
              : { ok: true, value: { patch: MULTI_STATUS_PATCH } },
          ),
        ),
    });
    await hydrateWith(bridge, {
      sessions: [
        storedSession(ID_A, "/repo-a", { mode: "branches", base: "main", head: "feature/x" }),
        storedSession(ID_B, "/repo-b", { mode: "branches", base: "main", head: "feature/gone" }),
      ],
      activeSessionId: ID_B,
    });

    await vi.waitFor(() => {
      expect(slice(ID_B).diff).toEqual({ phase: "failed", failure: { code: "unknownRevision" } });
    });

    useReviewStore.getState().activateSession(ID_A);
    await vi.waitFor(() => {
      expect(slice(ID_A).diff.phase).toBe("loaded");
    });
    // The broken tab is shown broken, never silently dropped; the sibling
    // restores healthy on its own first activation.
    expect(useReviewStore.getState().sessions[ID_B]).toBeDefined();
  });

  it("recovers the active tab when a salvaged store kept sessions but nulled the pointer", async () => {
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [storedSession(ID_A, "/repo-a"), storedSession(ID_B, "/repo-b")],
      activeSessionId: null,
    });

    // Lands on the first surviving tab instead of the empty state behind a
    // populated strip; only that tab derives, so bounded boot still holds.
    expect(useReviewStore.getState().activeSessionId).toBe(ID_A);
    expect(slice(ID_A).diff.phase).toBe("loaded");
    expect(slice(ID_B).diff.phase).toBe("idle");
    expect(bridge.getCommitLog).toHaveBeenCalledTimes(1);
    expect(bridge.getCommitLog).toHaveBeenCalledWith({ repoPath: "/repo-a", range: null });

    // The recovered pointer heals main's null on the debounced write-back.
    useReviewStore.getState().flushWriteBacks();
    expect(bridge.setActiveSession).toHaveBeenCalledWith({ id: ID_A });
  });
});

describe("session lifecycle", () => {
  it("closing the active tab activates the right neighbor and deletes the session via the bridge", async () => {
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [
        storedSession(ID_A, "/repo-a"),
        storedSession(ID_B, "/repo-b"),
        storedSession(ID_C, "/repo-c"),
      ],
      activeSessionId: ID_B,
    });

    useReviewStore.getState().closeSession();

    expect(bridge.deleteSession).toHaveBeenCalledWith({ id: ID_B });
    expect(useReviewStore.getState().sessions[ID_B]).toBeUndefined();
    expect(useReviewStore.getState().activeSessionId).toBe(ID_C);
    // The neighbor was never derived; activation-by-close derives it like a switch.
    await vi.waitFor(() => {
      expect(slice(ID_C).diff.phase).toBe("loaded");
    });
  });

  it("closing the rightmost active tab falls back to the left neighbor", async () => {
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [storedSession(ID_A, "/repo-a"), storedSession(ID_B, "/repo-b")],
      activeSessionId: ID_B,
    });

    useReviewStore.getState().closeSession(ID_B);

    expect(useReviewStore.getState().activeSessionId).toBe(ID_A);
  });

  it("closing the last tab lands on the empty state", async () => {
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [storedSession(ID_A, "/repo-a")],
      activeSessionId: ID_A,
    });

    useReviewStore.getState().closeSession();

    // What App renders as EmptyState: a settled boot with no sessions.
    expect(useReviewStore.getState().boot).toBe("ready");
    expect(useReviewStore.getState().sessions).toEqual({});
    expect(useReviewStore.getState().activeSessionId).toBeNull();
    expect(bridge.deleteSession).toHaveBeenCalledWith({ id: ID_A });
  });

  it("closing a background tab leaves the active slice and pointer untouched", async () => {
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [storedSession(ID_A, "/repo-a"), storedSession(ID_B, "/repo-b")],
      activeSessionId: ID_A,
    });
    const activeBefore = slice(ID_A);

    useReviewStore.getState().closeSession(ID_B);

    expect(bridge.deleteSession).toHaveBeenCalledWith({ id: ID_B });
    expect(useReviewStore.getState().activeSessionId).toBe(ID_A);
    expect(slice(ID_A)).toBe(activeBefore);
    expect(bridge.setActiveSession).not.toHaveBeenCalled();
  });

  it("a write-back pending for a closed session is canceled, not sent stale", async () => {
    vi.useFakeTimers();
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);

    useReviewStore.getState().setScrollTop(300);
    useReviewStore.getState().closeSession();
    await vi.advanceTimersByTimeAsync(WRITE_BACK_DEBOUNCE_MS);

    expect(bridge.updateSession).not.toHaveBeenCalled();
    expect(bridge.deleteSession).toHaveBeenCalledWith({ id: SESSION_ID });
  });

  it("opening a repo already open as a tab re-activates that tab instead of duplicating it", async () => {
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [storedSession(ID_A, "/repo-a"), storedSession(ID_B, "/repo-b")],
      activeSessionId: ID_B,
    });
    vi.mocked(bridge.openRepo).mockResolvedValue({
      ok: true,
      value: { kind: "opened", repo: { path: "/repo-a", name: "repo-a" } },
    });

    await useReviewStore.getState().openRepository();

    expect(bridge.createSession).not.toHaveBeenCalled();
    expect(useReviewStore.getState().activeSessionId).toBe(ID_A);
    expect(Object.keys(useReviewStore.getState().sessions)).toEqual([ID_A, ID_B]);
    // Re-activation is a first activation for this restored tab: it derives.
    await vi.waitFor(() => {
      expect(slice(ID_A).diff.phase).toBe("loaded");
    });
  });

  it("a duplicate open clears a lingering open failure", async () => {
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);
    useReviewStore.setState({ openFailure: { code: "gitMissing" } });

    await useReviewStore.getState().openRepository();

    expect(useReviewStore.getState().openFailure).toBeNull();
    expect(bridge.createSession).toHaveBeenCalledTimes(1);
  });

  it("⌘n ordinals are positional and ⌘9 is the last tab", async () => {
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [
        storedSession(ID_A, "/repo-a"),
        storedSession(ID_B, "/repo-b"),
        storedSession(ID_C, "/repo-c"),
      ],
      activeSessionId: ID_A,
    });

    useReviewStore.getState().activateTabByOrdinal(2);
    expect(useReviewStore.getState().activeSessionId).toBe(ID_B);

    useReviewStore.getState().activateTabByOrdinal(9);
    expect(useReviewStore.getState().activeSessionId).toBe(ID_C);

    useReviewStore.getState().activateTabByOrdinal(7);
    expect(useReviewStore.getState().activeSessionId).toBe(ID_C);
  });

  it("⌃Tab cycles forward and ⌃⇧Tab backward, wrapping at both ends", async () => {
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [
        storedSession(ID_A, "/repo-a"),
        storedSession(ID_B, "/repo-b"),
        storedSession(ID_C, "/repo-c"),
      ],
      activeSessionId: ID_C,
    });

    useReviewStore.getState().cycleActiveSession("next");
    expect(useReviewStore.getState().activeSessionId).toBe(ID_A);

    useReviewStore.getState().cycleActiveSession("previous");
    expect(useReviewStore.getState().activeSessionId).toBe(ID_C);

    useReviewStore.getState().cycleActiveSession("previous");
    expect(useReviewStore.getState().activeSessionId).toBe(ID_B);
  });
});

describe("debounced write-back", () => {
  it("mutating a slice schedules exactly one debounced sessions:update carrying inputs only", async () => {
    vi.useFakeTimers();
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);

    useReviewStore.getState().setMode("branches");
    useReviewStore.getState().swapBranches();
    expect(bridge.updateSession).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(WRITE_BACK_DEBOUNCE_MS);

    expect(bridge.updateSession).toHaveBeenCalledTimes(1);
    expect(bridge.updateSession).toHaveBeenCalledWith({
      id: SESSION_ID,
      source: { kind: "local", repo: { path: "/repo", name: "repo" } },
      mode: "branches",
      base: "feature/x",
      head: "main",
      commitSelection: { kind: "uncommitted" },
      selectedFilePath: "added.txt",
      scrollTop: 0,
      comments: [],
      layers: [],
      overview: null,
      reviewDiff: null,
      reviewSubrange: null,
      reviewOrigin: null,
    });
  });

  it("a mutation followed immediately by the quit flush reaches sessions:update", async () => {
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);

    useReviewStore.getState().setScrollTop(120);
    useReviewStore.getState().setMode("branches");
    expect(bridge.updateSession).not.toHaveBeenCalled();

    useReviewStore.getState().flushWriteBacks();

    expect(bridge.updateSession).toHaveBeenCalledTimes(1);
    expect(bridge.updateSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: SESSION_ID, mode: "branches", scrollTop: 120 }),
    );

    useReviewStore.getState().flushWriteBacks();
    expect(bridge.updateSession).toHaveBeenCalledTimes(1);
  });

  it("tab switches coalesce into one debounced set-active carrying the final id", async () => {
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [storedSession(ID_A, "/repo-a"), storedSession(ID_B, "/repo-b")],
      activeSessionId: ID_A,
    });

    useReviewStore.getState().activateSession(ID_B);
    useReviewStore.getState().activateSession(ID_A);
    useReviewStore.getState().activateSession(ID_B);
    expect(bridge.setActiveSession).not.toHaveBeenCalled();

    useReviewStore.getState().flushWriteBacks();

    expect(bridge.setActiveSession).toHaveBeenCalledTimes(1);
    expect(bridge.setActiveSession).toHaveBeenCalledWith({ id: ID_B });
  });
});

describe("scroll capture into the owning slice", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a debounced scroll burst lands as one final position in the scrolling session's slice", async () => {
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [storedSession(ID_A, "/repo-a"), storedSession(ID_B, "/repo-b")],
      activeSessionId: ID_A,
    });
    // Wired the way DiffView binds it: captures for repo A commit to A's slice.
    const capture = createScrollCapture((top) => useReviewStore.getState().setScrollTop(top, ID_A));

    capture.notify(400);
    capture.notify(900);
    capture.notify(1500);
    expect(slice(ID_A).scrollTop).toBe(0);

    await vi.advanceTimersByTimeAsync(SCROLL_CAPTURE_DEBOUNCE_MS);

    expect(slice(ID_A).scrollTop).toBe(1500);
    // The background session is never touched by another tab's scroll.
    expect(slice(ID_B).scrollTop).toBe(0);
  });

  it("flush captures the last position before a switch without waiting out the debounce", async () => {
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [storedSession(ID_A, "/repo-a")],
      activeSessionId: ID_A,
    });
    const capture = createScrollCapture((top) => useReviewStore.getState().setScrollTop(top, ID_A));

    capture.notify(760);
    capture.flush();

    expect(slice(ID_A).scrollTop).toBe(760);
  });
});

describe("useReviewStore review-open flows", () => {
  it("opens a dropped review: re-lists main's session, activates it, and clears any failure", async () => {
    const bridge = makeBridge({
      openReviewByPath: vi.fn().mockResolvedValue({
        ok: true,
        value: { kind: "opened", sessionId: ID_A },
      }),
      listSessions: vi.fn().mockResolvedValue({
        sessions: [storedSession(ID_A, "/repo-a")],
        activeSessionId: ID_A,
      }),
    });
    useReviewStore.setState({ reviewOpenFailure: { code: "unreadable" } });
    vi.stubGlobal("window", { reviewer: bridge });

    await useReviewStore.getState().openReviewByPath("/abs/x.reviewer.json");

    expect(bridge.openReviewByPath).toHaveBeenCalledWith({ path: "/abs/x.reviewer.json" });
    expect(useReviewStore.getState().activeSessionId).toBe(ID_A);
    expect(slice(ID_A).repo).toEqual({ path: "/repo-a", name: "repo-a" });
    // Main marked it active; the new slice derives (log/branches fetched).
    expect(slice(ID_A).log?.phase).toBe("loaded");
    expect(useReviewStore.getState().reviewOpenFailure).toBeNull();
  });

  it("surfaces a typed failure and creates no session when the open fails", async () => {
    const bridge = makeBridge({
      openReview: vi.fn().mockResolvedValue({ ok: false, failure: { code: "invalidContent" } }),
    });
    vi.stubGlobal("window", { reviewer: bridge });

    await useReviewStore.getState().openReview();

    expect(useReviewStore.getState().reviewOpenFailure).toEqual({ code: "invalidContent" });
    expect(useReviewStore.getState().sessions).toEqual({});
    expect(bridge.listSessions).not.toHaveBeenCalled();
  });

  it("leaves state untouched on a dialog cancel", async () => {
    const bridge = makeBridge({
      openReview: vi.fn().mockResolvedValue({ ok: true, value: { kind: "canceled" } }),
    });
    vi.stubGlobal("window", { reviewer: bridge });

    await useReviewStore.getState().openReview();

    expect(useReviewStore.getState().sessions).toEqual({});
    expect(useReviewStore.getState().reviewOpenFailure).toBeNull();
    expect(bridge.listSessions).not.toHaveBeenCalled();
  });

  it("a dropped File with no disk path yields a typed failure and never invokes with an empty path", async () => {
    const bridge = makeBridge({ getPathForFile: vi.fn().mockReturnValue(null) });
    vi.stubGlobal("window", { reviewer: bridge });

    await useReviewStore.getState().openDroppedFile(new File(["{}"], "x.reviewer.json"));

    expect(useReviewStore.getState().reviewOpenFailure).toEqual({ code: "unreadable" });
    expect(bridge.openReviewByPath).not.toHaveBeenCalled();
  });

  it("a dropped File with a disk path opens that path", async () => {
    const bridge = makeBridge({
      getPathForFile: vi.fn().mockReturnValue("/abs/x.reviewer.json"),
      openReviewByPath: vi.fn().mockResolvedValue({ ok: true, value: { kind: "canceled" } }),
    });
    vi.stubGlobal("window", { reviewer: bridge });

    await useReviewStore.getState().openDroppedFile(new File(["{}"], "x.reviewer.json"));

    expect(bridge.getPathForFile).toHaveBeenCalledTimes(1);
    expect(bridge.openReviewByPath).toHaveBeenCalledWith({ path: "/abs/x.reviewer.json" });
  });

  it("syncSessions adds a pushed session and adopts main's active without re-deriving the live one", async () => {
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [storedSession(ID_A, "/repo-a")],
      activeSessionId: ID_A,
    });
    const derivedA = slice(ID_A);
    expect(derivedA.needsDerive).toBe(false);

    vi.mocked(bridge.listSessions).mockResolvedValue({
      sessions: [storedSession(ID_A, "/repo-a"), storedSession(ID_B, "/repo-b")],
      activeSessionId: ID_B,
    });
    await useReviewStore.getState().syncSessions();

    // The live slice is kept by identity (same reference), never re-derived.
    expect(slice(ID_A)).toBe(derivedA);
    expect(useReviewStore.getState().activeSessionId).toBe(ID_B);
    expect(slice(ID_B).needsDerive).toBe(false);
    expect(slice(ID_B).log?.phase).toBe("loaded");
  });
});

describe("comment curation", () => {
  const ANCHOR = { file: "added.txt", side: "additions", startLine: 1, endLine: 2 } as const;

  it("addComment stamps app identity, stores the body, and schedules a write-back carrying it", async () => {
    vi.useFakeTimers();
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);

    useReviewStore.getState().addComment(ANCHOR, "  needs a guard  ");

    const [added] = active().comments;
    expect(added?.body).toBe("needs a guard");
    expect(added?.file).toBe("added.txt");
    expect(added?.id).toMatch(/^[0-9a-f-]{36}$/);

    expect(bridge.updateSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(WRITE_BACK_DEBOUNCE_MS);
    expect(bridge.updateSession).toHaveBeenCalledWith(
      expect.objectContaining({ comments: [added] }),
    );
  });

  it("addComment refuses an empty body — a comment is never stored bodyless", async () => {
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);

    useReviewStore.getState().addComment(ANCHOR, "   ");

    expect(active().comments).toHaveLength(0);
    useReviewStore.getState().flushWriteBacks();
    expect(bridge.updateSession).not.toHaveBeenCalled();
  });

  it("editComment rewrites the body while keeping identity, and persists", async () => {
    vi.useFakeTimers();
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);
    useReviewStore.getState().addComment(ANCHOR, "first");
    const original = active().comments[0];

    useReviewStore.getState().editComment(original?.id ?? "", "second");

    const edited = active().comments[0];
    expect(edited?.body).toBe("second");
    expect(edited?.id).toBe(original?.id);

    await vi.advanceTimersByTimeAsync(WRITE_BACK_DEBOUNCE_MS);
    expect(bridge.updateSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ comments: [edited] }),
    );
  });

  it("editComment with an empty body is a no-op, never an empty-body write", async () => {
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);
    useReviewStore.getState().addComment(ANCHOR, "keep me");

    useReviewStore.getState().editComment(active().comments[0]?.id ?? "", "  ");

    expect(active().comments[0]?.body).toBe("keep me");
  });

  it("discardComment removes the comment, leaving no trace, and persists the removal", async () => {
    vi.useFakeTimers();
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);
    useReviewStore.getState().addComment(ANCHOR, "temporary");
    const target = active().comments[0];

    useReviewStore.getState().discardComment(target?.id ?? "");

    expect(active().comments).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(WRITE_BACK_DEBOUNCE_MS);
    expect(bridge.updateSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ comments: [] }),
    );
  });

  it("a comment survives a quit-and-relaunch: the persisted body hydrates back onto its slice", async () => {
    const persisted = {
      file: "added.txt",
      side: "additions" as const,
      startLine: 1,
      endLine: 2,
      body: "restored on its line",
      id: ID_C,
    };
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [storedSession(ID_A, "/repo-a", { comments: [persisted] })],
      activeSessionId: ID_A,
    });

    expect(slice(ID_A).comments).toEqual([persisted]);
  });
});

describe("useReviewStore layer navigation", () => {
  const LAYERS: ReviewLayer[] = [
    {
      id: "layer-a",
      label: "Validation",
      summary: "Controller guards",
      ranges: [{ file: "added.txt", side: "additions", startLine: 1, endLine: 1 }],
    },
    {
      id: "layer-b",
      label: "Feature",
      summary: "New endpoint",
      ranges: [{ file: "notes.txt", side: "additions", startLine: 1, endLine: 1 }],
    },
    {
      id: "layer-c",
      label: "Cleanup",
      summary: "Dead code",
      ranges: [{ file: "doomed.txt", side: "deletions", startLine: 1, endLine: 1 }],
    },
  ];

  // A slice carrying a real persisted diff selection + file focus + scroll, so the
  // non-mutation assertions have concrete values that layer navigation must leave
  // exactly as they were.
  beforeEach(() => {
    const files = parsePatch(MULTI_STATUS_PATCH, "test");
    const seeded: SessionSlice = {
      id: SESSION_ID,
      repo: { path: "/repo", name: "repo" },
      mode: "branches",
      log: null,
      branches: null,
      brush: null,
      base: "main" as BranchName,
      head: "feature/x" as BranchName,
      selection: { kind: "branches", base: "main" as BranchName, head: "feature/x" as BranchName },
      diff: { phase: "loaded", loadId: 1, files },
      selectedFilePath: "notes.txt",
      scrollTop: 640,
      commitSelection: null,
      comments: [],
      layers: LAYERS,
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
    };
    useReviewStore.setState({
      boot: "ready",
      sessions: { [SESSION_ID]: seeded },
      activeSessionId: SESSION_ID,
    });
  });

  it("solos a layer and clears back to the full diff", () => {
    useReviewStore.getState().setActiveLayer("layer-b");
    expect(active().activeLayerId).toBe("layer-b");
    useReviewStore.getState().setActiveLayer(null);
    expect(active().activeLayerId).toBeNull();
  });

  it("steps the authored order then the inferred uncovered layer, clamping at both ends", () => {
    // The three layers cover three single lines of a multi-file diff, so a coverable
    // gap remains: the inferred "not covered by layers" layer is the last stop in the
    // effective order, reachable by stepping past the last authored layer.
    const { stepLayer } = useReviewStore.getState();
    stepLayer(1);
    expect(active().activeLayerId).toBe("layer-a");
    stepLayer(1);
    expect(active().activeLayerId).toBe("layer-b");
    stepLayer(1);
    expect(active().activeLayerId).toBe("layer-c");
    stepLayer(1);
    expect(active().activeLayerId).toBe(UNCOVERED_LAYER_ID);
    stepLayer(1);
    expect(active().activeLayerId).toBe(UNCOVERED_LAYER_ID);
    stepLayer(-1);
    expect(active().activeLayerId).toBe("layer-c");
  });

  it("never mutates the persisted diff selection, file focus, or scroll", () => {
    const before = active();
    useReviewStore.getState().setActiveLayer("layer-c");
    useReviewStore.getState().stepLayer(-1);
    const after = active();
    expect(after.selection).toBe(before.selection);
    expect(after.selectedFilePath).toBe("notes.txt");
    expect(after.scrollTop).toBe(640);
    expect(after.commitSelection).toBe(before.commitSelection);
  });

  it("schedules no write-back: soloing is derived view state, never persisted", async () => {
    vi.useFakeTimers();
    const bridge = makeBridge({});
    vi.stubGlobal("window", { reviewer: bridge });
    useReviewStore.getState().setActiveLayer("layer-a");
    useReviewStore.getState().stepLayer(1);
    await vi.advanceTimersByTimeAsync(WRITE_BACK_DEBOUNCE_MS);
    expect(bridge.updateSession).not.toHaveBeenCalled();
  });

  it("does not carry the active layer into the persisted session", () => {
    const bridge = makeBridge({});
    vi.stubGlobal("window", { reviewer: bridge });
    useReviewStore.getState().setActiveLayer("layer-b");
    // A subsequent real mutation flushes a write-back; the payload must omit the
    // active layer entirely — a relaunch always reopens on the full diff.
    useReviewStore.getState().setScrollTop(720);
    useReviewStore.getState().flushWriteBacks();
    expect(bridge.updateSession).toHaveBeenCalledTimes(1);
    const persisted = vi.mocked(bridge.updateSession).mock.calls[0]?.[0];
    expect(persisted).not.toHaveProperty("activeLayerId");
  });
});

describe("useReviewStore tour doc navigation", () => {
  // The walkthrough with a doc in front of it: the doc is stop zero, then two layers,
  // then (this diff leaves a gap) the inferred uncovered layer.
  const OVERVIEW: ReviewOverview = { title: "Add the greeting API", body: "What and why." };
  const LAYERS: ReviewLayer[] = [
    {
      id: "layer-a",
      label: "Greeting",
      summary: "New API",
      ranges: [{ file: "greet.ts", side: "additions", startLine: 2, endLine: 2 }],
    },
    {
      id: "layer-b",
      label: "Notes",
      summary: "Copy pass",
      ranges: [{ file: "notes.txt", side: "additions", startLine: 1, endLine: 1 }],
    },
  ];

  function seedTour(overrides: Partial<SessionSlice> = {}): void {
    const files = parsePatch(MULTI_STATUS_PATCH, "test");
    const seeded: SessionSlice = {
      id: SESSION_ID,
      repo: { path: "/repo", name: "repo" },
      mode: "commits",
      log: null,
      branches: null,
      brush: null,
      base: null,
      head: null,
      selection: null,
      diff: { phase: "loaded", loadId: 1, files },
      selectedFilePath: "greet.ts",
      scrollTop: 0,
      commitSelection: null,
      comments: [],
      layers: LAYERS,
      reviewDiff: null,
      reviewSubrange: null,
      reviewOrigin: null,
      overview: OVERVIEW,
      overviewOpen: true,
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
      sessions: { [SESSION_ID]: seeded },
      activeSessionId: SESSION_ID,
    });
  }

  it("a restored review with a doc opens on it; one without opens on its diff", async () => {
    const withDoc: Session = {
      id: SESSION_ID,
      source: { kind: "local", repo: { path: "/repo", name: "repo" } },
      mode: "commits",
      base: null,
      head: null,
      commitSelection: null,
      selectedFilePath: null,
      scrollTop: 0,
      comments: [],
      layers: LAYERS,
      overview: OVERVIEW,
      reviewDiff: null,
      reviewSubrange: null,
      reviewOrigin: null,
    };
    const bridge = makeBridge({
      listSessions: vi.fn().mockResolvedValue({ sessions: [withDoc], activeSessionId: SESSION_ID }),
    });
    vi.stubGlobal("window", { reviewer: bridge });
    useReviewStore.setState({ boot: "pending" });
    await useReviewStore.getState().hydrate();
    expect(active().overviewOpen).toBe(true);

    const withoutDoc: Session = { ...withDoc, overview: null };
    const plainBridge = makeBridge({
      listSessions: vi
        .fn()
        .mockResolvedValue({ sessions: [withoutDoc], activeSessionId: SESSION_ID }),
    });
    vi.stubGlobal("window", { reviewer: plainBridge });
    useReviewStore.setState({ boot: "pending" });
    await useReviewStore.getState().hydrate();
    expect(active().overviewOpen).toBe(false);
  });

  it("entering a chapter leaves the doc, and the doc clears the solo when re-entered", () => {
    seedTour();
    useReviewStore.getState().setActiveLayer("layer-b");
    expect(active().overviewOpen).toBe(false);
    expect(active().activeLayerId).toBe("layer-b");

    useReviewStore.getState().openOverview();
    // Exactly one selected stop: the doc's own invariant.
    expect(active().overviewOpen).toBe(true);
    expect(active().activeLayerId).toBeNull();
  });

  it("steps the doc as stop zero: forward enters chapter one, back off it returns", () => {
    seedTour();
    const { stepLayer } = useReviewStore.getState();

    stepLayer(-1);
    expect(active().overviewOpen).toBe(true); // already at the start

    stepLayer(1);
    expect(active()).toMatchObject({ overviewOpen: false, activeLayerId: "layer-a" });
    stepLayer(1);
    expect(active().activeLayerId).toBe("layer-b");
    stepLayer(-1);
    expect(active().activeLayerId).toBe("layer-a");
    stepLayer(-1);
    expect(active()).toMatchObject({ overviewOpen: true, activeLayerId: null });
  });

  it("without a doc, stepping back off the first chapter still clamps", () => {
    seedTour({ overview: null, overviewOpen: false, activeLayerId: "layer-a" });
    useReviewStore.getState().stepLayer(-1);
    expect(active()).toMatchObject({ overviewOpen: false, activeLayerId: "layer-a" });
  });

  it("remembers the chapter last entered so the doc can return the reader to it", () => {
    seedTour();
    useReviewStore.getState().setActiveLayer("layer-b");
    useReviewStore.getState().openOverview();
    expect(active().lastChapterId).toBe("layer-b");
    // Clearing back to the full diff is not a chapter, so it leaves the bookmark alone.
    useReviewStore.getState().setActiveLayer(null);
    expect(active().lastChapterId).toBe("layer-b");
  });

  it("any navigation that targets the diff leaves the doc", () => {
    seedTour();
    useReviewStore.getState().selectFile("notes.txt");
    expect(active().overviewOpen).toBe(false);

    const comment: Comment = {
      file: "greet.ts",
      side: "additions",
      startLine: 2,
      endLine: 2,
      body: "why",
      id: "22222222-2222-4222-8222-222222222222",
    };
    seedTour({ comments: [comment] });
    useReviewStore.getState().focusComment(comment.id);
    expect(active().overviewOpen).toBe(false);
  });

  it("is derived view state: neither the doc nor the bookmark reaches the persisted session", () => {
    seedTour();
    const bridge = makeBridge({});
    vi.stubGlobal("window", { reviewer: bridge });
    useReviewStore.getState().setActiveLayer("layer-a");
    useReviewStore.getState().setScrollTop(120);
    useReviewStore.getState().flushWriteBacks();
    const persisted = vi.mocked(bridge.updateSession).mock.calls[0]?.[0];
    expect(persisted).not.toHaveProperty("overviewOpen");
    expect(persisted).not.toHaveProperty("lastChapterId");
    // The authored doc itself does persist — it is review content, like the layers.
    expect(persisted?.overview).toEqual(OVERVIEW);
  });
});

describe("useReviewStore comment navigation", () => {
  // MULTI_STATUS_PATCH file order: added.txt, doomed.txt, greet.ts, img.png,
  // newname.txt, notes.txt. Three placed comments, one per file, so document order
  // is added.txt → greet.ts → notes.txt.
  const C_ADDED: Comment = {
    file: "added.txt",
    side: "additions",
    startLine: 1,
    endLine: 1,
    body: "first file",
    id: ID_A,
  };
  const C_GREET: Comment = {
    file: "greet.ts",
    side: "additions",
    startLine: 2,
    endLine: 2,
    body: "middle file",
    id: ID_B,
  };
  const C_NOTES: Comment = {
    file: "notes.txt",
    side: "additions",
    startLine: 6,
    endLine: 6,
    body: "last file",
    id: ID_C,
  };

  function seedComments(comments: Comment[], overrides: Partial<SessionSlice> = {}): void {
    const files = parsePatch(MULTI_STATUS_PATCH, "test");
    const base: SessionSlice = {
      id: SESSION_ID,
      repo: { path: "/repo", name: "repo" },
      mode: "branches",
      log: null,
      branches: null,
      brush: null,
      base: "main" as BranchName,
      head: "feature/x" as BranchName,
      selection: { kind: "branches", base: "main" as BranchName, head: "feature/x" as BranchName },
      diff: { phase: "loaded", loadId: 1, files },
      selectedFilePath: null,
      scrollTop: 0,
      commitSelection: null,
      comments,
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
    };
    useReviewStore.setState({
      boot: "ready",
      sessions: { [SESSION_ID]: { ...base, ...overrides } },
      activeSessionId: SESSION_ID,
    });
  }

  it("focuses a comment: sets the active id and moves file focus onto its file", () => {
    seedComments([C_ADDED, C_GREET, C_NOTES]);
    useReviewStore.getState().focusComment(ID_B);
    expect(active().activeCommentId).toBe(ID_B);
    expect(active().selectedFilePath).toBe("greet.ts");
  });

  it("steps in document order from nothing, forward lands on the first comment", () => {
    seedComments([C_NOTES, C_ADDED, C_GREET]);
    const { stepComment } = useReviewStore.getState();
    stepComment(1);
    expect(active().activeCommentId).toBe(ID_A);
    stepComment(1);
    expect(active().activeCommentId).toBe(ID_B);
    stepComment(1);
    expect(active().activeCommentId).toBe(ID_C);
  });

  it("wraps at both ends so the walk is a cycle", () => {
    seedComments([C_ADDED, C_GREET, C_NOTES]);
    const { stepComment } = useReviewStore.getState();
    stepComment(-1); // from nothing, backward lands on the last
    expect(active().activeCommentId).toBe(ID_C);
    stepComment(1); // last → first
    expect(active().activeCommentId).toBe(ID_A);
    stepComment(-1); // first → last
    expect(active().activeCommentId).toBe(ID_C);
  });

  it("steps only the visible (soloed) file set, skipping comments a layer hides", () => {
    const soloGreet: ReviewLayer[] = [
      {
        id: "only-greet",
        label: "Greeting",
        summary: "the greet file",
        ranges: [{ file: "greet.ts", side: "additions", startLine: 1, endLine: 1 }],
      },
    ];
    seedComments([C_ADDED, C_GREET, C_NOTES], { layers: soloGreet, activeLayerId: "only-greet" });
    const { stepComment } = useReviewStore.getState();
    stepComment(1);
    expect(active().activeCommentId).toBe(ID_B);
    stepComment(1); // only one navigable under the solo → wraps back to itself
    expect(active().activeCommentId).toBe(ID_B);
  });

  it("clears the solo when focusing a comment the active layer would hide", () => {
    const soloGreet: ReviewLayer[] = [
      {
        id: "only-greet",
        label: "Greeting",
        summary: "the greet file",
        ranges: [{ file: "greet.ts", side: "additions", startLine: 1, endLine: 1 }],
      },
    ];
    seedComments([C_ADDED, C_GREET], { layers: soloGreet, activeLayerId: "only-greet" });
    useReviewStore.getState().focusComment(ID_A); // added.txt is outside the solo
    expect(active().activeLayerId).toBeNull();
    expect(active().activeCommentId).toBe(ID_A);
  });

  it("clears a dangling active id when the focused comment is discarded", () => {
    seedComments([C_ADDED, C_GREET]);
    useReviewStore.getState().focusComment(ID_A);
    useReviewStore.getState().discardComment(ID_A);
    expect(active().activeCommentId).toBeNull();
    // Discarding a different comment leaves the focus alone.
    useReviewStore.getState().focusComment(ID_B);
    useReviewStore.getState().discardComment("no-such-id");
    expect(active().activeCommentId).toBe(ID_B);
  });

  it("plain file navigation (tree click, j/k) dismisses the comment step-through", () => {
    seedComments([C_ADDED, C_GREET, C_NOTES]);
    useReviewStore.getState().focusComment(ID_B);
    useReviewStore.getState().selectFile("notes.txt");
    expect(active().activeCommentId).toBeNull();
    useReviewStore.getState().focusComment(ID_B);
    useReviewStore.getState().selectAdjacentFile(1);
    expect(active().activeCommentId).toBeNull();
  });

  it("never persists the active comment id", () => {
    const bridge = makeBridge({});
    vi.stubGlobal("window", { reviewer: bridge });
    seedComments([C_ADDED]);
    useReviewStore.getState().focusComment(ID_A);
    useReviewStore.getState().flushWriteBacks();
    const persisted = vi.mocked(bridge.updateSession).mock.calls.at(-1)?.[0];
    expect(persisted).not.toHaveProperty("activeCommentId");
    // The file focus half of focusComment does persist.
    expect(persisted?.selectedFilePath).toBe("added.txt");
  });
});

describe("review export actions", () => {
  const REPO = { path: "/repo", name: "app" };
  const ORIGIN: ReviewOrigin = {
    source: { kind: "local", repo: REPO, base: "main", head: SHA_A },
    patch: null,
  };
  const COMMENT: Comment = {
    file: "src/a.ts",
    side: "additions",
    startLine: 1,
    endLine: 1,
    body: "needs a guard",
    id: ID_A,
  };
  const LAYER: ReviewLayer = {
    id: "l1",
    label: "Validation",
    summary: "guards input",
    ranges: [{ file: "src/a.ts", side: "additions", startLine: 1, endLine: 1 }],
  };

  function seedSlice(overrides: Partial<SessionSlice>): void {
    const files = parsePatch(MULTI_STATUS_PATCH, "test");
    const base: SessionSlice = {
      id: SESSION_ID,
      repo: REPO,
      mode: "commits",
      log: null,
      branches: null,
      brush: null,
      base: null,
      head: null,
      selection: null,
      diff: { phase: "loaded", loadId: 1, files },
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
      needsDerive: false,
      requestTicket: 1,
    };
    useReviewStore.setState({
      boot: "ready",
      sessions: { [SESSION_ID]: { ...base, ...overrides } },
      activeSessionId: SESSION_ID,
    });
  }

  /** An imported review session carries its `reviewOrigin` and its curated comment
   * and layer; a plain repo session (null origin) is seeded bare, its export
   * projected from the selection each test sets. */
  function seed(reviewOrigin: ReviewOrigin | null): void {
    seedSlice(reviewOrigin === null ? {} : { reviewOrigin, comments: [COMMENT], layers: [LAYER] });
  }

  it("serializes the curated review and hands schema-valid JSON to the save seam", async () => {
    const bridge = makeBridge({});
    vi.stubGlobal("window", { reviewer: bridge });
    seed(ORIGIN);

    await useReviewStore.getState().exportReviewJson();

    expect(bridge.saveReviewJson).toHaveBeenCalledTimes(1);
    const request = vi.mocked(bridge.saveReviewJson).mock.calls[0]?.[0];
    expect(request?.defaultName).toBe("app-review.reviewer.json");
    const parsed = ReviewArtifact.safeParse(JSON.parse(request?.content ?? ""));
    expect(parsed.success).toBe(true);
    // The authored comment survives, with app-assigned identity stripped.
    expect(parsed.data?.comments).toEqual([
      { file: "src/a.ts", side: "additions", startLine: 1, endLine: 1, body: "needs a guard" },
    ]);
    expect(request?.content).not.toContain(ID_A);
  });

  it("renders the curated review to the markdown save seam", async () => {
    const bridge = makeBridge({});
    vi.stubGlobal("window", { reviewer: bridge });
    seed(ORIGIN);

    await useReviewStore.getState().exportReviewMarkdown();

    expect(bridge.saveReviewMarkdown).toHaveBeenCalledTimes(1);
    const request = vi.mocked(bridge.saveReviewMarkdown).mock.calls[0]?.[0];
    expect(request?.defaultName).toBe("app-review.md");
    expect(request?.content.startsWith("# Review — app")).toBe(true);
    expect(request?.content).toContain("needs a guard");
  });

  it("is a no-op when the active session has no diff to export", async () => {
    const bridge = makeBridge({});
    vi.stubGlobal("window", { reviewer: bridge });
    seedSlice({ selection: null });

    await useReviewStore.getState().exportReviewJson();
    await useReviewStore.getState().exportReviewMarkdown();

    expect(bridge.saveReviewJson).not.toHaveBeenCalled();
    expect(bridge.saveReviewMarkdown).not.toHaveBeenCalled();
  });

  it("exports a plain repo branch comparison as refs, no re-read, no patch", async () => {
    const bridge = makeBridge({});
    vi.stubGlobal("window", { reviewer: bridge });
    seedSlice({
      selection: { kind: "branches", base: "main", head: "feature" },
      comments: [COMMENT],
      layers: [LAYER],
    });

    await useReviewStore.getState().exportReviewJson();

    // A branch comparison round-trips as refs — no frozen patch, so no diff re-read.
    expect(bridge.getDiff).not.toHaveBeenCalled();
    const request = vi.mocked(bridge.saveReviewJson).mock.calls[0]?.[0];
    const artifact = ReviewArtifact.parse(JSON.parse(request?.content ?? ""));
    expect(artifact.source).toEqual({ kind: "local", repo: REPO, base: "main", head: "feature" });
    expect(artifact.patch).toBeUndefined();
  });

  it("embeds a frozen patch for a working-tree diff, sourced at HEAD", async () => {
    const bridge = makeBridge({});
    vi.stubGlobal("window", { reviewer: bridge });
    seedSlice({
      selection: { kind: "uncommitted" },
      log: { phase: "loaded", entries: DIRTY_ENTRIES },
      comments: [COMMENT],
    });

    await useReviewStore.getState().exportReviewJson();

    // The on-screen diff is re-read and frozen so its comments place verbatim; the
    // source records the session HEAD (first committed log entry).
    expect(bridge.getDiff).toHaveBeenCalledWith({
      repoPath: REPO.path,
      selection: { kind: "uncommitted" },
    });
    const request = vi.mocked(bridge.saveReviewJson).mock.calls[0]?.[0];
    const artifact = ReviewArtifact.parse(JSON.parse(request?.content ?? ""));
    expect(artifact.patch).toBe(MULTI_STATUS_PATCH);
    expect(artifact.source).toEqual({ kind: "local", repo: REPO, base: SHA_A, head: SHA_A });
  });

  it("surfaces an unreadable re-read rather than silently dropping the export", async () => {
    const bridge = makeBridge({
      getDiff: vi.fn().mockResolvedValue({ ok: false, failure: { code: "unexpected" } }),
    });
    vi.stubGlobal("window", { reviewer: bridge });
    seedSlice({
      selection: { kind: "commitRange", first: SHA_A, last: SHA_B },
      comments: [COMMENT],
    });

    await useReviewStore.getState().exportReviewJson();

    expect(bridge.saveReviewJson).not.toHaveBeenCalled();
    expect(useReviewStore.getState().reviewExportFailure).toEqual({ kind: "diffUnreadable" });
  });

  it("surfaces a failed write rather than swallowing it", async () => {
    const bridge = makeBridge({
      saveReviewJson: vi.fn().mockResolvedValue({ ok: false, failure: { code: "writeFailed" } }),
    });
    vi.stubGlobal("window", { reviewer: bridge });
    seed(ORIGIN);

    await useReviewStore.getState().exportReviewJson();

    expect(useReviewStore.getState().reviewExportFailure).toEqual({
      kind: "write",
      failure: { code: "writeFailed" },
    });

    // A subsequent successful (canceled) export clears the stale failure.
    await useReviewStore.getState().exportReviewMarkdown();
    expect(useReviewStore.getState().reviewExportFailure).toBeNull();
  });
});

// The exit gate: the open→anchor→step→round-trip path composed against the real
// store, import, and serializer seams — proving the pieces cohere on one artifact,
// not merely that each unit works in isolation.
describe("exit gate", () => {
  // One artifact carried through every case: two comments and two ordered layers,
  // each anchored to `src/keep.ts` (a file the drifted re-derive still carries) and
  // `src/gone.ts` (a file it drops), so the same anchors place under a frozen patch
  // and degrade — header-pin and file-absent — under a drifted one.
  const EXIT_ARTIFACT = {
    version: 1,
    source: { kind: "local", repo: { path: "/repo", name: "app" }, base: "main", head: SHA_A },
    comments: [
      { file: "src/keep.ts", side: "additions", startLine: 5, endLine: 6, body: "authored: guard" },
      { file: "src/gone.ts", side: "additions", startLine: 3, endLine: 3, body: "authored: gone" },
    ],
    layers: [
      {
        id: "l1",
        label: "Keep",
        summary: "keep layer",
        kind: "foundation",
        ranges: [{ file: "src/keep.ts", side: "additions", startLine: 5, endLine: 6 }],
      },
      {
        id: "l2",
        label: "Gone",
        summary: "gone layer",
        ranges: [{ file: "src/gone.ts", side: "additions", startLine: 3, endLine: 3 }],
      },
    ],
  };

  // The patch the artifact would embed: both files present with hunks over the
  // authored lines, so every anchor places.
  const FROZEN_PATCH = [
    "diff --git a/src/keep.ts b/src/keep.ts",
    "index 1111111..2222222 100644",
    "--- a/src/keep.ts",
    "+++ b/src/keep.ts",
    "@@ -1,4 +1,7 @@",
    " k1",
    " k2",
    " k3",
    " k4",
    "+k5",
    "+k6",
    "+k7",
    "diff --git a/src/gone.ts b/src/gone.ts",
    "index 3333333..4444444 100644",
    "--- a/src/gone.ts",
    "+++ b/src/gone.ts",
    "@@ -1,2 +1,3 @@",
    " g1",
    " g2",
    "+g3",
    "",
  ].join("\n");

  // The diff a re-derive returns after drift: `keep.ts` survives but its hunk moved
  // off the authored lines (5–6 no longer covered), and `gone.ts` is gone entirely.
  const DRIFTED_PATCH = [
    "diff --git a/src/keep.ts b/src/keep.ts",
    "index 1111111..2222222 100644",
    "--- a/src/keep.ts",
    "+++ b/src/keep.ts",
    "@@ -100,2 +100,3 @@",
    " k100",
    " k101",
    "+k102",
    "",
  ].join("\n");

  function realStamp(): ReviewStamp {
    return { newId: () => randomUUID() };
  }

  function openExit(): ImportedReview {
    const result = importReview(JSON.stringify(EXIT_ARTIFACT), realStamp());
    if (!result.ok) {
      throw new Error("the exit artifact must import cleanly");
    }
    return result.review;
  }

  function seedImportedReview(review: ImportedReview): void {
    const slice: SessionSlice = {
      id: SESSION_ID,
      repo: review.source.repo,
      mode: "commits",
      log: null,
      branches: null,
      brush: null,
      base: null,
      head: null,
      selection: null,
      diff: { phase: "loaded", loadId: 1, files: [] },
      selectedFilePath: null,
      scrollTop: 0,
      commitSelection: null,
      comments: review.comments,
      layers: review.layers,
      reviewDiff: null,
      reviewSubrange: null,
      reviewOrigin: reviewOriginFor(review),
      overview: null,
      overviewOpen: false,
      lastChapterId: null,
      activeLayerId: null,
      activeCommentId: null,
      readFiles: NO_READ_FILES,
      collapsedFiles: NO_COLLAPSED_FILES,
      needsDerive: false,
      requestTicket: 1,
    };
    useReviewStore.setState({
      boot: "ready",
      sessions: { [SESSION_ID]: slice },
      activeSessionId: SESSION_ID,
    });
  }

  function commentAnnotationOn(
    items: ReturnType<typeof buildCommentItems>,
    filePath: string,
  ): { lineNumber: number; slot: CommentSlot } | null {
    const item = items.find((entry) => entry.id === filePath);
    const annotation = (item?.annotations ?? []).find((entry) => entry.metadata.kind === "comment");
    return annotation ? { lineNumber: annotation.lineNumber, slot: annotation.metadata } : null;
  }

  it("round-trips the real open→curate→export→reopen loop on the authored projection", async () => {
    const bridge = makeBridge({});
    vi.stubGlobal("window", { reviewer: bridge });

    // Open: the real import path stamps identity onto the authored comments.
    const opened = openExit();
    seedImportedReview(opened);
    const editId = opened.comments[0]!.id;
    const discardId = opened.comments[1]!.id;

    // Curate through the real store actions — add, edit, discard.
    useReviewStore
      .getState()
      .addComment(
        { file: "src/keep.ts", side: "additions", startLine: 9, endLine: 9 },
        "curated: added",
      );
    useReviewStore.getState().editComment(editId, "curated: edited guard");
    useReviewStore.getState().discardComment(discardId);

    // Export through the real serializer, then re-import the emitted bytes.
    await useReviewStore.getState().exportReviewJson();
    const content = vi.mocked(bridge.saveReviewJson).mock.calls[0]?.[0]?.content ?? "";
    const reopened = importReview(content, realStamp());
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) {
      return;
    }

    const bodies = reopened.review.comments.map((comment) => comment.body);
    expect(bodies).toContain("curated: edited guard"); // the edit survived
    expect(bodies).toContain("curated: added"); // the addition survived
    expect(bodies).not.toContain("authored: gone"); // the discard survived
    expect(bodies).not.toContain("authored: guard"); // the pre-edit body is gone

    // The edited comment kept its authored anchor — only the body changed.
    const edited = reopened.review.comments.find(
      (comment) => comment.body === "curated: edited guard",
    );
    expect(edited).toMatchObject({
      file: "src/keep.ts",
      side: "additions",
      startLine: 5,
      endLine: 6,
    });

    // Layers round-trip verbatim in authored order.
    expect(reopened.review.layers.map((layer) => layer.id)).toEqual(["l1", "l2"]);
    expect(reopened.review.layers.map((layer) => layer.summary)).toEqual([
      "keep layer",
      "gone layer",
    ]);
  });

  it("degrades a drifted refs review: comments header-pin, layers fail soft, none dropped", async () => {
    const review = openExit();
    const bridge = makeBridge({
      getDiff: vi.fn().mockResolvedValue({ ok: true, value: { patch: DRIFTED_PATCH } }),
    });
    await hydrateWith(bridge, {
      sessions: [
        storedSession(ID_A, "/repo", {
          comments: review.comments,
          layers: review.layers,
          reviewOrigin: reviewOriginFor(review),
          reviewDiff: { kind: "refs", base: "main", head: SHA_A },
        }),
      ],
      activeSessionId: ID_A,
    });
    await vi.waitFor(() => {
      expect(slice(ID_A).diff.phase).toBe("loaded");
    });

    const current = slice(ID_A);
    const files = current.diff.phase === "loaded" ? current.diff.files : [];
    const frozen = current.reviewDiff?.kind === "frozenPatch";
    expect(frozen).toBe(false);

    // The comment on the surviving file keeps its authored range but pins to the
    // file header (lineNumber 0), flagged outdated — never misplaced, never dropped.
    const items = buildCommentItems(
      files,
      current.comments,
      { editingId: null, draft: null },
      frozen,
    );
    const keep = commentAnnotationOn(items, "src/keep.ts");
    expect(keep?.lineNumber).toBe(0);
    expect(keep?.slot).toMatchObject({ kind: "comment", outdated: true });
    expect(keep?.slot.kind === "comment" && keep.slot.comment.startLine).toBe(5);
    // The comment on the vanished file has no host item — kept in session, off-surface.
    expect(items.some((entry) => entry.id === "src/gone.ts")).toBe(false);

    // Both layers fail soft on a step (outdated, no throw) yet neither leaves the
    // walkthrough — stepping still visits the full authored order.
    for (const layer of current.layers) {
      expect(resolveLayerScroll(layer, current.layers, files, frozen).kind).toBe("outdated");
    }
    expect(stepLayer(current.layers, null, 1)).toBe("l1");
    expect(stepLayer(current.layers, "l1", 1)).toBe("l2");
  });

  it("places every anchor of the same artifact when it embeds a frozen patch, none outdated", async () => {
    const review = openExit();
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [
        storedSession(ID_A, "/repo", {
          comments: review.comments,
          layers: review.layers,
          reviewOrigin: reviewOriginFor(review),
          reviewDiff: { kind: "frozenPatch", patch: FROZEN_PATCH },
        }),
      ],
      activeSessionId: ID_A,
    });
    await vi.waitFor(() => {
      expect(slice(ID_A).diff.phase).toBe("loaded");
    });

    const current = slice(ID_A);
    const files = current.diff.phase === "loaded" ? current.diff.files : [];
    const frozen = current.reviewDiff?.kind === "frozenPatch";
    expect(frozen).toBe(true);
    // A frozen review renders its own patch, off git entirely.
    expect(bridge.getDiff).not.toHaveBeenCalled();

    // Every comment places on its authored line, none outdated.
    const items = buildCommentItems(
      files,
      current.comments,
      { editingId: null, draft: null },
      frozen,
    );
    const keep = commentAnnotationOn(items, "src/keep.ts");
    const gone = commentAnnotationOn(items, "src/gone.ts");
    expect(keep).toMatchObject({ lineNumber: 5, slot: { outdated: false } });
    expect(gone).toMatchObject({ lineNumber: 3, slot: { outdated: false } });

    // Every layer's first range places too — the layer surface agrees with the
    // comment surface under a frozen patch.
    for (const layer of current.layers) {
      expect(resolveLayerScroll(layer, current.layers, files, frozen).kind).toBe("placed");
    }
  });

  it("surfaces a vanished repo as a typed failure in that review's view, siblings unaffected", async () => {
    const bridge = makeBridge({
      getDiff: vi
        .fn()
        .mockImplementation(({ repoPath }: { repoPath: string }) =>
          Promise.resolve(
            repoPath === "/repo-a"
              ? { ok: false, failure: { code: "notARepo", path: repoPath } }
              : { ok: true, value: { patch: MULTI_STATUS_PATCH } },
          ),
        ),
    });
    await hydrateWith(bridge, {
      sessions: [
        storedSession(ID_A, "/repo-a", { reviewDiff: { kind: "refs", base: "main", head: SHA_A } }),
        storedSession(ID_B, "/repo-b", { reviewDiff: { kind: "refs", base: "main", head: SHA_B } }),
      ],
      activeSessionId: ID_A,
    });

    // The vanished repo's review lands in a typed failure — not a crash, not a drop.
    await vi.waitFor(() => {
      expect(slice(ID_A).diff).toEqual({
        phase: "failed",
        failure: { code: "notARepo", path: "/repo-a" },
      });
    });

    // Its sibling review derives cleanly and stays healthy.
    useReviewStore.getState().activateSession(ID_B);
    await vi.waitFor(() => {
      expect(slice(ID_B).diff.phase).toBe("loaded");
    });
    expect(slice(ID_A).diff).toEqual({
      phase: "failed",
      failure: { code: "notARepo", path: "/repo-a" },
    });
  });
});

describe("reading progress", () => {
  const layers: ReviewLayer[] = [
    {
      id: "greeting",
      label: "Greeting",
      summary: "s",
      ranges: [
        { file: "greet.ts", side: "additions", startLine: 4, endLine: 6 },
        { file: "added.txt", side: "additions", startLine: 1, endLine: 1 },
      ],
    },
    {
      id: "notes",
      label: "Notes",
      summary: "s",
      ranges: [{ file: "notes.txt", side: "additions", startLine: 6, endLine: 6 }],
    },
  ];

  beforeEach(() => {
    const files = parsePatch(MULTI_STATUS_PATCH, "read-test");
    const seeded: SessionSlice = {
      id: SESSION_ID,
      repo: { path: "/repo", name: "repo" },
      mode: "commits",
      log: null,
      branches: null,
      brush: null,
      base: null,
      head: null,
      selection: null,
      diff: { phase: "loaded", loadId: 1, files },
      selectedFilePath: "greet.ts",
      scrollTop: 0,
      commitSelection: null,
      comments: [],
      layers,
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
    };
    useReviewStore.setState({
      boot: "ready",
      sessions: { [SESSION_ID]: seeded },
      activeSessionId: SESSION_ID,
    });
  });

  it("marking a file read folds it away, and unmarking opens it back up", () => {
    useReviewStore.getState().setFileRead("greet.ts", true);
    expect([...active().readFiles.keys()]).toEqual(["greet.ts"]);
    expect(active().collapsedFiles.has("greet.ts")).toBe(true);

    useReviewStore.getState().setFileRead("greet.ts", false);
    expect(active().readFiles.size).toBe(0);
    expect(active().collapsedFiles.has("greet.ts")).toBe(false);
  });

  it("folding a file by hand leaves the read mark alone, either way round", () => {
    useReviewStore.getState().setFileCollapsed("greet.ts", true);
    expect(active().readFiles.size).toBe(0);

    useReviewStore.getState().setFileRead("greet.ts", true);
    useReviewStore.getState().setFileCollapsed("greet.ts", false);
    expect(active().collapsedFiles.has("greet.ts")).toBe(false);
    expect([...active().readFiles.keys()]).toEqual(["greet.ts"]);
  });

  it("`r` flips the focused file when no path is named", () => {
    useReviewStore.getState().toggleFileRead();
    expect([...active().readFiles.keys()]).toEqual(["greet.ts"]);
    useReviewStore.getState().toggleFileRead();
    expect(active().readFiles.size).toBe(0);
  });

  it("marks a whole layer's extent, and only the files the diff carries", () => {
    useReviewStore.getState().setLayerRead("greeting", true);
    expect([...active().readFiles.keys()].sort()).toEqual(["added.txt", "greet.ts"]);
    expect(active().collapsedFiles.has("notes.txt")).toBe(false);
  });

  it("clearing is scoped to the paths it was given", () => {
    useReviewStore.getState().setLayerRead("greeting", true);
    useReviewStore.getState().setLayerRead("notes", true);
    useReviewStore.getState().clearFilesRead(["greet.ts"]);
    expect([...active().readFiles.keys()].sort()).toEqual(["added.txt", "notes.txt"]);
  });

  it("never schedules a write-back: progress is view state, not session input", () => {
    const bridge = makeBridge({});
    vi.stubGlobal("window", { reviewer: bridge });
    useReviewStore.getState().setFileRead("greet.ts", true);
    useReviewStore.getState().setLayerRead("greeting", true);
    useReviewStore.getState().flushWriteBacks();
    expect(bridge.updateSession).not.toHaveBeenCalled();
  });

  it("a path the loaded diff does not carry is a no-op, never a mark for nothing", () => {
    const before = active().readFiles;
    useReviewStore.getState().setFileRead("nope.ts", true);
    expect(active().readFiles).toBe(before);
  });

  it("focusing a comment opens the file it lives in, so its card is on the surface", () => {
    const comment: Comment = {
      id: ID_A,
      file: "greet.ts",
      side: "additions",
      startLine: 4,
      endLine: 4,
      body: "b",
    };
    patchActive({ comments: [comment] });
    useReviewStore.getState().setFileRead("greet.ts", true);
    expect(active().collapsedFiles.has("greet.ts")).toBe(true);

    useReviewStore.getState().focusComment(ID_A);
    expect(active().collapsedFiles.has("greet.ts")).toBe(false);
    // The mark itself survives: reading a finding again is not un-reading the file.
    expect(active().readFiles.has("greet.ts")).toBe(true);
  });
});
