import type { DiffLineAnnotation } from "@pierre/diffs";
import type { AnchorSpan } from "../review";
import type { MovedBlock } from "./moved";

// The render half of moved-code detection: a `MovedBlock` turned into the two annotations
// that say so on the surface. `moved.ts` answers *which* lines moved and refuses to draw;
// this answers where the sentence about them hangs, and still draws nothing — the component
// is `components/diff/MovedBlockNote.tsx`.
//
// Three decisions are made here, and each was open until this module existed.
//
// ## Both ends, not one
//
// A block is annotated at `from` *and* at `to`. Annotating only the destination is the
// tempting half — it is where the code now lives — but it leaves the other end exactly as
// it was: 200 deletions with nothing saying where they went, which is the reading failure
// the whole feature exists to fix, and the end a reader hits *first* when the move runs
// down the file. The two notes do not say the same thing twice: each names the other end,
// so the pair is a round trip and either one is the answer to the question the reader is
// actually asking at that point in the diff ("where did this go?" / "where is this from?").
//
// ## The collision with a comment is stacking, decided by array order
//
// A moved block's first line is exactly the kind of line a reviewer comments on, so the two
// annotation kinds meet on one line routinely. They do not contend for a slot: Pierre keys
// an annotation's slot by side and line (`getLineAnnotationName`) and renders *every*
// light-DOM child assigned to it, in document order — which is the order of the item's
// `annotations` array. So the question is only which goes first, and the move goes first
// (`buildDiffItems` pushes these before the comments): the note is a property of the
// line itself, one quiet row high, and the comment is a discussion of it. Sinking a
// one-line provenance note beneath a card that can be a paragraph tall would put it where
// nothing connects it to the line it describes.
//
// ## A note is only drawn when its other end is on screen
//
// Detection runs over the *whole* diff — the fact is about the review, not about what is
// soloed, and it is memoised per load (`lib/diff/moved-blocks.ts`) — but a chapter solo
// draws a subset of the files. A note whose other end is not drawn would be a link to
// nowhere: clicking it asks the surface to scroll to a file it is not rendering, which is
// silence, the one response a control must never give. Dropping the pair instead leaves the
// soloed chapter exactly as it read before this feature, which is honest, and re-soloing to
// the full diff brings the note back — the fact never changed, only what is on screen.

/** One end of a moved block, as the surface draws it. `end` says which end this is — what
 * the reader is looking at — and `other` is the round trip: the span the note names and
 * navigates to. */
export type MovedSlot = {
  kind: "moved";
  /** `"to"` sits on the additions that arrived; `"from"` on the deletions that left. */
  end: "from" | "to";
  /** The block's other end, which the note names and the click goes to. */
  other: AnchorSpan;
  /** Matched line count, the same at both ends. */
  lines: number;
};

/** The annotation each end of each block contributes, keyed by the path of the file it is
 * drawn in — the same key `buildDiffItems` walks, so a caller looks its file's list up
 * under `file.path` and pushes it.
 *
 * `drawn` is what the surface is currently rendering (a solo's subset, or every file): a
 * block with an end outside it contributes *neither* annotation, for the reason in the
 * header. Ordering within a file follows the block order `detectMovedBlocks` produced,
 * which is destination reading order; two ends that land on the same line (only reachable
 * for a move inside one file) keep that order rather than being merged, since they say
 * different things. */
export function movedAnnotationsByFile(
  blocks: readonly MovedBlock[],
  drawn: ReadonlySet<string>,
): Map<string, DiffLineAnnotation<MovedSlot>[]> {
  const byFile = new Map<string, DiffLineAnnotation<MovedSlot>[]>();
  const push = (span: AnchorSpan, slot: MovedSlot): void => {
    const annotation: DiffLineAnnotation<MovedSlot> = {
      side: span.side,
      // The block's *first* line: a note under its last would be a caption for the code
      // above it, and the reader scrolling down would meet the block before its
      // explanation.
      lineNumber: span.startLine,
      metadata: slot,
    };
    const list = byFile.get(span.file);
    if (list === undefined) {
      byFile.set(span.file, [annotation]);
    } else {
      list.push(annotation);
    }
  };
  for (const block of blocks) {
    if (!drawn.has(block.from.file) || !drawn.has(block.to.file)) {
      continue;
    }
    push(block.to, { kind: "moved", end: "to", other: block.from, lines: block.lines });
    push(block.from, { kind: "moved", end: "from", other: block.to, lines: block.lines });
  }
  return byFile;
}

/** One end's identity, folded into an item's `version` so a change to the set of notes on a
 * file repaints it — the same rule every other slot obeys (`annotationsVersion`). Every
 * field the note renders is in here; `lines` is derived from the spans but is spelled out
 * anyway, since it is printed. */
export function movedSlotKey(annotation: DiffLineAnnotation<MovedSlot>): string {
  const slot = annotation.metadata;
  const { file, side, startLine, endLine } = slot.other;
  return `m|${annotation.side}|${annotation.lineNumber}|${slot.end}|${file}|${side}|${startLine}-${endLine}|${slot.lines}`;
}
