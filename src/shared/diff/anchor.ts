import type { FileDiffMetadata } from "@pierre/diffs";
import type { ReviewAnchor } from "../review";
import { hunkSpan } from "./walk";

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

/** Whether a same-side hunk still covers the whole anchored range — a *single* hunk,
 * never the union of several: the lines between two hunks are collapsed context the
 * anchor never spanned.
 *
 * The question is asked of the hunk *header*'s span (`hunkSpan`, walk.ts) rather than of
 * the lines the walk actually visits, and the two only differ on a patch whose header lies
 * about its body. "Covered" is what already-stored anchors were resolved against — and
 * `rvw check` resolves them the same way — so it stays the claimed geometry. */
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
