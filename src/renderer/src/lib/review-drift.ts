import type { CommitSha } from "../../../shared/git";
import type { ReviewDiff } from "../../../shared/review";
import type { LogState } from "./load-state";
import { headShaOf } from "./session-projection";

// Whether the branch has moved on since the review was written, and by how much.
//
// A review's `head` is usually a branch *name* — deliberately, so the review follows the
// branch — which means an artifact authored at commit A and opened at commit D looks
// exactly like one authored at D. The anchors say so obliquely (they go outdated), but that
// reads as "this finding drifted", not as "you are looking at three commits the reviewer
// never saw". `reviewedHead` is the artifact's answer (shared/review.ts); this is the one
// place the app compares it to what the branch points at now.
//
// Pure, and derived from what the session already has. The current head is the newest commit
// in the walk the picker has loaded anyway — for a review session that walk is the review's
// own `base..head` (`logRangeFor`) — so nothing here spawns git, and the count of commits
// since is a position in that same list rather than a `rev-list --count` of its own.

/** The branch moved: where the review was written, where the branch is now, and how far
 * apart they are. Only ever produced when the two actually differ. */
export type ReviewDrift = {
  /** The sha the artifact recorded, abbreviated for chrome (`lib/refs.ts`'s rule). */
  reviewedHead: CommitSha;
  currentHead: CommitSha;
  /** How many commits landed after the reviewed one, or null when the loaded walk does not
   * contain it at all — a rebase, a force-push, or a base that moved. Null is not zero: it
   * means the question has no answer from this log, and the sentence says less rather than
   * guessing. */
  since: number | null;
};

export type ReviewDriftInput = {
  /** What the artifact said it was written against; null for one that predates the field. */
  reviewedHead: CommitSha | null;
  /** The session's pin. Only a `refs` pin can drift: a frozen review renders the exact
   * bytes it carries, so "the branch moved" is true but says nothing about what is on
   * screen — and a plain repo session (null) has no authored moment to have drifted from. */
  reviewDiff: ReviewDiff | null;
  log: LogState | null;
};

export function reviewDrift({
  reviewedHead,
  reviewDiff,
  log,
}: ReviewDriftInput): ReviewDrift | null {
  if (reviewedHead === null || reviewDiff === null || reviewDiff.kind !== "refs") {
    return null;
  }
  const currentHead = headShaOf(log);
  // No log yet (or an unborn repo) is not "no drift" — it is nothing to compare against, and
  // the honest rendering of that is silence rather than a line that appears a second later.
  if (currentHead === null || currentHead === reviewedHead) {
    return null;
  }
  return { reviewedHead, currentHead, since: commitsSince(reviewedHead, log) };
}

/** Where the reviewed commit sits in the loaded walk, counted from the newest — which is
 * exactly how many commits have landed on top of it. The walk is newest-first and carries at
 * most one non-commit row (the working tree), so the count is the number of *commit* entries
 * ahead of it and not the raw index. */
function commitsSince(reviewedHead: CommitSha, log: LogState | null): number | null {
  if (log === null || log.phase !== "loaded") {
    return null;
  }
  let ahead = 0;
  for (const entry of log.entries) {
    if (entry.kind !== "commit") {
      continue;
    }
    if (entry.commit.sha === reviewedHead) {
      return ahead;
    }
    ahead += 1;
  }
  return null;
}
