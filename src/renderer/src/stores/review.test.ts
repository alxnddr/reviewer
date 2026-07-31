import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchName, DiffResponse, LogEntry } from "../../../shared/git";
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
import { buildCommentItems, type CommentSlot } from "../../../shared/diff/comment-annotations";
import { MULTI_STATUS_PATCH } from "../../../shared/diff/fixtures";
import { parsePatch } from "../../../shared/diff/patch";
import { NO_PROGRESS } from "../../../shared/review-progress";
import { resolveLayerScroll, stepLayer } from "../../../shared/layers";
import { UNCOVERED_LAYER_ID } from "../lib/coverage";
import { createScrollCapture, SCROLL_CAPTURE_DEBOUNCE_MS } from "../lib/scroll";
import {
  BRANCH_LIST,
  commitEntry,
  DIRTY_ENTRIES,
  makeBridge,
  SESSION_ID,
  SHA_A,
  SHA_B,
} from "./__fixtures__/bridge";
import {
  createReviewStore,
  createSessionSlice,
  WRITE_BACK_DEBOUNCE_MS,
  type ReviewStore,
  type SessionSlice,
} from "./review";

const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ID_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/** What every hand-seeded slice below shares, and the one place it differs from
 * `createSessionSlice`'s defaults: these stand in for a session that has already been through
 * `deriveSession`, so nothing re-derives underneath the action being tested, and the ticket is
 * past zero so a response carrying the initial one would read as the stale thing it is. */
const DERIVED = { needsDerive: false, requestTicket: 1 } satisfies Partial<SessionSlice>;

/** The store under test: a fresh instance per case, so nothing — not a slice, not a pending
 * write-back, not a start tab counter — can travel from one test to the next. */
let store: ReviewStore;

function active(): SessionSlice {
  const state = store.getState();
  if (state.activeSessionId === null) {
    throw new Error("no active session");
  }
  const found = state.sessions[state.activeSessionId];
  if (found === undefined) {
    throw new Error("active session id names no slice");
  }
  return found;
}

function slice(id: string): SessionSlice {
  const found = store.getState().sessions[id];
  if (found === undefined) {
    throw new Error(`no slice for ${id}`);
  }
  return found;
}

/** Arrange the active slice directly, for the fields nothing but a load or an import ever
 * writes — the diff, the layers, the comment list. Anything an action owns is arranged
 * *through* that action instead (see `setActiveLayer` below), or the test writes around the
 * code it is supposed to be covering. */
function patchActive(partial: Partial<SessionSlice>): void {
  const state = store.getState();
  const current = active();
  store.setState({
    sessions: { ...state.sessions, [current.id]: { ...current, ...partial } },
  });
}

async function openFixtureRepo(bridge: ReviewerBridge): Promise<void> {
  vi.stubGlobal("window", { reviewer: bridge });
  await store.getState().openRepository();
}

function storedSession(id: string, repoPath: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    source: { kind: "local", repo: { path: repoPath, name: repoPath.slice(1) } },
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
      repo: { path: repoPath, name: repoPath.slice(1) },
      base,
      head,
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
      repo: { path: repoPath, name: repoPath.slice(1) },
      base: "main",
      head: SHA_A,
      patch,
    },
  });
}

async function hydrateWith(bridge: ReviewerBridge, snapshot: SessionSnapshot): Promise<void> {
  vi.mocked(bridge.listSessions).mockResolvedValue(snapshot);
  vi.stubGlobal("window", { reviewer: bridge });
  store.setState({ boot: "pending" });
  await store.getState().hydrate();
}

function totalBridgeCalls(bridge: ReviewerBridge): number {
  return Object.values(bridge).reduce(
    (sum, member) => sum + (vi.isMockFunction(member) ? member.mock.calls.length : 0),
    0,
  );
}

beforeEach(() => {
  store = createReviewStore();
});
afterEach(() => {
  // The instance this test ran on is finished with, so its pending write-backs are dropped
  // rather than sent: a debounce timer surviving the test would fire half a second later
  // against whatever `window` the *next* one installed. Nothing else needs undoing — the store
  // is thrown away here, not reset, so no field can be forgotten.
  store.getState().cancelWriteBacks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useReviewStore.openRepository", () => {
  it("loads log and branches, brushes the newest entry, and renders its diff", async () => {
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);

    const state = active();
    expect(state.repo).toEqual({ path: "/repo", name: "repo" });
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
    expect(store.getState().activeSessionId).toBe(SESSION_ID);
  });

  it("opens on the checked-out branch's own history, with no comparison asked for", async () => {
    await openFixtureRepo(makeBridge({}));

    // A comparison is something the reviewer asks for; a fresh session just reads the
    // branch it is standing on.
    expect(active().base).toBeNull();
    expect(active().head).toBe("feature/x");
  });

  it("stays session-less when the dialog is canceled", async () => {
    await openFixtureRepo(
      makeBridge({
        openRepo: vi.fn().mockResolvedValue({ ok: true, value: { kind: "canceled" } }),
      }),
    );

    expect(store.getState().sessions).toEqual({});
    expect(store.getState().activeSessionId).toBeNull();
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

    expect(store.getState().sessions).toEqual({});
    expect(store.getState().openFailure).toEqual({ code: "gitMissing" });
  });

  it("a failed open with a session active stays app-level and leaves the slice untouched", async () => {
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);
    const before = active();

    vi.mocked(bridge.openRepo).mockResolvedValue({
      ok: false,
      failure: { code: "notARepo", path: "/picked" },
    });
    await store.getState().openRepository();

    expect(store.getState().openFailure).toEqual({ code: "notARepo", path: "/picked" });
    expect(active()).toBe(before);
  });

  it("does nothing without the bridge (browser gate run)", async () => {
    vi.stubGlobal("window", {});

    await store.getState().openRepository();

    expect(store.getState().sessions).toEqual({});
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
    const first = store.getState().openRepository();

    vi.mocked(bridge.openRepo).mockResolvedValue({ ok: true, value: { kind: "canceled" } });
    await store.getState().openRepository();

    resolveLog({ ok: true, value: { entries: DIRTY_ENTRIES } });
    await first;

    expect(active().diff.phase).toBe("loaded");
  });
});

describe("brush selection driving the diff", () => {
  it("extending the brush requests the commitRangeWithUncommitted span", async () => {
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);

    store.getState().applyBrush({ type: "extend", index: 1 });
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

    store.getState().applyBrush({ type: "set", index: 1 });
    store.getState().applyBrush({ type: "extend", index: 2 });
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

    store.getState().previewBrush({ type: "extend", index: 2 });
    expect(active().brush).toEqual({ anchor: 0, focus: 2 });
    expect(vi.mocked(bridge.getDiff).mock.calls.length).toBe(callsAfterOpen);

    store.getState().commitBrush();
    await vi.waitFor(() => {
      expect(vi.mocked(bridge.getDiff).mock.calls.length).toBe(callsAfterOpen + 1);
    });
  });

  it("re-selecting the already-loaded range does not refetch", async () => {
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);
    const callsAfterOpen = vi.mocked(bridge.getDiff).mock.calls.length;

    store.getState().applyBrush({ type: "set", index: 0 });
    await Promise.resolve();

    expect(vi.mocked(bridge.getDiff).mock.calls.length).toBe(callsAfterOpen);
  });

  it("a keypress the brush cannot answer persists nothing", async () => {
    vi.useFakeTimers();
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);
    await vi.advanceTimersByTimeAsync(WRITE_BACK_DEBOUNCE_MS);
    const writesAfterOpen = vi.mocked(bridge.updateSession).mock.calls.length;

    // The brush opens on the newest row, so every ArrowUp — the first press and every
    // repeat after it — lands here. `runDiffLoad`'s sameSelection guard absorbs the
    // refetch; an unguarded commit would still queue an IPC write-back per keypress.
    store.getState().applyBrush({ type: "step", direction: -1, extend: false });
    await vi.advanceTimersByTimeAsync(WRITE_BACK_DEBOUNCE_MS);

    expect(vi.mocked(bridge.updateSession).mock.calls.length).toBe(writesAfterOpen);
  });

  it("a vanished repo surfaces as a typed failure on the next selection", async () => {
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);
    vi.mocked(bridge.getDiff).mockResolvedValue({
      ok: false,
      failure: { code: "notARepo", path: "/repo" },
    });

    store.getState().applyBrush({ type: "extend", index: 1 });
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

    store.getState().applyBrush({ type: "extend", index: 2 });
    await vi.waitFor(() => {
      expect(active().diff).toEqual({
        phase: "failed",
        failure: { code: "unknownRevision" },
      });
    });
  });
});

