import type { ReactElement } from "react";
import { ArrowLeftRight } from "lucide-react";
import type { MovedSlot } from "../../../../shared/diff/moved-annotations";
import type { ReferenceSpan } from "../../../../shared/markdown";
import { Button } from "@/components/ui/button";
import { FileTypeIcon } from "@/components/FileTypeIcon";

// One line of provenance, under the first line of a moved block: *where these lines came
// from*, or *where they went*. The fact is `shared/diff/moved.ts`'s; which end carries which
// sentence, and why there are two of them, is `shared/diff/moved-annotations.ts`'s.
//
// A row, not a card. A comment is somebody's argument and earns a card; this is a caption on
// the code above it, and it sits in the same band as a comment (so the annotations of a file
// read as one family) at a third of the height. It draws in the quiet ink for the same
// reason the diff's own gutter does: a reader who is not asking "where did this go?" should
// be able to read straight past it.
//
// One glyph for both directions rather than two opposed arrows. The distinction the reader
// needs is in the two words beside it — *from* or *to* — and an arrow that has to mean "this
// left" on one end and "this arrived" on the other is a symbol carrying a direction the
// sentence already states, which is how a pair of nearly-identical corner arrows ends up
// pointing the wrong way in one of the two cases and nobody notices.

type MovedBlockNoteProps = {
  slot: MovedSlot;
  /** Go to the block's other end. The same action a prose reference's chip takes
   * (`focusReference`), because it is the same request: a file, a range inside it, and a
   * side to place it on. A moved block's ends are both in the drawn file set — a note whose
   * partner is not on screen is never built — so this click always has somewhere to land. */
  onFollow: (path: string, span: ReferenceSpan) => void;
};

/** The block's other end as the reader reads it: `src/old.ts:120-164`, one line spelled
 * without a range. The same grammar a prose reference's chip wears, which is also what the
 * author would type to point at it. */
function endLabel(span: MovedSlot["other"]): string {
  return span.startLine === span.endLine
    ? `:${span.startLine}`
    : `:${span.startLine}-${span.endLine}`;
}

export function MovedBlockNote({ slot, onFollow }: MovedBlockNoteProps): ReactElement {
  const { other } = slot;
  const marker = endLabel(other);
  return (
    <div className="bg-comment-band py-1 pr-4 pl-14 text-xs text-text-muted">
      <span className="inline-flex items-center gap-1">
        <ArrowLeftRight className="size-3.5 shrink-0" aria-hidden="true" />
        {slot.end === "to" ? "Moved from" : "Moved to"}
        <Button
          type="button"
          variant="chrome"
          size="xs"
          aria-label={`Go to ${other.file}${marker}`}
          onClick={() =>
            onFollow(other.file, {
              side: other.side,
              startLine: other.startLine,
              endLine: other.endLine,
            })
          }
          className="mx-0.5 inline-block h-auto rounded border border-border-strong px-1.5 align-baseline text-xs leading-5"
        >
          <FileTypeIcon path={other.file} className="mr-1 inline size-3 align-[-0.15em]" />
          {other.file}
          {/* Mono and a step quieter: a line number is a coordinate, not a word — the same
              treatment a prose reference's chip gives its own (`Markdown.tsx`). */}
          <span className="font-mono text-text-faint">{marker}</span>
        </Button>
        <span className="text-text-faint">
          {slot.lines} {slot.lines === 1 ? "line" : "lines"}
        </span>
      </span>
    </div>
  );
}
