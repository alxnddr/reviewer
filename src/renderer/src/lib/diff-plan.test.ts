import { describe, expect, it } from "vitest";
import type { DiffSelection, LogEntry, RepoInfo } from "../../../shared/git";
import { planDiff, sameSelection, type DiffPlan, type DiffPlanSlice } from "./diff-plan";

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

const A = commitEntry("a");
const B = commitEntry("b");
/** Newest first, working tree on top — the shape `shared/git.ts` pins the log to. */
const DIRTY_LOG: LogEntry[] = [{ kind: "uncommitted" }, A, B];
const CLEAN_LOG: LogEntry[] = [A, B];

/** Nothing asked for and nothing loaded: every case below names only the fields it is
 * about, which is the point of `DiffPlanSlice` being the seven fields the decision reads
 * rather than a whole session. */
const EMPTY: DiffPlanSlice = {
  reviewOrigin: null,
  reviewSubrange: null,
  reviewDiff: null,
  log: null,
  head: null,
  base: null,
  brush: null,
};

function slice(overrides: Partial<DiffPlanSlice>): DiffPlanSlice {
  return { ...EMPTY, ...overrides };
}

const REPO: RepoInfo = { path: "/repo", name: "repo" };
const ORIGIN = { repo: REPO, base: "main", head: sha("a"), patch: null };

describe("planDiff", () => {
  // The six states a diff pane can be in, one row each — the whole decision as a table
  // rather than as the multi-step bridge choreography it used to take to reach one.
  const cases: { name: string; slice: DiffPlanSlice; plan: DiffPlan }[] = [
    // ── A review session: scoped to its authored diff, never jumping to another one ──
    {
      name: "a frozen review renders its embedded patch, off git entirely",
      slice: slice({
        reviewOrigin: ORIGIN,
        reviewDiff: { kind: "frozenPatch", patch: "diff --git a/x b/x\n" },
      }),
      plan: { kind: "frozenPatch", patch: "diff --git a/x b/x\n" },
    },
    {
      name: "a refs review asks for its authored base..head, not the picker's refs",
      slice: slice({
        reviewOrigin: ORIGIN,
        reviewDiff: { kind: "refs", base: "main", head: sha("a") },
        // The picker's own refs are set and must not reach the plan.
        head: "feature",
        base: "trunk",
        log: { phase: "loaded", entries: CLEAN_LOG },
        brush: { anchor: 0, focus: 0 },
      }),
      plan: { kind: "selection", selection: { kind: "reviewRefs", base: "main", head: sha("a") } },
    },
    {
      name: "a narrowed review asks for just its subrange, whichever pin it carries",
      slice: slice({
        reviewOrigin: ORIGIN,
        reviewDiff: { kind: "refs", base: "main", head: sha("a") },
        reviewSubrange: { kind: "commitRange", first: sha("b"), last: sha("b") },
      }),
      plan: {
        kind: "selection",
        selection: { kind: "commitRange", first: sha("b"), last: sha("b") },
      },
    },
    {
      name: "a review with no pin plans nothing rather than falling through to the picker",
      // Defensive: createFromReview sets origin and pin together, so this is unreachable —
      // but rendering a repo picker's brush for a review session would be a wrong diff, not
      // a missing one.
      slice: slice({ reviewOrigin: ORIGIN, log: { phase: "loaded", entries: CLEAN_LOG } }),
      plan: { kind: "nothing" },
    },

    // ── A repo session: one list of commits and a brush over it ──
    {
      name: "nothing before the log has been asked for",
      slice: slice({ brush: { anchor: 0, focus: 0 } }),
      plan: { kind: "nothing" },
    },
    {
      name: "nothing while the log is still walking",
      slice: slice({ log: { phase: "loading" }, brush: { anchor: 0, focus: 0 } }),
      plan: { kind: "nothing" },
    },
    {
      name: "a failed log blocks the pane with that failure, rather than showing an empty diff",
      slice: slice({ log: { phase: "failed", failure: { code: "unknownRevision" } } }),
      plan: { kind: "blocked", failure: { code: "unknownRevision" } },
    },
    {
      name: "a comparison brushed end to end is the comparison itself",
      slice: slice({
        head: "feature",
        base: "main",
        log: { phase: "loaded", entries: CLEAN_LOG },
        brush: { anchor: 0, focus: 1 },
      }),
      plan: { kind: "selection", selection: { kind: "branches", base: "main", head: "feature" } },
    },
    {
      name: "a comparison with no commits between the two still names the comparison",
      // "No changes between these two" is an answer, and the pane says it in those words.
      slice: slice({ head: "feature", base: "main", log: { phase: "loaded", entries: [] } }),
      plan: { kind: "selection", selection: { kind: "branches", base: "main", head: "feature" } },
    },
    {
      name: "a comparison brushed narrower is the banded commits, not the comparison",
      slice: slice({
        head: "feature",
        base: "main",
        log: { phase: "loaded", entries: CLEAN_LOG },
        brush: { anchor: 0, focus: 0 },
      }),
      plan: {
        kind: "selection",
        selection: { kind: "commitRange", first: sha("a"), last: sha("a") },
      },
    },
    {
      name: "a branch's own history is never a comparison, however much of it is brushed",
      slice: slice({
        head: "feature",
        log: { phase: "loaded", entries: CLEAN_LOG },
        brush: { anchor: 0, focus: 1 },
      }),
      plan: {
        kind: "selection",
        selection: { kind: "commitRange", first: sha("b"), last: sha("a") },
      },
    },
    {
      name: "a base with no head is not a comparison — there is no second ref to name",
      // `head` is null on a detached HEAD, and before the branch listing lands; a `branches`
      // selection would have nothing to put on its right-hand side, so however much of the
      // walk is brushed the answer is the banded commits.
      slice: slice({
        base: "main",
        log: { phase: "loaded", entries: CLEAN_LOG },
        brush: { anchor: 0, focus: 1 },
      }),
      plan: {
        kind: "selection",
        selection: { kind: "commitRange", first: sha("b"), last: sha("a") },
      },
    },
    {
      name: "a loaded log with nothing brushed plans nothing",
      slice: slice({ log: { phase: "loaded", entries: CLEAN_LOG } }),
      plan: { kind: "nothing" },
    },
    {
      name: "the working-tree row alone is the uncommitted diff",
      slice: slice({
        log: { phase: "loaded", entries: DIRTY_LOG },
        brush: { anchor: 0, focus: 0 },
      }),
      plan: { kind: "selection", selection: { kind: "uncommitted" } },
    },
    {
      name: "the working-tree row extended down into commits carries both",
      slice: slice({
        log: { phase: "loaded", entries: DIRTY_LOG },
        brush: { anchor: 0, focus: 1 },
      }),
      plan: {
        kind: "selection",
        selection: { kind: "commitRangeWithUncommitted", first: sha("a") },
      },
    },
    {
      name: "a brush that no longer fits the log plans nothing, never a wrong range",
      slice: slice({
        log: { phase: "loaded", entries: CLEAN_LOG },
        brush: { anchor: 0, focus: 9 },
      }),
      plan: { kind: "nothing" },
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(planDiff(testCase.slice)).toEqual(testCase.plan);
    });
  }

  it("is one of exactly six outcomes over the whole table — four selection arms, plus frozen, blocked and nothing", () => {
    const kinds = new Set(cases.map((testCase) => testCase.plan.kind));
    expect([...kinds].toSorted()).toEqual(["blocked", "frozenPatch", "nothing", "selection"]);
    const selections = new Set(
      cases.flatMap((testCase) =>
        testCase.plan.kind === "selection" ? [testCase.plan.selection.kind] : [],
      ),
    );
    expect([...selections].toSorted()).toEqual([
      "branches",
      "commitRange",
      "commitRangeWithUncommitted",
      "reviewRefs",
      "uncommitted",
    ]);
  });
});