describe("the picker's two refs", () => {
  it("walks that branch's own history — no base, so it is a history and not a comparison", async () => {
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);

    store.getState().setHead("main");
    await vi.waitFor(() => {
      expect(bridge.getCommitLog).toHaveBeenLastCalledWith({
        repoPath: "/repo",
        range: { base: null, head: "main" },
      });
    });
    expect(active().head).toBe("main");
  });

  it("lands the brush on the newest commit of the branch it just listed", async () => {
    const bridge = makeBridge({
      // Another branch's log: none of the session's current selection is in it.
      getCommitLog: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, value: { entries: DIRTY_ENTRIES } })
        .mockResolvedValue({ ok: true, value: { entries: [commitEntry("c".repeat(40))] } }),
    });
    await openFixtureRepo(bridge);

    store.getState().setHead("main");
    await vi.waitFor(() => {
      expect(active().selection).toEqual({
        kind: "commitRange",
        first: "c".repeat(40),
        last: "c".repeat(40),
      });
    });
  });

  it("applies only the newest walk when two land on the same pair of endpoints", async () => {
    const walks: ((value: unknown) => void)[] = [];
    const bridge = makeBridge({
      getCommitLog: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, value: { entries: DIRTY_ENTRIES } })
        .mockImplementation(
          () =>
            new Promise((resolve) => {
              walks.push(resolve);
            }),
        ),
    });
    await openFixtureRepo(bridge);

    // main → feature/x → main, all three faster than git answers. The first and third
    // walks are for the same endpoints, so comparing `head`/`base` cannot tell them apart —
    // only the ticket can, and without it the first would win by resolving last.
    store.getState().setHead("main");
    store.getState().setHead("feature/x");
    store.getState().setHead("main");
    expect(walks).toHaveLength(3);

    const newest = [commitEntry("c".repeat(40))];
    walks[2]?.({ ok: true, value: { entries: newest } });
    await vi.waitFor(() => {
      expect(active().log).toEqual({ phase: "loaded", entries: newest });
    });

    walks[0]?.({ ok: true, value: { entries: [commitEntry("d".repeat(40))] } });
    // A macrotask, so every continuation the resolution queued has had its turn.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(active().log).toEqual({ phase: "loaded", entries: newest });
  });

  it("persists the listed branch, so a restored session re-locates its own selection", async () => {
    vi.useFakeTimers();
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);

    store.getState().setHead("main");
    await vi.waitFor(() => expect(active().head).toBe("main"));
    await vi.advanceTimersByTimeAsync(WRITE_BACK_DEBOUNCE_MS);
    expect(bridge.updateSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ head: "main" }),
    );
  });

  it("is not offered to a review session, whose list is the review's own range", async () => {
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);
    const id = store.getState().activeSessionId as string;
    store.setState({
      sessions: {
        ...store.getState().sessions,
        [id]: {
          ...(store.getState().sessions[id] as SessionSlice),
          reviewOrigin: {
            repo: { path: "/repo", name: "repo" },
            base: "a",
            head: "b",
            patch: null,
          },
        },
      },
    });

    store.getState().setHead("main");
    expect(active().head).not.toBe("main");
  });
});

describe("a comparison driving the diff", () => {
  it("setting a base asks for base...head over the branch being listed", async () => {
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);

    store.getState().setBase("main");
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
    store.getState().setBase("main");
    await vi.waitFor(() => {
      expect(active().diff.phase).toBe("loaded");
    });

    store.getState().swapBranches();
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

    store.getState().setBase("main");
    await vi.waitFor(() => {
      expect(active().diff.phase).toBe("empty");
    });
  });

  it("a failed branch listing costs the comparison, not the commit list", async () => {
    const bridge = makeBridge({
      listBranches: vi.fn().mockResolvedValue({ ok: false, failure: { code: "timeout" } }),
    });
    await openFixtureRepo(bridge);

    // With no refs to pick from there is nothing to compare *to* — but the log still
    // walked HEAD, so the picker keeps working and the diff keeps loading. The failure
    // is reported where the refs would have been, not in place of the whole panel.
    expect(active().branches).toEqual({ phase: "failed", failure: { code: "timeout" } });
    expect(active().diff.phase).toBe("loaded");
    expect(active().selection).toEqual({ kind: "uncommitted" });
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
    // The pinned refs drive the diff request as a reviewRefs selection — the picker's
    // own refs stay where they were seeded, never carrying the review's sha.
    expect(bridge.getDiff).toHaveBeenCalledWith({
      repoPath: "/repo-a",
      selection: { kind: "reviewRefs", base: "main", head: SHA_A },
    });
    expect(slice(ID_A).selection).toEqual({ kind: "reviewRefs", base: "main", head: SHA_A });
    expect(slice(ID_A).base).toBeNull();
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

  it("asks git nothing at all for a frozen review — not even its log or branches", async () => {
    // A frozen artifact is not backed by a repo that has to exist: emitted on a CI runner,
    // its `repo` is a checkout path that means nothing on this machine. The diff comes out of
    // the file, and the two things the derivation would otherwise ask git for are things a
    // frozen review has no use for — the commit brush is replaced by a note, and the branch
    // picker is not its picker. Asking anyway is how such an artifact used to open with two
    // failed panels beside a diff that rendered perfectly.
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [frozenReviewSession(ID_A, "/nonexistent/ci/workspace", MULTI_STATUS_PATCH)],
      activeSessionId: ID_A,
    });

    await vi.waitFor(() => {
      expect(slice(ID_A).diff.phase).toBe("loaded");
    });
    expect(bridge.getCommitLog).not.toHaveBeenCalled();
    expect(bridge.listBranches).not.toHaveBeenCalled();
    expect(bridge.getDiff).not.toHaveBeenCalled();
    // Left null — the same "never asked" they hold before any derivation — rather than a
    // `failed` phase, which would invite a retry of a question with no answer.
    expect(slice(ID_A).log).toBeNull();
    expect(slice(ID_A).branches).toBeNull();
  });

  it("still derives log and branches for a refs review, which does need its repo", async () => {
    // The guard above must key on the frozen pin, not on being a review: a refs review
    // re-derives its diff from git and lists its own base..head commits.
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [refsReviewSession(ID_A, "/repo-a", "main", SHA_A)],
      activeSessionId: ID_A,
    });

    await vi.waitFor(() => {
      expect(slice(ID_A).diff.phase).toBe("loaded");
    });
    expect(bridge.getCommitLog).toHaveBeenCalledTimes(1);
    expect(bridge.listBranches).toHaveBeenCalledTimes(1);
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
    store.getState().applyBrush({ type: "set", index: 0 });
    await vi.waitFor(() => {
      expect(slice(ID_A).selection).toEqual({ kind: "commitRange", first: SHA_A, last: SHA_A });
    });
    // The pin is kept — narrowing never leaves the review — and the subrange persists.
    expect(slice(ID_A).reviewDiff).toEqual({ kind: "refs", base: "main", head: SHA_A });
    expect(slice(ID_A).reviewSubrange).toEqual({ kind: "commitRange", first: SHA_A, last: SHA_A });
    expect(slice(ID_A).commitSelection).toBeNull();

    // Reset returns to the whole review: no subrange, the diff back on the pinned refs.
    store.getState().resetReviewSubrange();
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
    const seeded = createSessionSlice(
      { id: SESSION_ID, repo: { path: "/repo", name: "repo" } },
      {
        ...DERIVED,
        diff: { phase: "loaded", loadId: 1, files },
        selectedFilePath: files[0]?.path ?? null,
      },
    );
    store.setState({
      boot: "ready",
      sessions: { [SESSION_ID]: seeded },
      activeSessionId: SESSION_ID,
      tabs: [{ kind: "session", id: SESSION_ID }],
    });
  });

  it("steps forward and back through the changed files", () => {
    store.getState().selectAdjacentFile(1);
    expect(active().selectedFilePath).toBe("doomed.txt");
    store.getState().selectAdjacentFile(-1);
    expect(active().selectedFilePath).toBe("added.txt");
  });

  it("clamps at both ends", () => {
    store.getState().selectAdjacentFile(-1);
    expect(active().selectedFilePath).toBe("added.txt");
    patchActive({ selectedFilePath: "notes.txt" });
    store.getState().selectAdjacentFile(1);
    expect(active().selectedFilePath).toBe("notes.txt");
  });

  it("ignores navigation while no diff is loaded", () => {
    patchActive({ diff: { phase: "loading" }, selectedFilePath: null });
    store.getState().selectAdjacentFile(1);
    expect(active().selectedFilePath).toBeNull();
  });

  it("steps only the visible (soloed) file set, like the comment walk", () => {
    // greet.ts and notes.txt, with three hidden files between them and added.txt.
    const solo: ReviewLayer[] = [
      {
        id: "two-files",
        label: "Two files",
        summary: "greet and notes",
        ranges: [
          { file: "greet.ts", side: "additions", startLine: 1, endLine: 1 },
          { file: "notes.txt", side: "additions", startLine: 1, endLine: 1 },
        ],
      },
    ];
    // The solo is arranged through the action that arranges it in the app, so a regression in
    // `setActiveLayer` fails here too rather than being written around.
    patchActive({ layers: solo, selectedFilePath: "added.txt" });
    store.getState().setActiveLayer("two-files");
    // From a file the solo hides, forward lands on the layer's first — never on doomed.txt,
    // which is next in the full diff and absent from the screen.
    store.getState().selectAdjacentFile(1);
    expect(active().selectedFilePath).toBe("greet.ts");
    store.getState().selectAdjacentFile(1);
    expect(active().selectedFilePath).toBe("notes.txt");
    // And it clamps at the layer's last file rather than walking out the far side of it.
    store.getState().selectAdjacentFile(1);
    expect(active().selectedFilePath).toBe("notes.txt");
  });
});

