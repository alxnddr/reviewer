import type { BranchName, CommitSelection, LogEntry, LogRange } from "../../../shared/git";
import type { ReviewOrigin } from "../../../shared/review";
import type { BranchesState } from "./load-state";
import { brushFromSelection, reviewFullBrush, type BrushRange } from "./selection";

// The commit list half of a session: which range git is asked to walk, and where the brush
// lands in what comes back.
//
// One decision per moment the list can change — a fetch (`logRangeFor`), a re-walk after the
// picker moved or a session was restored (`brushAfterWalk`), and a review session's first
// derivation (`recoverReviewBrush`). All three are pure over the fields they read, so they
// state their inputs as their own shapes rather than as `SessionSlice`; the store's slice
// satisfies them structurally, and nothing here imports the store.

/** The slice fields the walk's range is read from. */
export type LogRangeSlice = {
  reviewOrigin: ReviewOrigin | null;
  head: BranchName | null;
  base: BranchName | null;
  branches: BranchesState | null;
};

/** What `git log` walks for this session: a review's own `base..head`, another
 * branch's whole history when the picker was pointed at one, or HEAD — which is the
 * only walk that carries the working-tree row, and so the one a session listing its
 * own checked-out branch must keep. */
export function logRangeFor(slice: LogRangeSlice): LogRange | null {
  if (slice.reviewOrigin !== null) {
    return { base: slice.reviewOrigin.base, head: slice.reviewOrigin.head };
  }
  if (slice.head === null) {
    // Detached, or before the branch list landed: HEAD is the only ref there is.
    return null;
  }
  if (slice.base !== null) {
    return { base: slice.base, head: slice.head };
  }
  const current =
    slice.branches !== null && slice.branches.phase === "loaded"
      ? slice.branches.list.currentBranch
      : null;
  // Listing the checked-out branch is the HEAD walk — the same commits, plus the
  // working tree — so it is left as `null` rather than named, which would trade that
  // row away for nothing.
  return slice.head === current ? null : { base: null, head: slice.head };
}

/** The slice fields the landing rule reads: whether this list is a comparison, and what the
 * session was last left on. */
export type BrushWalkSlice = {
  base: BranchName | null;
  commitSelection: CommitSelection | null;
};

/** Where the brush lands on a freshly walked log.
 *
 * A comparison is brushed end to end: asking for `main → feature/x` means asking for
 * what that comparison holds, and a band over all of it is how the picker says so (the
 * same shape a review session opens in over its own range). Without one, the list is a
 * whole history and nobody means "all of it" by that — so it lands on the newest entry,
 * or on the persisted selection when that is still in this walk. */
export function brushAfterWalk(
  entries: LogEntry[],
  slice: BrushWalkSlice,
  /** True when the reviewer just moved an endpoint, false when a session is being
   * restored. The two want opposite things from the same log: a reviewer who has just
   * asked for `main → feature/x` wants to see that comparison, not whatever narrower
   * range they happened to be on beforehand; a session reopening wants the place it was
   * left, and nothing else. */
  land: boolean,
): BrushRange | null {
  if (entries.length === 0) {
    return null;
  }
  // A comparison is brushed end to end — asking for it means asking for what it holds,
  // which is the same shape a review session opens in over its own range. A plain
  // history is not something anyone means "all of" by, so it lands on the newest entry.
  const whole = (): BrushRange | null =>
    slice.base === null ? { anchor: 0, focus: 0 } : reviewFullBrush(entries);
  if (land || slice.commitSelection === null) {
    return whole();
  }
  // Restoring: a selection the log can no longer place degrades to nothing rather than
  // to some other diff — reopening a session onto a *different* range than the one it
  // was left on is worse than reopening onto none.
  return brushFromSelection(entries, slice.commitSelection);
}

/** A review session's brush over its `base..head` ranged log, and the subrange to
 * keep: the whole review by default; the saved subrange when it still fits; else the
 * whole review, resetting the now-stale subrange so the diff shows the full review
 * (via the pin) rather than a range whose commits history has since dropped. */
export function recoverReviewBrush(
  entries: LogEntry[],
  reviewSubrange: CommitSelection | null,
): { brush: BrushRange | null; reviewSubrange: CommitSelection | null } {
  if (reviewSubrange === null) {
    return { brush: reviewFullBrush(entries), reviewSubrange: null };
  }
  const brush = brushFromSelection(entries, reviewSubrange);
  return brush === null
    ? { brush: reviewFullBrush(entries), reviewSubrange: null }
    : { brush, reviewSubrange };
}
