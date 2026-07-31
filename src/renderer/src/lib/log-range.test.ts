import { describe, expect, it } from "vitest";
import type { BranchList, LogEntry, RepoInfo } from "../../../shared/git";
import {
  brushAfterWalk,
  logRangeFor,
  recoverReviewBrush,
  type BrushWalkSlice,
  type LogRangeSlice,
} from "./log-range";

function sha(fill: string): string {
  return fill.repeat(40).slice(0, 40);
}

function commitEntry(fill: string): LogEntry {
  return {
    kind: "commit",
    commit: {
      sha: sha(fill),
      shortSha: sha(fill).slice(0, 7),
      author: "t",
      authoredAt: "2026-07-04T00:00:00+00:00",
      subject: `commit ${fill}`,
    },
  };
}

const CLEAN_LOG: LogEntry[] = [commitEntry("a"), commitEntry("b")];
const REPO: RepoInfo = { path: "/repo", name: "repo" };
const DIRTY_LOG: LogEntry[] = [{ kind: "uncommitted" }, ...CLEAN_LOG];

function branchList(currentBranch: string | null): BranchList {
  return { branches: ["main", "feature"], defaultBranch: "main", currentBranch };
}

function rangeSlice(overrides: Partial<LogRangeSlice>): LogRangeSlice {
  return { reviewOrigin: null, head: null, base: null, branches: null, ...overrides };
}

describe("logRangeFor", () => {
  it("walks a review's own base..head, whatever the picker was left on", () => {
    expect(
      logRangeFor(
        rangeSlice({
          reviewOrigin: { repo: REPO, base: "main", head: sha("a"), patch: null },
          head: "feature",
          base: "trunk",
        }),
      ),
    ).toEqual({ base: "main", head: sha("a") });
  });

  it("walks HEAD when the picker names no branch — detached, or before the listing landed", () => {
    expect(logRangeFor(rangeSlice({}))).toBeNull();
  });

  it("walks base..head once the picker is comparing", () => {
    expect(logRangeFor(rangeSlice({ head: "feature", base: "main" }))).toEqual({
      base: "main",
      head: "feature",
    });
  });

  it("keeps the HEAD walk for the checked-out branch, so the working-tree row survives", () => {
    // The named walk would answer the same commits minus the one row nothing else can
    // produce, which is why listing your own branch is left unnamed.
    expect(
      logRangeFor(
        rangeSlice({
          head: "feature",
          branches: { phase: "loaded", list: branchList("feature") },
        }),
      ),
    ).toBeNull();
  });

  it("names the walk for any other branch's history", () => {
    expect(
      logRangeFor(
        rangeSlice({ head: "feature", branches: { phase: "loaded", list: branchList("main") } }),
      ),
    ).toEqual({ base: null, head: "feature" });
  });

  it("names the walk while the branch listing is still in flight or has failed", () => {
    // With no listing there is nothing to recognise the checked-out branch by, so the
    // explicit walk is the honest answer rather than a HEAD walk that might be a different
    // branch entirely.
    for (const branches of [
      null,
      { phase: "loading" } as const,
      { phase: "failed", failure: { code: "gitMissing" } } as const,
    ]) {
      expect(logRangeFor(rangeSlice({ head: "feature", branches }))).toEqual({
        base: null,
        head: "feature",
      });
    }
  });
});

describe("brushAfterWalk", () => {
  function walkSlice(overrides: Partial<BrushWalkSlice>): BrushWalkSlice {
    return { base: null, commitSelection: null, ...overrides };
  }

  it("has nowhere to land on an empty log", () => {
    expect(brushAfterWalk([], walkSlice({ base: "main" }), true)).toBeNull();
  });

  it("lands a just-asked-for comparison end to end", () => {
    expect(brushAfterWalk(CLEAN_LOG, walkSlice({ base: "main" }), true)).toEqual({
      anchor: 0,
      focus: 1,
    });
  });

  it("lands a plain history on its newest entry — nobody means 'all of' a history", () => {
    expect(brushAfterWalk(CLEAN_LOG, walkSlice({}), true)).toEqual({ anchor: 0, focus: 0 });
  });

  it("ignores a persisted selection when the reviewer just moved an endpoint", () => {
    // `land` is the whole difference between the two callers: this one asked for this
    // comparison, so it gets the comparison rather than the narrower range it was on.
    expect(
      brushAfterWalk(
        CLEAN_LOG,
        walkSlice({
          base: "main",
          commitSelection: { kind: "commitRange", first: sha("b"), last: sha("b") },
        }),
        true,
      ),
    ).toEqual({ anchor: 0, focus: 1 });
  });

  it("restores a session onto the selection it was left on", () => {
    expect(
      brushAfterWalk(
        DIRTY_LOG,
        walkSlice({ commitSelection: { kind: "commitRangeWithUncommitted", first: sha("a") } }),
        false,
      ),
    ).toEqual({ anchor: 0, focus: 1 });
  });

  it("restores a session with nothing persisted the same way a fresh walk lands", () => {
    expect(brushAfterWalk(CLEAN_LOG, walkSlice({}), false)).toEqual({ anchor: 0, focus: 0 });
    expect(brushAfterWalk(CLEAN_LOG, walkSlice({ base: "main" }), false)).toEqual({
      anchor: 0,
      focus: 1,
    });
  });

  it("degrades a selection the log can no longer place to nothing, never to another range", () => {
    // Reopening onto a *different* range than the one it was left on is worse than
    // reopening onto none.
    expect(
      brushAfterWalk(
        CLEAN_LOG,
        walkSlice({ commitSelection: { kind: "commitRange", first: sha("z"), last: sha("z") } }),
        false,
      ),
    ).toBeNull();
  });
});

describe("recoverReviewBrush", () => {
  it("opens a review over its whole range when nothing was narrowed", () => {
    expect(recoverReviewBrush(CLEAN_LOG, null)).toEqual({
      brush: { anchor: 0, focus: 1 },
      reviewSubrange: null,
    });
  });

  it("keeps a saved subrange that still fits, and the brush over it", () => {
    const subrange = { kind: "commitRange", first: sha("b"), last: sha("b") } as const;
    expect(recoverReviewBrush(CLEAN_LOG, subrange)).toEqual({
      brush: { anchor: 1, focus: 1 },
      reviewSubrange: subrange,
    });
  });

  it("resets a subrange history has dropped back to the full review", () => {
    // The diff then renders via the pin — every anchor places — rather than through a
    // range whose commits are no longer there to derive.
    expect(
      recoverReviewBrush(CLEAN_LOG, { kind: "commitRange", first: sha("z"), last: sha("z") }),
    ).toEqual({ brush: { anchor: 0, focus: 1 }, reviewSubrange: null });
  });

  it("has no brush to offer for an empty ranged log", () => {
    expect(recoverReviewBrush([], null)).toEqual({ brush: null, reviewSubrange: null });
  });
});