describe("setSlice's structural no-op guard", () => {
  beforeEach(() => {
    const seeded = createSessionSlice(
      { id: SESSION_ID, repo: { path: "/repo", name: "repo" } },
      {
        ...DERIVED,
        diff: { phase: "loading" },
        selectedFilePath: "greet.ts",
        scrollTop: 40,
      },
    );
    store.setState({
      boot: "ready",
      sessions: { [SESSION_ID]: seeded },
      activeSessionId: SESSION_ID,
      tabs: [{ kind: "session", id: SESSION_ID }],
    });
  });

  // `selectFile` and `setScrollTop` write unconditionally -- neither checks its argument
  // against the slice's current value the way `previewBrush`/`setFileCollapsed` do. The
  // guard lives in `setSlice` itself instead, so it protects every action funnelled through
  // it, including these two: a redundant call never reallocates the `sessions` record, which
  // is what a subscriber like `TabBar` (keyed off the record) would otherwise re-render on.

  it("re-selecting the already-selected file leaves the sessions record untouched", () => {
    const before = store.getState().sessions;
    store.getState().selectFile("greet.ts");
    expect(store.getState().sessions).toBe(before);
  });

  it("selecting a different file still writes", () => {
    const before = store.getState().sessions;
    store.getState().selectFile("other.ts");
    expect(store.getState().sessions).not.toBe(before);
    expect(active().selectedFilePath).toBe("other.ts");
  });

  it("re-reporting the same scroll position leaves the sessions record untouched", () => {
    const before = store.getState().sessions;
    store.getState().setScrollTop(40);
    expect(store.getState().sessions).toBe(before);
  });

  it("a genuinely new scroll position still writes", () => {
    const before = store.getState().sessions;
    store.getState().setScrollTop(80);
    expect(store.getState().sessions).not.toBe(before);
    expect(active().scrollTop).toBe(80);
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

    expect(store.getState().boot).toBe("ready");
    expect(bridge.getCommitLog).toHaveBeenCalledTimes(1);
    expect(bridge.getCommitLog).toHaveBeenCalledWith({ repoPath: "/repo-b", range: null });
    expect(bridge.listBranches).toHaveBeenCalledTimes(1);
    expect(bridge.getDiff).toHaveBeenCalledTimes(1);
    expect(slice(ID_B).diff.phase).toBe("loaded");
    expect(slice(ID_A).diff.phase).toBe("idle");
    expect(slice(ID_C).diff.phase).toBe("idle");

    store.getState().activateSession(ID_A);
    await vi.waitFor(() => {
      expect(slice(ID_A).diff.phase).toBe("loaded");
    });
    expect(bridge.getCommitLog).toHaveBeenCalledTimes(2);
    expect(bridge.getCommitLog).toHaveBeenLastCalledWith({ repoPath: "/repo-a", range: null });

    store.getState().activateSession(ID_B);
    store.getState().activateSession(ID_A);
    expect(bridge.getCommitLog).toHaveBeenCalledTimes(2);
    expect(bridge.listBranches).toHaveBeenCalledTimes(2);
    expect(bridge.getDiff).toHaveBeenCalledTimes(2);
  });

  it("hydration restores the picker's refs, file, and scroll into the slice", async () => {
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [
        storedSession(ID_A, "/repo-a", {
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

    store.getState().activateSession(ID_B);
    await vi.waitFor(() => {
      expect(slice(ID_B).diff.phase).toBe("loaded");
    });
    expect(slice(ID_A)).toBe(before);

    const callsBeforeReturn = totalBridgeCalls(bridge);
    store.getState().activateSession(ID_A);

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

    store.getState().applyBrush({ type: "extend", index: 1 });
    expect(slice(ID_A).diff.phase).toBe("loading");

    store.getState().activateSession(ID_B);
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
    expect(store.getState().activeSessionId).toBe(ID_B);
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

    store.getState().activateSession(ID_B);
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
    store.setState({ boot: "pending" });
    const hydration = store.getState().hydrate();
    await vi.waitFor(() => {
      expect(slice(ID_A).log).toEqual({ phase: "loading" });
    });

    store.getState().setBase("main");

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
    store.getState().activateSession(otherSession.id);
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
        storedSession(ID_A, "/repo-a", { base: "main", head: "feature/x" }),
        storedSession(ID_B, "/repo-b", { base: "main", head: "feature/gone" }),
      ],
      activeSessionId: ID_B,
    });

    await vi.waitFor(() => {
      expect(slice(ID_B).diff).toEqual({ phase: "failed", failure: { code: "unknownRevision" } });
    });

    store.getState().activateSession(ID_A);
    await vi.waitFor(() => {
      expect(slice(ID_A).diff.phase).toBe("loaded");
    });
    // The broken tab is shown broken, never silently dropped; the sibling
    // restores healthy on its own first activation.
    expect(store.getState().sessions[ID_B]).toBeDefined();
  });

  it("recovers the active tab when a salvaged store kept sessions but nulled the pointer", async () => {
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [storedSession(ID_A, "/repo-a"), storedSession(ID_B, "/repo-b")],
      activeSessionId: null,
    });

    // Lands on the first surviving tab instead of the empty state behind a
    // populated strip; only that tab derives, so bounded boot still holds.
    expect(store.getState().activeSessionId).toBe(ID_A);
    expect(slice(ID_A).diff.phase).toBe("loaded");
    expect(slice(ID_B).diff.phase).toBe("idle");
    expect(bridge.getCommitLog).toHaveBeenCalledTimes(1);
    expect(bridge.getCommitLog).toHaveBeenCalledWith({ repoPath: "/repo-a", range: null });

    // The recovered pointer heals main's null on the debounced write-back.
    store.getState().flushWriteBacks();
    expect(bridge.setActiveSession).toHaveBeenCalledWith({ id: ID_A });
  });

  it("keeps a review pushed mid-hydration instead of losing it to the boot snapshot", async () => {
    const bridge = makeBridge({});
    let resolveBootList: (snapshot: SessionSnapshot) => void = () => {};
    // The boot round-trip is held open, and only it: anything listed afterwards sees main's
    // newer state, the CLI's session included.
    vi.mocked(bridge.listSessions)
      .mockImplementationOnce(
        () =>
          new Promise<SessionSnapshot>((resolve) => {
            resolveBootList = resolve;
          }),
      )
      .mockResolvedValue({
        sessions: [storedSession(ID_A, "/repo-a"), storedSession(ID_B, "/repo-b")],
        activeSessionId: ID_B,
      });
    vi.stubGlobal("window", { reviewer: bridge });
    store.setState({ boot: "pending" });

    const hydration = store.getState().hydrate();
    // `rvw emit` while the app is still launching: main wrote the session and pushed
    // `sessions:changed` before hydrate's `sessions:list` came back.
    const sync = store.getState().syncSessions();
    resolveBootList({ sessions: [storedSession(ID_A, "/repo-a")], activeSessionId: ID_A });
    await Promise.all([hydration, sync]);

    // The pushed review is here on the first push — the older snapshot landing late must not
    // rebuild the strip without it.
    expect(Object.keys(store.getState().sessions)).toEqual([ID_A, ID_B]);
    expect(store.getState().tabs).toEqual([
      { kind: "session", id: ID_A },
      { kind: "session", id: ID_B },
    ]);
    expect(store.getState().activeSessionId).toBe(ID_B);
    expect(store.getState().boot).toBe("ready");
    // The push re-listed rather than being dropped, and the review it carried is *shown*, not
    // merely in the strip — a guard that returned early would leave both of these behind.
    expect(bridge.listSessions).toHaveBeenCalledTimes(2);
    expect(slice(ID_B).diff.phase).toBe("loaded");
    // And boot's own derivation, in flight across the re-list's wholesale `set`, still lands:
    // waiting only for the restore is safe because the rebuild keeps live slices by identity.
    expect(slice(ID_A).log).toEqual({ phase: "loaded", entries: DIRTY_ENTRIES });
    expect(slice(ID_A).diff.phase).toBe("loaded");
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

    store.getState().closeSession();

    expect(bridge.deleteSession).toHaveBeenCalledWith({ id: ID_B });
    expect(store.getState().sessions[ID_B]).toBeUndefined();
    expect(store.getState().activeSessionId).toBe(ID_C);
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

    store.getState().closeSession(ID_B);

    expect(store.getState().activeSessionId).toBe(ID_A);
  });

  it("closing the last tab lands on the empty state", async () => {
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [storedSession(ID_A, "/repo-a")],
      activeSessionId: ID_A,
    });

    store.getState().closeSession();

    // What App renders as the start screen: a settled boot with no sessions.
    expect(store.getState().boot).toBe("ready");
    expect(store.getState().sessions).toEqual({});
    expect(store.getState().activeSessionId).toBeNull();
    expect(bridge.deleteSession).toHaveBeenCalledWith({ id: ID_A });
  });

  it("closing a background tab leaves the active slice and pointer untouched", async () => {
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [storedSession(ID_A, "/repo-a"), storedSession(ID_B, "/repo-b")],
      activeSessionId: ID_A,
    });
    const activeBefore = slice(ID_A);

    store.getState().closeSession(ID_B);

    expect(bridge.deleteSession).toHaveBeenCalledWith({ id: ID_B });
    expect(store.getState().activeSessionId).toBe(ID_A);
    expect(slice(ID_A)).toBe(activeBefore);
    expect(bridge.setActiveSession).not.toHaveBeenCalled();
  });

  it("a write-back pending for a closed session is flushed before the delete, not dropped", async () => {
    vi.useFakeTimers();
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);

    store.getState().setScrollTop(300);
    store.getState().closeSession();

    // Sent synchronously, inside the close, rather than left to a debounce that would land on
    // a session main has already dropped. Everything on this session dies with the tab except
    // its read progress, which main mirrors to the review's own record on the way past — so
    // the last half-second of reading is exactly what must not be thrown away here.
    expect(bridge.updateSession).toHaveBeenCalledTimes(1);
    expect(bridge.updateSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: SESSION_ID, scrollTop: 300 }),
    );
    expect(bridge.deleteSession).toHaveBeenCalledWith({ id: SESSION_ID });

    // And nothing more once the window it was scheduled in elapses: the pending timer was
    // consumed by the flush, not left to fire a second, now-stale update.
    await vi.advanceTimersByTimeAsync(WRITE_BACK_DEBOUNCE_MS);
    expect(bridge.updateSession).toHaveBeenCalledTimes(1);
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

    await store.getState().openRepository();

    expect(bridge.createSession).not.toHaveBeenCalled();
    expect(store.getState().activeSessionId).toBe(ID_A);
    expect(Object.keys(store.getState().sessions)).toEqual([ID_A, ID_B]);
    // Re-activation is a first activation for this restored tab: it derives.
    await vi.waitFor(() => {
      expect(slice(ID_A).diff.phase).toBe("loaded");
    });
  });

  it("a duplicate open clears a lingering open failure", async () => {
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);
    store.setState({ openFailure: { code: "gitMissing" } });

    await store.getState().openRepository();

    expect(store.getState().openFailure).toBeNull();
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

    store.getState().activateTabByOrdinal(2);
    expect(store.getState().activeSessionId).toBe(ID_B);

    store.getState().activateTabByOrdinal(9);
    expect(store.getState().activeSessionId).toBe(ID_C);

    store.getState().activateTabByOrdinal(7);
    expect(store.getState().activeSessionId).toBe(ID_C);
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

    store.getState().cycleActiveSession("next");
    expect(store.getState().activeSessionId).toBe(ID_A);

    store.getState().cycleActiveSession("previous");
    expect(store.getState().activeSessionId).toBe(ID_C);

    store.getState().cycleActiveSession("previous");
    expect(store.getState().activeSessionId).toBe(ID_B);
  });
});

