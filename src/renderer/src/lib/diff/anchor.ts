import type { FileDiffMetadata, Hunk } from "@pierre/diffs";
import type { ReviewAnchor, ReviewSide } from "../../../../shared/review";

// A pure, deterministic placement of a `file + side + line range` anchor against
// the review's diff. No I/O and no clock — the resolved line is recomputed on
// load, never persisted. "Outdated" is a result state, not a dropped anchor: the
// authored range is kept and the consumer pins it to the file header.

/** How the anchor's diff reaches the resolver. `frozen` = the artifact embedded
 * its own patch, so the diff cannot have drifted and every anchor lands.
 * `derived` = the diff was re-derived from git; `file` is null when the anchored
 * file no longer appears in it. */
export type AnchorDiff = { kind: "frozen" } | { kind: "derived"; file: FileDiffMetadata | null };

export type AnchorResolution =
  | { status: "placed"; line: number }
  | { status: "outdated"; anchor: ReviewAnchor };

/** The inclusive line span one hunk covers on one side: new-file lines
 * `[additionStart, additionStart + additionCount - 1]` on the additions side and
 * old-file lines `[deletionStart, deletionStart + deletionCount - 1]` on the
 * deletions side (counts include context lines). A zero-count side yields an empty
 * span — `end` lands below `start`, so nothing is inside it and an addition anchor
 * can't land on a pure deletion hunk. Exported because the authoring side has to ask
 * the same question of the same hunks: an anchor is only placeable within one span,
 * so that is what a picked range gets clamped to (`comment-annotations.ts`). */
export function hunkSpan(hunk: Hunk, side: ReviewSide): { start: number; end: number } {
  const start = side === "additions" ? hunk.additionStart : hunk.deletionStart;
  const count = side === "additions" ? hunk.additionCount : hunk.deletionCount;
  return { start, end: start + count - 1 };
}

/** Whether a same-side hunk still covers the whole anchored range — a *single* hunk,
 * never the union of several: the lines between two hunks are collapsed context the
 * anchor never spanned. */
function coversRange(file: FileDiffMetadata, anchor: ReviewAnchor): boolean {
  return file.hunks.some((hunk) => {
    const span = hunkSpan(hunk, anchor.side);
    return span.start <= anchor.startLine && anchor.endLine <= span.end;
  });
}

/** Place the anchor on a line to render at, or keep it and flag it outdated when
 * the re-derived diff no longer carries its range (missing file, or a range no
 * same-side hunk covers). An embedded-patch artifact is always placed. */
export function resolveAnchor(anchor: ReviewAnchor, diff: AnchorDiff): AnchorResolution {
  if (diff.kind === "frozen") {
    return { status: "placed", line: anchor.startLine };
  }
  if (diff.file === null) {
    return { status: "outdated", anchor };
  }
  return coversRange(diff.file, anchor)
    ? { status: "placed", line: anchor.startLine }
    : { status: "outdated", anchor };
}
