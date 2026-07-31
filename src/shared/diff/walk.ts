import type { FileDiffMetadata, Hunk } from "@pierre/diffs";
import { assertNever } from "../assert";
import type { ReviewSide } from "../review";

// The one walk over a parsed file's hunks, and the one piece of hunk-header arithmetic
// beside it. `@pierre/diffs` exposes no public per-line iterator — `getTotalLineCountFromHunks`
// is the only line-count util and `SharedRenderState.lineInfo` is internal — so turning its
// block structure into line coordinates is legitimately the app's job. It is done here, once:
// the search index, the snippet preview and the coverage universe are all adapters over
// `walkFileLines`, so they can never disagree about which line of which side a `+`, a `-` or a
// context row landed on.
//
// The geometry has two models and both live here on purpose:
//
//   - `walkFileLines` reads a hunk's *content* — its `+`/`-`/context runs, at the coordinates
//     they advance to from the header's `additionStart`/`deletionStart`;
//   - `hunkSpan` reads a hunk's *header* — the `[start, start + count - 1]` it claims.
//
// For a hunk git wrote the two agree exactly: a side's context lines plus its own changed
// lines sum to that side's header count, so the walk tiles the span with nothing left over
// (`walk.test.ts` pins this over every fixture patch). They part company only on a patch whose
// header lies about its body — an imported artifact can embed any bytes — and there the
// difference is deliberate: the walk names lines that exist, while the span answers "could an
// anchor live here", which is a question about the claimed geometry and must keep answering it
// the same way for anchors already stored against it (`anchor.ts`, task 004).

/** One line of a hunk, in one side's file coordinates.
 *
 * A change line exists on the side it was written on. A context line exists on *both*, so the
 * walk emits it twice — once per side, each in that side's own coordinates — and a consumer
 * that renders context as a single row (the unified reading order does) keeps the `additions`
 * copy, whose number is the one that row carries. */
export type WalkedLine = {
  side: ReviewSide;
  kind: "context" | "addition" | "deletion";
  /** 1-based file line number on `side`: new-file for additions, old-file for deletions. */
  lineNumber: number;
  /** Where this line's text sits in the side's `additionLines`/`deletionLines` array. Taken
   * straight from the block, so an out-of-range read on a malformed patch is the consumer's
   * `?? ""` to degrade on rather than this walk's to throw. */
  index: number;
};

/** Whether the visitor asked to keep going. `false` stops the walk; anything else — including
 * a visitor that returns nothing at all — continues. */
export type WalkVisitor = (line: WalkedLine) => boolean | void;

/** Walk every line of a file's hunks in unified rendering order, advancing an addition cursor
 * (new-file coords) and a deletion cursor (old-file coords) from each hunk header's
 * `additionStart`/`deletionStart`. A context block advances both cursors in lockstep and emits
 * each of its lines on both sides; a change block emits its deletions first and then its
 * additions — the order a unified diff reads — advancing only the side it wrote.
 *
 * Stopping early is part of the contract, not an optimization the caller has to fake: a
 * consumer that is past the range it wants returns `false` and a 3-line preview never walks a
 * 4000-line file to its end.
 *
 * A file with no hunks walks nothing — a binary change and a pure rename carry none, so they
 * contribute no searchable line, no preview and no coverable line, all by this one rule. */
export function walkFileLines(file: FileDiffMetadata, visit: WalkVisitor): void {
  for (const hunk of file.hunks) {
    if (!walkHunkLines(hunk, visit)) {
      return;
    }
  }
}

/** One hunk's lines. False once the visitor has asked to stop, which ends the whole walk. */
function walkHunkLines(hunk: Hunk, visit: WalkVisitor): boolean {
  let additionLine = hunk.additionStart;
  let deletionLine = hunk.deletionStart;
  /** One block's run of lines on one side: `count` lines numbered from `from`, whose text sits
   * from `index` on in that side's array. False the moment the visitor asks to stop. */
  const emitRun = (
    side: ReviewSide,
    kind: WalkedLine["kind"],
    from: number,
    index: number,
    count: number,
  ): boolean => {
    for (let offset = 0; offset < count; offset += 1) {
      if (visit({ side, kind, lineNumber: from + offset, index: index + offset }) === false) {
        return false;
      }
    }
    return true;
  };
  for (const block of hunk.hunkContent) {
    if (block.type === "context") {
      // One rendered row carrying a number on each side, so it is emitted on both — deletions
      // first, the order a change block reads in too.
      if (!emitRun("deletions", "context", deletionLine, block.deletionLineIndex, block.lines)) {
        return false;
      }
      if (!emitRun("additions", "context", additionLine, block.additionLineIndex, block.lines)) {
        return false;
      }
      additionLine += block.lines;
      deletionLine += block.lines;
    } else if (block.type === "change") {
      const { deletions, additions } = block;
      if (!emitRun("deletions", "deletion", deletionLine, block.deletionLineIndex, deletions)) {
        return false;
      }
      deletionLine += deletions;
      if (!emitRun("additions", "addition", additionLine, block.additionLineIndex, additions)) {
        return false;
      }
      additionLine += additions;
    } else {
      // `@pierre/diffs` is a moving beta: a block kind added upstream must break the build
      // here rather than silently drop lines out of a search index, a preview, or the
      // coverage universe.
      assertNever(block);
    }
  }
  return true;
}

/** The inclusive line span one hunk covers on one side: new-file lines
 * `[additionStart, additionStart + additionCount - 1]` on the additions side and old-file lines
 * `[deletionStart, deletionStart + deletionCount - 1]` on the deletions side (counts include
 * context lines). A zero-count side yields an empty span — `end` lands below `start`, so
 * nothing is inside it and an addition anchor can't land on a pure deletion hunk. Exported
 * because both sides of anchoring have to ask the same question of the same hunks: an anchor is
 * only placeable within one span (`anchor.ts`), so that is what a picked range gets clamped to
 * (`comment-annotations.ts`). */
export function hunkSpan(hunk: Hunk, side: ReviewSide): { start: number; end: number } {
  const start = side === "additions" ? hunk.additionStart : hunk.deletionStart;
  const count = side === "additions" ? hunk.additionCount : hunk.deletionCount;
  return { start, end: start + count - 1 };
}