describe("start tabs", () => {
  // The strip's `+` (and ⌘T): the start screen as a real tab — several of them if the reader
  // wants, anywhere in the strip, drawn over whatever review is open rather than instead of it.
  // Everything here is about the two rules that follow from "real tab": it stays until it is
  // closed, and the review opened from it takes its slot.

  const startIds = (): string[] =>
    store
      .getState()
      .tabs.filter((stop) => stop.kind === "start")
      .map((stop) => stop.id);

  const strip = (): string[] => store.getState().tabs.map((stop) => `${stop.kind}:${stop.id}`);

  it("goes up over the active session without disturbing it", async () => {
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [storedSession(ID_A, "/repo-a")],
      activeSessionId: ID_A,
    });
    const openBefore = slice(ID_A);

    store.getState().openStartTab();

    expect(store.getState().activeStartTabId).not.toBeNull();
    // The review behind it is still the active one, untouched — leaving the start tab is what
    // returns to it, and it must not have to be re-derived to come back.
    expect(store.getState().activeSessionId).toBe(ID_A);
    expect(slice(ID_A)).toBe(openBefore);
  });

  it("gives a new tab on every press, at the end of the strip", async () => {
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [storedSession(ID_A, "/repo-a")],
      activeSessionId: ID_A,
    });

    store.getState().openStartTab();
    store.getState().openStartTab();
    store.getState().openStartTab();

    const ids = startIds();
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    // Appended, in the order they were opened, after the session.
    expect(strip()).toEqual([`session:${ID_A}`, ...ids.map((id) => `start:${id}`)]);
    // The newest one is the one on screen.
    expect(store.getState().activeStartTabId).toBe(ids.at(-1));
  });

  it("is the whole strip on a machine with no sessions", () => {
    store.getState().openStartTab();
    expect(strip()).toEqual([`start:${startIds()[0]}`]);
  });

  it("stays in the strip when another tab is activated — switching is not closing", async () => {
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [storedSession(ID_A, "/repo-a"), storedSession(ID_B, "/repo-b")],
      activeSessionId: ID_A,
    });

    store.getState().openStartTab();
    const [start] = startIds();
    store.getState().activateSession(ID_B);

    expect(store.getState().activeStartTabId).toBeNull();
    expect(startIds()).toEqual([start]);

    // And it can be gone back to, which is the point of it still being there.
    store.getState().activateStartTab(start as string);
    expect(store.getState().activeStartTabId).toBe(start);
  });

  it("refuses to focus a tab that is not in the strip", () => {
    store.getState().activateStartTab("start-does-not-exist");
    expect(store.getState().activeStartTabId).toBeNull();
  });

  it("is what ⌘W closes while it is focused — the session behind it survives", async () => {
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [storedSession(ID_A, "/repo-a")],
      activeSessionId: ID_A,
    });
    store.getState().openStartTab();

    store.getState().closeSession();

    expect(startIds()).toEqual([]);
    expect(store.getState().activeStartTabId).toBeNull();
    expect(store.getState().sessions[ID_A]).toBeDefined();
    expect(bridge.deleteSession).not.toHaveBeenCalled();
  });

  it("hands the keyboard to its neighbour when the focused one closes", async () => {
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [storedSession(ID_A, "/repo-a"), storedSession(ID_B, "/repo-b")],
      activeSessionId: ID_A,
    });
    store.getState().openStartTab();
    const [start] = startIds();

    store.getState().closeStartTab(start as string);

    // Nothing to its right, so the tab on its left — which is a session, and becomes the
    // surface on screen.
    expect(store.getState().activeStartTabId).toBeNull();
    expect(store.getState().activeSessionId).toBe(ID_B);
  });

  it("stays put when a background tab of either kind is closed", async () => {
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [storedSession(ID_A, "/repo-a"), storedSession(ID_B, "/repo-b")],
      activeSessionId: ID_A,
    });
    store.getState().openStartTab();
    store.getState().openStartTab();
    const [first, second] = startIds();

    // A pointer close names its tab; only the un-named form means "the focused one".
    store.getState().closeSession(ID_B);
    expect(store.getState().activeStartTabId).toBe(second);

    store.getState().closeStartTab(first as string);
    expect(startIds()).toEqual([second]);
    expect(store.getState().activeStartTabId).toBe(second);
    expect(bridge.deleteSession).toHaveBeenCalledWith({ id: ID_B });
  });

  it("survives the last session closing — a strip of one start tab is still a strip", async () => {
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [storedSession(ID_A, "/repo-a")],
      activeSessionId: ID_A,
    });
    store.getState().openStartTab();
    const [start] = startIds();

    store.getState().closeSession(ID_A);

    expect(strip()).toEqual([`start:${start}`]);
  });

  it("is a stop ⌃Tab steps onto and off, wrapping like any other", async () => {
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [storedSession(ID_A, "/repo-a"), storedSession(ID_B, "/repo-b")],
      activeSessionId: ID_B,
    });
    store.getState().openStartTab();
    const [start] = startIds();

    store.getState().cycleActiveSession("next");
    expect(store.getState().activeStartTabId).toBeNull();
    expect(store.getState().activeSessionId).toBe(ID_A);

    // And back onto it from the far end, because it is still there to step onto.
    store.getState().cycleActiveSession("previous");
    expect(store.getState().activeStartTabId).toBe(start);
  });

  it("answers the ⌘-digit for its own position, and ⌘9 when it is last", async () => {
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [storedSession(ID_A, "/repo-a"), storedSession(ID_B, "/repo-b")],
      activeSessionId: ID_A,
    });
    store.getState().openStartTab();
    const [start] = startIds();

    store.getState().activateTabByOrdinal(9);
    expect(store.getState().activeStartTabId).toBe(start);

    // ⌘2 is still the second session, whatever is beyond it.
    store.getState().activateTabByOrdinal(2);
    expect(store.getState().activeStartTabId).toBeNull();
    expect(store.getState().activeSessionId).toBe(ID_B);

    // ⌘3 is this tab's own position.
    store.getState().activateTabByOrdinal(3);
    expect(store.getState().activeStartTabId).toBe(start);
  });

  it("drags anywhere in the strip, and only the session order reaches main", async () => {
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [storedSession(ID_A, "/repo-a"), storedSession(ID_B, "/repo-b")],
      activeSessionId: ID_A,
    });
    store.getState().openStartTab();
    const [start] = startIds();

    // Dropped between the two sessions.
    store.getState().reorderTabs([
      { kind: "session", id: ID_A },
      { kind: "start", id: start as string },
      { kind: "session", id: ID_B },
    ]);

    expect(strip()).toEqual([`session:${ID_A}`, `start:${start}`, `session:${ID_B}`]);
    // Main knows nothing about start tabs, so it hears only about the two sessions.
    expect(bridge.reorderSessions).toHaveBeenCalledWith({ ids: [ID_A, ID_B] });
  });

  it("is replaced in place by the review opened from it", async () => {
    const bridge = makeBridge({
      openReviewByPath: vi.fn().mockResolvedValue({
        ok: true,
        value: { kind: "opened", sessionId: ID_C },
      }),
    });
    await hydrateWith(bridge, {
      sessions: [storedSession(ID_A, "/repo-a"), storedSession(ID_B, "/repo-b")],
      activeSessionId: ID_A,
    });
    // Focused, and dragged into the middle: the slot it holds is the slot the review must land
    // in — a review appearing at the far end while the spent front door stays put is the strip
    // rearranging itself behind the reader.
    store.getState().openStartTab();
    const [start] = startIds();
    store.getState().reorderTabs([
      { kind: "session", id: ID_A },
      { kind: "start", id: start as string },
      { kind: "session", id: ID_B },
    ]);
    vi.mocked(bridge.listSessions).mockResolvedValue({
      sessions: [
        storedSession(ID_A, "/repo-a"),
        storedSession(ID_B, "/repo-b"),
        storedSession(ID_C, "/repo-c"),
      ],
      activeSessionId: ID_C,
    });

    await store.getState().openReviewByPath("/abs/x.reviewer.json");

    expect(strip()).toEqual([`session:${ID_A}`, `session:${ID_C}`, `session:${ID_B}`]);
    expect(store.getState().activeStartTabId).toBeNull();
    expect(store.getState().activeSessionId).toBe(ID_C);
  });

  it("is replaced in place by the repository opened from it", async () => {
    const bridge = makeBridge({});
    vi.stubGlobal("window", { reviewer: bridge });
    store.getState().openStartTab();
    const [start] = startIds();

    await store.getState().openRepository();

    const opened = store.getState().activeSessionId;
    expect(opened).not.toBeNull();
    expect(strip()).toEqual([`session:${opened}`]);
    expect(startIds()).not.toContain(start);
    expect(store.getState().activeStartTabId).toBeNull();
  });

  it("is spent even when the repository it opened was already in a tab", async () => {
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);
    const first = store.getState().activeSessionId;
    store.getState().openStartTab();

    // Same path: one tab per repository, so this re-activates rather than creating one.
    await store.getState().openRepository();

    expect(store.getState().activeSessionId).toBe(first);
    expect(startIds()).toEqual([]);
  });

  it("takes the review that arrives from the CLI while it is focused", async () => {
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [storedSession(ID_A, "/repo-a")],
      activeSessionId: ID_A,
    });
    store.getState().openStartTab();

    // What a CLI publish looks like from here: main wrote a session and pushed; the renderer
    // re-lists and finds a session it has never seen as the active one.
    vi.mocked(bridge.listSessions).mockResolvedValue({
      sessions: [storedSession(ID_A, "/repo-a"), storedSession(ID_B, "/repo-b")],
      activeSessionId: ID_B,
    });
    await store.getState().syncSessions();

    expect(strip()).toEqual([`session:${ID_A}`, `session:${ID_B}`]);
    expect(store.getState().activeStartTabId).toBeNull();
    expect(store.getState().activeSessionId).toBe(ID_B);
  });

  it("survives a review arriving while the reader is on another tab", async () => {
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [storedSession(ID_A, "/repo-a")],
      activeSessionId: ID_A,
    });
    // Parked in the strip, not focused: nothing here is the reader's front door right now, so
    // nothing here may close their tab.
    store.getState().openStartTab();
    const [start] = startIds();
    store.getState().activateSession(ID_A);

    vi.mocked(bridge.listSessions).mockResolvedValue({
      sessions: [storedSession(ID_A, "/repo-a"), storedSession(ID_B, "/repo-b")],
      activeSessionId: ID_B,
    });
    await store.getState().syncSessions();

    expect(startIds()).toEqual([start]);
    expect(store.getState().activeStartTabId).toBeNull();
  });

  it("stays focused through a re-list that changes nothing", async () => {
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [storedSession(ID_A, "/repo-a")],
      activeSessionId: ID_A,
    });
    store.getState().openStartTab();
    const [start] = startIds();

    await store.getState().syncSessions();

    expect(store.getState().activeStartTabId).toBe(start);
    expect(startIds()).toEqual([start]);
  });
});

