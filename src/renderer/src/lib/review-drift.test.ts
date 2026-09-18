import { describe, expect, it } from "vitest";
import type { LogEntry } from "../../../shared/git";
import type { LogState } from "./load-state";
import { reviewDrift } from "./review-drift";

// The one comparison behind the doc's "written at … the branch is now at …" line. Every
// answer here is a decision about when the app is allowed to *say* the review is old, and the
// expensive mistakes are all on the saying-it-when-it-is-not side.

const sha = (letter: string): string => letter.repeat(40);

function entriesOf(...shas: readonly string[]): LogEntry[] {
  return shas.map((value) => ({
    kind: "commit",
    commit: {
      sha: value,
      shortSha: value.slice(0, 7),
      author: "A",
      authoredAt: "2026-01-01T00:00:00+00:00",
      subject: value.slice(0, 4),
    },
  }));
}

function log(...shas: readonly string[]): LogState {
  return { phase: "loaded", entries: entriesOf(...shas) };
}

const REFS = { kind: "refs", base: "main", head: "feature" } as const;

describe("reviewDrift", () => {
  it("says nothing when the branch is still where the review was written", () => {
    expect(
      reviewDrift({ reviewedHead: sha("a"), reviewDiff: REFS, log: log(sha("a"), sha("b")) }),
    ).toBeNull();
  });

  it("reports both ends and how many commits landed between them", () => {
    // Newest first, so the reviewed commit's position in the walk *is* the number of commits
    // on top of it — no second count, and no `rev-list` of its own.
    expect(
      reviewDrift({
        reviewedHead: sha("c"),
        reviewDiff: REFS,
        log: log(sha("a"), sha("b"), sha("c"), sha("d")),
      }),
    ).toEqual({ reviewedHead: sha("c"), currentHead: sha("a"), since: 2 });
  });

  it("names both shas but no count when the reviewed commit is not in this walk", () => {
    // A rebase or a force-push. The two ends are still true and still worth saying; "0
    // commits since" would be a claim the log cannot support, so nothing is claimed.
    expect(
      reviewDrift({ reviewedHead: sha("z"), reviewDiff: REFS, log: log(sha("a"), sha("b")) }),
    ).toEqual({ reviewedHead: sha("z"), currentHead: sha("a"), since: null });
  });

  it("says nothing about a frozen review, however far the branch has moved", () => {
    // A frozen review renders the exact bytes it carries, so the branch moving says nothing
    // about what is on screen — the anchors all still place.
    expect(
      reviewDrift({
        reviewedHead: sha("c"),
        reviewDiff: { kind: "frozenPatch", patch: "diff --git a/x b/x\n" },
        log: log(sha("a")),
      }),
    ).toBeNull();
  });

  it("says nothing for a plain repo session, which has no authored moment to drift from", () => {
    expect(
      reviewDrift({ reviewedHead: sha("c"), reviewDiff: null, log: log(sha("a")) }),
    ).toBeNull();
  });

  it("says nothing for an artifact written before the field existed", () => {
    expect(reviewDrift({ reviewedHead: null, reviewDiff: REFS, log: log(sha("a")) })).toBeNull();
  });

  it("stays silent until there is a walk to compare against", () => {
    // Not "no drift" — nothing to compare. Silence beats a line that appears a second late,
    // and beats one that claims a review is current because git has not answered yet.
    for (const state of [null, { phase: "loading" } as const]) {
      expect(reviewDrift({ reviewedHead: sha("c"), reviewDiff: REFS, log: state })).toBeNull();
    }
  });

  it("reads past the working-tree row, which carries no sha", () => {
    // Only a HEAD walk carries that row, and a review session's walk is its own base..head —
    // but the count is of *commits*, and reading the raw index would be off by one the day
    // that changes.
    const withUncommitted: LogState = {
      phase: "loaded",
      entries: [{ kind: "uncommitted" }, ...entriesOf(sha("a"), sha("b"))],
    };
    expect(reviewDrift({ reviewedHead: sha("b"), reviewDiff: REFS, log: withUncommitted })).toEqual(
      { reviewedHead: sha("b"), currentHead: sha("a"), since: 1 },
    );
  });
});