describe("sameSelection", () => {
  const BRANCHES: DiffSelection = { kind: "branches", base: "main", head: "feature" };
  const REVIEW_REFS: DiffSelection = { kind: "reviewRefs", base: "main", head: sha("a") };
  const RANGE: DiffSelection = { kind: "commitRange", first: sha("b"), last: sha("a") };
  const WITH_UNCOMMITTED: DiffSelection = {
    kind: "commitRangeWithUncommitted",
    first: sha("a"),
  };
  const UNCOMMITTED: DiffSelection = { kind: "uncommitted" };

  it("holds for a distinct value of every arm — this is what keeps a settled diff from refetching", () => {
    for (const selection of [BRANCHES, REVIEW_REFS, RANGE, WITH_UNCOMMITTED, UNCOMMITTED]) {
      expect(sameSelection(selection, { ...selection })).toBe(true);
    }
  });

  it("separates arms that carry the same refs", () => {
    // `branches` and `reviewRefs` are two different git questions about one pair of refs.
    expect(sameSelection(BRANCHES, { kind: "reviewRefs", base: "main", head: "feature" })).toBe(
      false,
    );
  });

  it("compares every field an arm carries", () => {
    expect(sameSelection(BRANCHES, { ...BRANCHES, head: "other" })).toBe(false);
    expect(sameSelection(REVIEW_REFS, { ...REVIEW_REFS, base: "trunk" })).toBe(false);
    expect(sameSelection(RANGE, { ...RANGE, last: sha("c") })).toBe(false);
    expect(sameSelection(WITH_UNCOMMITTED, { ...WITH_UNCOMMITTED, first: sha("c") })).toBe(false);
  });

  it("treats null as a value: two absences match, one does not", () => {
    expect(sameSelection(null, null)).toBe(true);
    expect(sameSelection(null, UNCOMMITTED)).toBe(false);
    expect(sameSelection(UNCOMMITTED, null)).toBe(false);
  });
});