describe("debounced write-back", () => {
  it("mutating a slice schedules exactly one debounced sessions:update carrying inputs only", async () => {
    vi.useFakeTimers();
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);

    store.getState().setBase("main");
    store.getState().swapBranches();
    expect(bridge.updateSession).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(WRITE_BACK_DEBOUNCE_MS);

    expect(bridge.updateSession).toHaveBeenCalledTimes(1);
    expect(bridge.updateSession).toHaveBeenCalledWith({
      id: SESSION_ID,
      source: { kind: "local", repo: { path: "/repo", name: "repo" } },
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
      reviewPath: null,
      // Progress travels as a record and an array, not the Map and Set the app reads it as —
      // `persistedSession` is the one seam that converts, and this is what comes out of it.
      readFiles: {},
      collapsedFiles: [],
      // The live count off the loaded diff, not the zero this session was created with: a
      // persisted denominator is only useful if it tracks the review it is counting.
      readTotal: 6,
    });
  });

  it("a mutation followed immediately by the quit flush reaches sessions:update", async () => {
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);

    store.getState().setScrollTop(120);
    store.getState().setBase("main");
    expect(bridge.updateSession).not.toHaveBeenCalled();

    store.getState().flushWriteBacks();

    expect(bridge.updateSession).toHaveBeenCalledTimes(1);
    expect(bridge.updateSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: SESSION_ID, base: "main", scrollTop: 120 }),
    );

    store.getState().flushWriteBacks();
    expect(bridge.updateSession).toHaveBeenCalledTimes(1);
  });

  it("tab switches coalesce into one debounced set-active carrying the final id", async () => {
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [storedSession(ID_A, "/repo-a"), storedSession(ID_B, "/repo-b")],
      activeSessionId: ID_A,
    });

    store.getState().activateSession(ID_B);
    store.getState().activateSession(ID_A);
    store.getState().activateSession(ID_B);
    expect(bridge.setActiveSession).not.toHaveBeenCalled();

    store.getState().flushWriteBacks();

    expect(bridge.setActiveSession).toHaveBeenCalledTimes(1);
    expect(bridge.setActiveSession).toHaveBeenCalledWith({ id: ID_B });
  });

  it("a discarded store goes quiet: cancel drops both pending writes rather than sending them", async () => {
    vi.useFakeTimers();
    const bridge = makeBridge({});
    await hydrateWith(bridge, {
      sessions: [storedSession(ID_A, "/repo-a"), storedSession(ID_B, "/repo-b")],
      activeSessionId: ID_A,
    });
    store.getState().activateSession(ID_B);
    store.getState().setScrollTop(120);

    // What `afterEach` does to every store in this file, and the reason a store may be
    // instantiated more than once: an instance nobody holds any more must not spend the next
    // half-second writing through whichever bridge the next one installs.
    store.getState().cancelWriteBacks();
    await vi.advanceTimersByTimeAsync(WRITE_BACK_DEBOUNCE_MS);

    expect(bridge.updateSession).not.toHaveBeenCalled();
    expect(bridge.setActiveSession).not.toHaveBeenCalled();

    // Cancelled is idle, not dead — the store it belongs to still persists what happens next.
    store.getState().setScrollTop(300);
    await vi.advanceTimersByTimeAsync(WRITE_BACK_DEBOUNCE_MS);
    expect(bridge.updateSession).toHaveBeenCalledTimes(1);
    expect(bridge.updateSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: ID_B, scrollTop: 300 }),
    );
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
    const capture = createScrollCapture((top) => store.getState().setScrollTop(top, ID_A));

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
    const capture = createScrollCapture((top) => store.getState().setScrollTop(top, ID_A));

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
    store.setState({ reviewOpenFailure: { code: "unreadable" } });
    vi.stubGlobal("window", { reviewer: bridge });

    await store.getState().openReviewByPath("/abs/x.reviewer.json");

    expect(bridge.openReviewByPath).toHaveBeenCalledWith({ path: "/abs/x.reviewer.json" });
    expect(store.getState().activeSessionId).toBe(ID_A);
    expect(slice(ID_A).repo).toEqual({ path: "/repo-a", name: "repo-a" });
    // Main marked it active; the new slice derives (log/branches fetched).
    expect(slice(ID_A).log?.phase).toBe("loaded");
    expect(store.getState().reviewOpenFailure).toBeNull();
  });

  it("surfaces a typed failure and creates no session when the open fails", async () => {
    const bridge = makeBridge({
      openReview: vi.fn().mockResolvedValue({
        ok: false,
        failure: { code: "invalidContent", reason: "repo — Repo path must be absolute" },
      }),
    });
    vi.stubGlobal("window", { reviewer: bridge });

    await store.getState().openReview();

    // The failure lands whole, reason included: the banner renders what main said, so a
    // store that kept only the code would quietly drop the useful half of it.
    expect(store.getState().reviewOpenFailure).toEqual({
      code: "invalidContent",
      reason: "repo — Repo path must be absolute",
    });
    expect(store.getState().sessions).toEqual({});
    expect(bridge.listSessions).not.toHaveBeenCalled();
  });

  it("leaves state untouched on a dialog cancel", async () => {
    const bridge = makeBridge({
      openReview: vi.fn().mockResolvedValue({ ok: true, value: { kind: "canceled" } }),
    });
    vi.stubGlobal("window", { reviewer: bridge });

    await store.getState().openReview();

    expect(store.getState().sessions).toEqual({});
    expect(store.getState().reviewOpenFailure).toBeNull();
    expect(bridge.listSessions).not.toHaveBeenCalled();
  });

  it("a dropped File with no disk path yields a typed failure and never invokes with an empty path", async () => {
    const bridge = makeBridge({ getPathForFile: vi.fn().mockReturnValue(null) });
    vi.stubGlobal("window", { reviewer: bridge });

    await store.getState().openDroppedFile(new File(["{}"], "x.reviewer.json"));

    expect(store.getState().reviewOpenFailure).toEqual({ code: "unreadable" });
    expect(bridge.openReviewByPath).not.toHaveBeenCalled();
  });

  it("a dropped File with a disk path opens that path", async () => {
    const bridge = makeBridge({
      getPathForFile: vi.fn().mockReturnValue("/abs/x.reviewer.json"),
      openReviewByPath: vi.fn().mockResolvedValue({ ok: true, value: { kind: "canceled" } }),
    });
    vi.stubGlobal("window", { reviewer: bridge });

    await store.getState().openDroppedFile(new File(["{}"], "x.reviewer.json"));

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
    await store.getState().syncSessions();

    // The live slice is kept by identity (same reference), never re-derived.
    expect(slice(ID_A)).toBe(derivedA);
    expect(store.getState().activeSessionId).toBe(ID_B);
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

    store.getState().addComment(ANCHOR, "  needs a guard  ");

    const [added] = active().comments;
    expect(added?.body).toBe("needs a guard");
    expect(added?.file).toBe("added.txt");
    expect(added?.id).toMatch(/^[0-9a-f-]{36}$/u);

    expect(bridge.updateSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(WRITE_BACK_DEBOUNCE_MS);
    expect(bridge.updateSession).toHaveBeenCalledWith(
      expect.objectContaining({ comments: [added] }),
    );
  });

  it("addComment refuses an empty body — a comment is never stored bodyless", async () => {
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);

    store.getState().addComment(ANCHOR, "   ");

    expect(active().comments).toHaveLength(0);
    store.getState().flushWriteBacks();
    expect(bridge.updateSession).not.toHaveBeenCalled();
  });

  it("editComment rewrites the body while keeping identity, and persists", async () => {
    vi.useFakeTimers();
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);
    store.getState().addComment(ANCHOR, "first");
    const original = active().comments[0];

    store.getState().editComment(original?.id ?? "", "second");

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
    store.getState().addComment(ANCHOR, "keep me");

    store.getState().editComment(active().comments[0]?.id ?? "", "  ");

    expect(active().comments[0]?.body).toBe("keep me");
  });

  it("discardComment removes the comment, leaving no trace, and persists the removal", async () => {
    vi.useFakeTimers();
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);
    store.getState().addComment(ANCHOR, "temporary");
    const target = active().comments[0];

    store.getState().discardComment(target?.id ?? "");

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
    const seeded = createSessionSlice(
      { id: SESSION_ID, repo: { path: "/repo", name: "repo" } },
      {
        ...DERIVED,
        base: "main" as BranchName,
        head: "feature/x" as BranchName,
        selection: {
          kind: "branches",
          base: "main" as BranchName,
          head: "feature/x" as BranchName,
        },
        diff: { phase: "loaded", loadId: 1, files },
        selectedFilePath: "notes.txt",
        scrollTop: 640,
        layers: LAYERS,
      },
    );
    store.setState({
      boot: "ready",
      sessions: { [SESSION_ID]: seeded },
      activeSessionId: SESSION_ID,
      tabs: [{ kind: "session", id: SESSION_ID }],
    });
  });

  it("solos a layer and clears back to the full diff", () => {
    store.getState().setActiveLayer("layer-b");
    expect(active().activeLayerId).toBe("layer-b");
    store.getState().setActiveLayer(null);
    expect(active().activeLayerId).toBeNull();
  });

  it("steps the authored order then the inferred uncovered layer, clamping at both ends", () => {
    // The three layers cover three single lines of a multi-file diff, so a coverable
    // gap remains: the inferred "not covered by layers" layer is the last stop in the
    // effective order, reachable by stepping past the last authored layer.
    const { stepLayer: step } = store.getState();
    step(1);
    expect(active().activeLayerId).toBe("layer-a");
    step(1);
    expect(active().activeLayerId).toBe("layer-b");
    step(1);
    expect(active().activeLayerId).toBe("layer-c");
    step(1);
    expect(active().activeLayerId).toBe(UNCOVERED_LAYER_ID);
    step(1);
    expect(active().activeLayerId).toBe(UNCOVERED_LAYER_ID);
    step(-1);
    expect(active().activeLayerId).toBe("layer-c");
  });

  it("never mutates the persisted diff selection, file focus, or scroll", () => {
    const before = active();
    store.getState().setActiveLayer("layer-c");
    store.getState().stepLayer(-1);
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
    store.getState().setActiveLayer("layer-a");
    store.getState().stepLayer(1);
    await vi.advanceTimersByTimeAsync(WRITE_BACK_DEBOUNCE_MS);
    expect(bridge.updateSession).not.toHaveBeenCalled();
  });

  it("does not carry the active layer into the persisted session", () => {
    const bridge = makeBridge({});
    vi.stubGlobal("window", { reviewer: bridge });
    store.getState().setActiveLayer("layer-b");
    // A subsequent real mutation flushes a write-back; the payload must omit the
    // active layer entirely — a relaunch always reopens on the full diff.
    store.getState().setScrollTop(720);
    store.getState().flushWriteBacks();
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
    const seeded = createSessionSlice(
      { id: SESSION_ID, repo: { path: "/repo", name: "repo" } },
      {
        ...DERIVED,
        diff: { phase: "loaded", loadId: 1, files },
        selectedFilePath: "greet.ts",
        layers: LAYERS,
        overview: OVERVIEW,
        overviewOpen: true,
        ...overrides,
      },
    );
    store.setState({
      boot: "ready",
      sessions: { [SESSION_ID]: seeded },
      activeSessionId: SESSION_ID,
      tabs: [{ kind: "session", id: SESSION_ID }],
    });
  }

  it("a restored review with a doc opens on it; one without opens on its diff", async () => {
    const withDoc = storedSession(SESSION_ID, "/repo", { layers: LAYERS, overview: OVERVIEW });
    const bridge = makeBridge({
      listSessions: vi.fn().mockResolvedValue({ sessions: [withDoc], activeSessionId: SESSION_ID }),
    });
    vi.stubGlobal("window", { reviewer: bridge });
    store.setState({ boot: "pending" });
    await store.getState().hydrate();
    expect(active().overviewOpen).toBe(true);

    const withoutDoc: Session = { ...withDoc, overview: null };
    const plainBridge = makeBridge({
      listSessions: vi
        .fn()
        .mockResolvedValue({ sessions: [withoutDoc], activeSessionId: SESSION_ID }),
    });
    vi.stubGlobal("window", { reviewer: plainBridge });
    store.setState({ boot: "pending" });
    await store.getState().hydrate();
    expect(active().overviewOpen).toBe(false);
  });

  it("entering a chapter leaves the doc, and the doc clears the solo when re-entered", () => {
    seedTour();
    store.getState().setActiveLayer("layer-b");
    expect(active().overviewOpen).toBe(false);
    expect(active().activeLayerId).toBe("layer-b");

    store.getState().openOverview();
    // Exactly one selected stop: the doc's own invariant.
    expect(active().overviewOpen).toBe(true);
    expect(active().activeLayerId).toBeNull();
  });

  it("steps the doc as stop zero: forward enters chapter one, back off it returns", () => {
    seedTour();
    const { stepLayer: step } = store.getState();

    step(-1);
    expect(active().overviewOpen).toBe(true); // already at the start

    step(1);
    expect(active()).toMatchObject({ overviewOpen: false, activeLayerId: "layer-a" });
    step(1);
    expect(active().activeLayerId).toBe("layer-b");
    step(-1);
    expect(active().activeLayerId).toBe("layer-a");
    step(-1);
    expect(active()).toMatchObject({ overviewOpen: true, activeLayerId: null });
  });

  it("without a doc, stepping back off the first chapter still clamps", () => {
    seedTour({ overview: null, overviewOpen: false, activeLayerId: "layer-a" });
    store.getState().stepLayer(-1);
    expect(active()).toMatchObject({ overviewOpen: false, activeLayerId: "layer-a" });
  });

  it("remembers the chapter last entered so the doc can return the reader to it", () => {
    seedTour();
    store.getState().setActiveLayer("layer-b");
    store.getState().openOverview();
    expect(active().lastChapterId).toBe("layer-b");
    // Clearing back to the full diff is not a chapter, so it leaves the bookmark alone.
    store.getState().setActiveLayer(null);
    expect(active().lastChapterId).toBe("layer-b");
  });

  it("any navigation that targets the diff leaves the doc", () => {
    seedTour();
    store.getState().selectFile("notes.txt");
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
    store.getState().focusComment(comment.id);
    expect(active().overviewOpen).toBe(false);
  });

  it("is derived view state: neither the doc nor the bookmark reaches the persisted session", () => {
    seedTour();
    const bridge = makeBridge({});
    vi.stubGlobal("window", { reviewer: bridge });
    store.getState().setActiveLayer("layer-a");
    store.getState().setScrollTop(120);
    store.getState().flushWriteBacks();
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
    const base = createSessionSlice(
      { id: SESSION_ID, repo: { path: "/repo", name: "repo" } },
      {
        ...DERIVED,
        base: "main" as BranchName,
        head: "feature/x" as BranchName,
        selection: {
          kind: "branches",
          base: "main" as BranchName,
          head: "feature/x" as BranchName,
        },
        diff: { phase: "loaded", loadId: 1, files },
        comments,
      },
    );
    store.setState({
      boot: "ready",
      sessions: { [SESSION_ID]: { ...base, ...overrides } },
      activeSessionId: SESSION_ID,
      tabs: [{ kind: "session", id: SESSION_ID }],
    });
  }

  it("focuses a comment: sets the active id and moves file focus onto its file", () => {
    seedComments([C_ADDED, C_GREET, C_NOTES]);
    store.getState().focusComment(ID_B);
    expect(active().activeCommentId).toBe(ID_B);
    expect(active().selectedFilePath).toBe("greet.ts");
  });

  it("asks the surface to scroll, and only the surface's own report clears the request", () => {
    seedComments([C_ADDED, C_GREET, C_NOTES]);
    store.getState().focusComment(ID_B);
    // The request is the half that survives the diff pane not being mounted: clicking a
    // finding in the tour doc focuses it in the very commit the pane mounts, where "did
    // the focus change" has nothing to compare against (`lib/diff/use-diff-scroll.ts`).
    expect(active().pendingCommentScroll).toBe(ID_B);

    // A report naming an older request — the reader focused again while the surface was
    // scrolling — leaves the newer one standing rather than dropping their jump.
    store.getState().commentScrolled(ID_A);
    expect(active().pendingCommentScroll).toBe(ID_B);

    store.getState().commentScrolled(ID_B);
    expect(active().pendingCommentScroll).toBeNull();
    // Served, not dismissed: the ring and the counter still read the focus.
    expect(active().activeCommentId).toBe(ID_B);

    // Re-focusing what is already focused is a fresh request, so the panel's row
    // re-centres a comment the reader has scrolled away from.
    store.getState().focusComment(ID_B);
    expect(active().pendingCommentScroll).toBe(ID_B);
  });

  it("never leaves a scroll owed to a comment nothing is focused on", () => {
    seedComments([C_ADDED, C_GREET, C_NOTES]);
    // Every way the focus can be dropped, since a request left standing past its focus
    // would fire at whatever mounts next — the point of writing both through
    // `commentFocus` rather than by hand.
    const dismissals = [
      () => store.getState().clearActiveComment(),
      () => store.getState().selectFile("notes.txt"),
      () => store.getState().selectAdjacentFile(1),
      () => store.getState().discardComment(ID_B),
    ];
    for (const dismiss of dismissals) {
      store.getState().focusComment(ID_B);
      dismiss();
      expect(active().activeCommentId).toBeNull();
      expect(active().pendingCommentScroll).toBeNull();
    }
  });

  it("focuses a comment authored before a rename onto the file's current path", () => {
    // MULTI_STATUS_PATCH renames oldname.txt → newname.txt. The comment still names the
    // old path, but the file focus and the unfold are keyed on the path the loaded diff
    // carries — the old one matches no file, so it would focus and unfold nothing.
    const beforeRename: Comment = { ...C_ADDED, file: "oldname.txt" };
    seedComments([beforeRename], { collapsedFiles: new Set(["newname.txt"]) });
    store.getState().focusComment(ID_A);
    expect(active().activeCommentId).toBe(ID_A);
    expect(active().selectedFilePath).toBe("newname.txt");
    expect(active().collapsedFiles.has("newname.txt")).toBe(false);
  });

  it("steps in document order from nothing, forward lands on the first comment", () => {
    seedComments([C_NOTES, C_ADDED, C_GREET]);
    const { stepComment } = store.getState();
    stepComment(1);
    expect(active().activeCommentId).toBe(ID_A);
    stepComment(1);
    expect(active().activeCommentId).toBe(ID_B);
    stepComment(1);
    expect(active().activeCommentId).toBe(ID_C);
  });

  it("wraps at both ends so the walk is a cycle", () => {
    seedComments([C_ADDED, C_GREET, C_NOTES]);
    const { stepComment } = store.getState();
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
    const { stepComment } = store.getState();
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
    store.getState().focusComment(ID_A); // added.txt is outside the solo
    expect(active().activeLayerId).toBeNull();
    expect(active().activeCommentId).toBe(ID_A);
  });

  it("clears a dangling active id when the focused comment is discarded", () => {
    seedComments([C_ADDED, C_GREET]);
    store.getState().focusComment(ID_A);
    store.getState().discardComment(ID_A);
    expect(active().activeCommentId).toBeNull();
    // Discarding a different comment leaves the focus alone.
    store.getState().focusComment(ID_B);
    store.getState().discardComment("no-such-id");
    expect(active().activeCommentId).toBe(ID_B);
  });

  it("plain file navigation (tree click, j/k) dismisses the comment step-through", () => {
    seedComments([C_ADDED, C_GREET, C_NOTES]);
    store.getState().focusComment(ID_B);
    store.getState().selectFile("notes.txt");
    expect(active().activeCommentId).toBeNull();
    store.getState().focusComment(ID_B);
    store.getState().selectAdjacentFile(1);
    expect(active().activeCommentId).toBeNull();
  });

  it("never persists the active comment id", () => {
    const bridge = makeBridge({});
    vi.stubGlobal("window", { reviewer: bridge });
    seedComments([C_ADDED]);
    store.getState().focusComment(ID_A);
    store.getState().flushWriteBacks();
    const persisted = vi.mocked(bridge.updateSession).mock.calls.at(-1)?.[0];
    expect(persisted).not.toHaveProperty("activeCommentId");
    expect(persisted).not.toHaveProperty("pendingCommentScroll");
    // The file focus half of focusComment does persist.
    expect(persisted?.selectedFilePath).toBe("added.txt");
  });
});

