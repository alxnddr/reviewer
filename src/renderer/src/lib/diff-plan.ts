import { assertNever } from "../../../shared/assert";
import type { BranchName, CommitSelection, DiffSelection, GitFailure } from "../../../shared/git";
import type { ReviewDiff, ReviewOrigin } from "../../../shared/review";
import type { LogState } from "./load-state";
import { isFullBrush, selectionFromBrush, type BrushRange } from "./selection";

// The whole "what does the diff pane show" decision, and the equality that decides whether a
// plan is already on screen. Six outcomes, because there are genuinely six states a diff pane
// can be in — a review's frozen patch, a review's refs, a narrowed range, a comparison, a
// brushed span, and nothing.
//
// It is pure and it is the one thing every load path agrees on (`runDiffLoad` is the only
// caller), so it lives out here where it can be read as a table instead of only through a
// bridge mock.

/** What the current mode's state asks of the diff pane. */
export type DiffPlan =
  | { kind: "selection"; selection: DiffSelection }
  /** A review's frozen embedded patch: rendered as-is, off git entirely. */
  | { kind: "frozenPatch"; patch: string }
  /** The mode's source data failed to load — the pane shows that failure. */
  | { kind: "blocked"; failure: GitFailure }
  | { kind: "nothing" };

/** Exactly the slice fields the decision reads. Stated as its own shape rather than as
 * `SessionSlice` so this module never imports the store — and so a case in the table below is
 * seven fields rather than a whole session. `SessionSlice` satisfies it structurally. */
export type DiffPlanSlice = {
  reviewOrigin: ReviewOrigin | null;
  reviewSubrange: CommitSelection | null;
  reviewDiff: ReviewDiff | null;
  log: LogState | null;
  head: BranchName | null;
  base: BranchName | null;
  brush: BrushRange | null;
};

export function planDiff(slice: DiffPlanSlice): DiffPlan {
  // A review session is scoped to its authored diff: the selector can only
  // narrow to a subset of the review's commits, never jump to another diff. A
  // subrange re-derives the diff of just those commits; no subrange renders the pin
  // (frozen patch verbatim, or the `base..head` refs) so every anchor places.
  if (slice.reviewOrigin !== null) {
    if (slice.reviewSubrange !== null) {
      return { kind: "selection", selection: slice.reviewSubrange };
    }
    if (slice.reviewDiff === null) {
      // A review session always carries a pin (createFromReview sets both together);
      // guard defensively rather than render a repo picker for it.
      return { kind: "nothing" };
    }
    return slice.reviewDiff.kind === "frozenPatch"
      ? { kind: "frozenPatch", patch: slice.reviewDiff.patch }
      : {
          kind: "selection",
          selection: {
            kind: "reviewRefs",
            base: slice.reviewDiff.base,
            head: slice.reviewDiff.head,
          },
        };
  }
  // A repo session's picker is one list of commits and a brush over it, so the diff
  // follows from how much of that list is brushed — there is no second flag that could
  // disagree with what is on screen. A comparison brushed end to end IS the comparison
  // (three-dot `base...head`, what a pull request shows); anything narrower is the range
  // of commits actually banded, which is also how a review's subrange works.
  if (slice.log === null || slice.log.phase === "loading") {
    return { kind: "nothing" };
  }
  if (slice.log.phase === "failed") {
    return { kind: "blocked", failure: slice.log.failure };
  }
  const entries = slice.log.entries;
  const comparing = slice.base !== null && slice.head !== null;
  if (
    comparing &&
    slice.base !== null &&
    slice.head !== null &&
    // An empty list still names the comparison rather than nothing: "no changes between
    // these two" is an answer, and the diff pane says it in those words.
    (entries.length === 0 || (slice.brush !== null && isFullBrush(entries, slice.brush)))
  ) {
    return {
      kind: "selection",
      selection: { kind: "branches", base: slice.base, head: slice.head },
    };
  }
  if (slice.brush === null) {
    return { kind: "nothing" };
  }
  const selection = selectionFromBrush(entries, slice.brush);
  return selection === null ? { kind: "nothing" } : { kind: "selection", selection };
}

/** Whether a plan's selection is the one already loaded — the check that keeps a re-run over
 * settled state from refetching the same diff.
 *
 * Written out arm by arm, with `assertNever` closing the switch, rather than handed to a
 * deep-equal: a new `DiffSelection` arm then fails the typecheck here instead of silently
 * comparing as unequal (a refetch on every run) or as equal (a diff that never reloads). */
export function sameSelection(a: DiffSelection | null, b: DiffSelection | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  switch (a.kind) {
    case "branches":
      return b.kind === "branches" && a.base === b.base && a.head === b.head;
    case "reviewRefs":
      return b.kind === "reviewRefs" && a.base === b.base && a.head === b.head;
    case "commitRange":
      return b.kind === "commitRange" && a.first === b.first && a.last === b.last;
    case "commitRangeWithUncommitted":
      return b.kind === "commitRangeWithUncommitted" && a.first === b.first;
    case "uncommitted":
      return b.kind === "uncommitted";
    default:
      return assertNever(a);
  }
}