describe("review export actions", () => {
  const REPO = { path: "/repo", name: "app" };
  const ORIGIN: ReviewOrigin = { repo: REPO, base: "main", head: SHA_A, patch: null };
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
    const base = createSessionSlice(
      { id: SESSION_ID, repo: REPO },
      { ...DERIVED, diff: { phase: "loaded", loadId: 1, files } },
    );
    store.setState({
      boot: "ready",
      sessions: { [SESSION_ID]: { ...base, ...overrides } },
      activeSessionId: SESSION_ID,
      tabs: [{ kind: "session", id: SESSION_ID }],
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

    await store.getState().exportReviewJson();

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

    await store.getState().exportReviewMarkdown();

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

    await store.getState().exportReviewJson();
    await store.getState().exportReviewMarkdown();

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

    await store.getState().exportReviewJson();

    // A branch comparison round-trips as refs — no frozen patch, so no diff re-read.
    expect(bridge.getDiff).not.toHaveBeenCalled();
    const request = vi.mocked(bridge.saveReviewJson).mock.calls[0]?.[0];
    const artifact = ReviewArtifact.parse(JSON.parse(request?.content ?? ""));
    expect(artifact.repo).toBe(REPO.path);
    expect(artifact.base).toBe("main");
    expect(artifact.head).toBe("feature");
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

    await store.getState().exportReviewJson();

    // The on-screen diff is re-read and frozen so its comments place verbatim; the
    // source records the session HEAD (first committed log entry).
    expect(bridge.getDiff).toHaveBeenCalledWith({
      repoPath: REPO.path,
      selection: { kind: "uncommitted" },
    });
    const request = vi.mocked(bridge.saveReviewJson).mock.calls[0]?.[0];
    const artifact = ReviewArtifact.parse(JSON.parse(request?.content ?? ""));
    expect(artifact.patch).toBe(MULTI_STATUS_PATCH);
    expect(artifact.repo).toBe(REPO.path);
    expect(artifact.base).toBe(SHA_A);
    expect(artifact.head).toBe(SHA_A);
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

    await store.getState().exportReviewJson();

    expect(bridge.saveReviewJson).not.toHaveBeenCalled();
    expect(store.getState().reviewExportFailure).toEqual({ kind: "diffUnreadable" });
  });

  it("surfaces a failed write rather than swallowing it", async () => {
    const bridge = makeBridge({
      saveReviewJson: vi.fn().mockResolvedValue({ ok: false, failure: { code: "writeFailed" } }),
    });
    vi.stubGlobal("window", { reviewer: bridge });
    seed(ORIGIN);

    await store.getState().exportReviewJson();

    expect(store.getState().reviewExportFailure).toEqual({
      kind: "write",
      failure: { code: "writeFailed" },
    });

    // A subsequent successful (canceled) export clears the stale failure.
    await store.getState().exportReviewMarkdown();
    expect(store.getState().reviewExportFailure).toBeNull();
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
    repo: "/repo",
    base: "main",
    head: SHA_A,
    comments: [
      { file: "src/keep.ts", side: "additions", startLine: 5, endLine: 6, body: "authored: guard" },
      { file: "src/gone.ts", side: "additions", startLine: 3, endLine: 3, body: "authored: gone" },
    ],
    layers: [
      {
        label: "Keep",
        summary: "keep layer",
        ranges: [{ file: "src/keep.ts", side: "additions", startLine: 5, endLine: 6 }],
      },
      {
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
    const seeded = createSessionSlice(
      { id: SESSION_ID, repo: review.repo },
      {
        ...DERIVED,
        diff: { phase: "loaded", loadId: 1, files: [] },
        comments: review.comments,
        layers: review.layers,
        reviewOrigin: reviewOriginFor(review),
      },
    );
    store.setState({
      boot: "ready",
      sessions: { [SESSION_ID]: seeded },
      activeSessionId: SESSION_ID,
      tabs: [{ kind: "session", id: SESSION_ID }],
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
    store
      .getState()
      .addComment(
        { file: "src/keep.ts", side: "additions", startLine: 9, endLine: 9 },
        "curated: added",
      );
    store.getState().editComment(editId, "curated: edited guard");
    store.getState().discardComment(discardId);

    // Export through the real serializer, then re-import the emitted bytes.
    await store.getState().exportReviewJson();
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

    // Layers round-trip verbatim in authored order (identity is re-stamped on each open,
    // so the label and the prose are what must survive, never the id).
    expect(reopened.review.layers.map((layer) => layer.label)).toEqual(["Keep", "Gone"]);
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
    const [first, second] = current.layers;
    expect(stepLayer(current.layers, null, 1)).toBe(first?.id);
    expect(stepLayer(current.layers, first?.id ?? null, 1)).toBe(second?.id);
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
    store.getState().activateSession(ID_B);
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
    const seeded = createSessionSlice(
      { id: SESSION_ID, repo: { path: "/repo", name: "repo" } },
      {
        ...DERIVED,
        diff: { phase: "loaded", loadId: 1, files },
        selectedFilePath: "greet.ts",
        layers,
      },
    );
    store.setState({
      boot: "ready",
      sessions: { [SESSION_ID]: seeded },
      activeSessionId: SESSION_ID,
      tabs: [{ kind: "session", id: SESSION_ID }],
    });
  });

  it("marking a file read folds it away, and unmarking opens it back up", () => {
    store.getState().setFileRead("greet.ts", true);
    expect([...active().readFiles.keys()]).toEqual(["greet.ts"]);
    expect(active().collapsedFiles.has("greet.ts")).toBe(true);

    store.getState().setFileRead("greet.ts", false);
    expect(active().readFiles.size).toBe(0);
    expect(active().collapsedFiles.has("greet.ts")).toBe(false);
  });

  it("folding a file by hand leaves the read mark alone, either way round", () => {
    store.getState().setFileCollapsed("greet.ts", true);
    expect(active().readFiles.size).toBe(0);

    store.getState().setFileRead("greet.ts", true);
    store.getState().setFileCollapsed("greet.ts", false);
    expect(active().collapsedFiles.has("greet.ts")).toBe(false);
    expect([...active().readFiles.keys()]).toEqual(["greet.ts"]);
  });

  it("`r` flips the focused file when no path is named", () => {
    store.getState().toggleFileRead();
    expect([...active().readFiles.keys()]).toEqual(["greet.ts"]);
    store.getState().toggleFileRead();
    expect(active().readFiles.size).toBe(0);
  });

  it("marks a whole layer's extent, and only the files the diff carries", () => {
    store.getState().setLayerRead("greeting", true);
    expect([...active().readFiles.keys()].toSorted()).toEqual(["added.txt", "greet.ts"]);
    expect(active().collapsedFiles.has("notes.txt")).toBe(false);
  });

  it("clearing is scoped to the paths it was given", () => {
    store.getState().setLayerRead("greeting", true);
    store.getState().setLayerRead("notes", true);
    store.getState().clearFilesRead(["greet.ts"]);
    expect([...active().readFiles.keys()].toSorted()).toEqual(["added.txt", "notes.txt"]);
  });

  it("persists: a reader who quits mid-review comes back to the review mid-read", () => {
    const bridge = makeBridge({});
    vi.stubGlobal("window", { reviewer: bridge });
    store.getState().setFileRead("greet.ts", true);
    store.getState().setLayerRead("greeting", true);
    store.getState().flushWriteBacks();

    // The marks cross as the wire shape, keyed by path against the signature of what was
    // read, and the fold that came with each mark rides along — restoring the marks without
    // the folds would reopen every file the reader had already put away.
    expect(bridge.updateSession).toHaveBeenCalledTimes(1);
    const persisted = vi.mocked(bridge.updateSession).mock.calls[0]?.[0];
    expect(Object.keys(persisted?.readFiles ?? {})).toContain("greet.ts");
    expect(persisted?.collapsedFiles).toContain("greet.ts");
  });

  it("a gesture that changes nothing costs no write-back, and so no disk write", () => {
    const bridge = makeBridge({});
    vi.stubGlobal("window", { reviewer: bridge });
    store.getState().setFileRead("greet.ts", true);
    store.getState().flushWriteBacks();
    vi.mocked(bridge.updateSession).mockClear();

    // Already read, marked read again: `markFilesRead` hands back the same map, so the store
    // never changes and nothing is scheduled. The no-op contract is what keeps a redundant
    // click from rewriting the review's progress record.
    store.getState().setFileRead("greet.ts", true);
    store.getState().flushWriteBacks();
    expect(bridge.updateSession).not.toHaveBeenCalled();
  });

  it("a path the loaded diff does not carry is a no-op, never a mark for nothing", () => {
    const before = active().readFiles;
    store.getState().setFileRead("nope.ts", true);
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
    store.getState().setFileRead("greet.ts", true);
    expect(active().collapsedFiles.has("greet.ts")).toBe(true);

    store.getState().focusComment(ID_A);
    expect(active().collapsedFiles.has("greet.ts")).toBe(false);
    // The mark itself survives: reading a finding again is not un-reading the file.
    expect(active().readFiles.has("greet.ts")).toBe(true);
  });
});

describe("copying comments as a prompt", () => {
  const GREET_ANCHOR = {
    file: "greet.ts",
    side: "additions",
    startLine: 5,
    endLine: 6,
  } as const;
  const NOTES_ANCHOR = { file: "notes.txt", side: "additions", startLine: 2, endLine: 2 } as const;

  /** The clipboard, stubbed as the renderer's — `writeClipboard` reads it off `globalThis`,
   * and `vi.unstubAllGlobals` in the shared afterEach takes it back down. */
  function stubClipboard(writeText = vi.fn().mockResolvedValue(undefined)): typeof writeText {
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    return writeText;
  }

  it("copies one comment with its anchor and its anchored code, and records the copy", async () => {
    const writeText = stubClipboard();
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);
    store.getState().addComment(GREET_ANCHOR, "why not take a formatter?");
    const target = active().comments[0];

    await expect(store.getState().copyCommentPrompt(target?.id ?? "")).resolves.toBe(true);

    const payload = writeText.mock.calls[0]?.[0];
    expect(payload).toContain("Fix this code review comment.");
    expect(payload).toContain("### `greet.ts:5-6`");
    expect(payload).toContain("why not take a formatter?");
    expect(payload).toContain("  return greet(name).toUpperCase();");
    // The record is what lets the card's glyph answer a keystroke it never saw.
    expect(store.getState().promptCopy).toEqual({
      scope: "comment",
      commentId: target?.id,
      nonce: expect.any(Number),
    });
  });

  it("advances the nonce on a repeat, so copying the same comment twice flashes twice", async () => {
    stubClipboard();
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);
    store.getState().addComment(GREET_ANCHOR, "again");
    const id = active().comments[0]?.id ?? "";

    await store.getState().copyCommentPrompt(id);
    const first = store.getState().promptCopy;
    await store.getState().copyCommentPrompt(id);

    expect(store.getState().promptCopy).not.toEqual(first);
  });

  it("copyActiveCommentPrompt aims at the comment the reader is on", async () => {
    const writeText = stubClipboard();
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);
    store.getState().addComment(GREET_ANCHOR, "first comment");
    store.getState().addComment(NOTES_ANCHOR, "second comment");
    const second = active().comments[1];
    store.getState().focusComment(second?.id ?? "");

    await expect(store.getState().copyActiveCommentPrompt()).resolves.toBe(true);

    expect(writeText.mock.calls[0]?.[0]).toContain("second comment");
  });

  it("copyActiveCommentPrompt with nothing focused copies nothing and claims nothing", async () => {
    const writeText = stubClipboard();
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);
    store.getState().addComment(GREET_ANCHOR, "unfocused");

    await expect(store.getState().copyActiveCommentPrompt()).resolves.toBe(false);

    expect(writeText).not.toHaveBeenCalled();
    expect(store.getState().promptCopy).toBeNull();
  });

  it("copies every comment in the review, including ones the soloed layer hides", async () => {
    const writeText = stubClipboard();
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);
    store.getState().addComment(GREET_ANCHOR, "in the soloed layer");
    store.getState().addComment(NOTES_ANCHOR, "outside it");
    const layers: ReviewLayer[] = [
      {
        id: "greet",
        label: "Greeting",
        ranges: [{ file: "greet.ts", side: "additions", startLine: 1, endLine: 7 }],
      },
    ];
    patchActive({ layers });
    store.getState().setActiveLayer("greet");

    await expect(store.getState().copyAllCommentsPrompt()).resolves.toBe(true);

    const payload = writeText.mock.calls[0]?.[0];
    expect(payload).toContain("2 comments from a code review of");
    expect(payload).toContain("in the soloed layer");
    // "All" is the review, not what happens to be on screen — the whole point of the scope.
    expect(payload).toContain("outside it");
    expect(payload).toContain("## Greeting");
    expect(payload).toContain("## Other comments");
    expect(store.getState().promptCopy).toEqual({
      scope: "all",
      nonce: expect.any(Number),
    });
  });

  it("names no refs for a plain repo session the reader commented on themselves", async () => {
    const writeText = stubClipboard();
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);
    store.getState().addComment(GREET_ANCHOR, "mine");

    await store.getState().copyAllCommentsPrompt();

    expect(writeText.mock.calls[0]?.[0]).toContain("1 comment from a code review of `repo`.");
  });

  it("copies nothing from a review with no comments", async () => {
    const writeText = stubClipboard();
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);

    await expect(store.getState().copyAllCommentsPrompt()).resolves.toBe(false);

    expect(writeText).not.toHaveBeenCalled();
  });

  it("records nothing when the clipboard refuses — no check for a copy that did not happen", async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    const bridge = makeBridge({});
    await openFixtureRepo(bridge);
    store.getState().addComment(GREET_ANCHOR, "never landed");

    await expect(store.getState().copyCommentPrompt(active().comments[0]?.id ?? "")).resolves.toBe(
      false,
    );

    expect(store.getState().promptCopy).toBeNull();
  });
});
