import { memo, useCallback, useState, type ReactElement, type RefObject } from "react";
import type { CodeViewHandle, CodeViewProps } from "@pierre/diffs/react";
import type { CodeViewItem } from "@pierre/diffs";
import { Plus } from "lucide-react";
import type { ReviewAnchor } from "../../../../shared/review";
import {
  pickAddAnchor,
  selectionRange,
  type CommentSlot,
  type HoveredLine,
} from "../../../../shared/diff/comment-annotations";
import { Button } from "@/components/ui/button";
import { TooltipHint } from "@/components/ui/tooltip";

type GutterUtilityRenderer = NonNullable<CodeViewProps<CommentSlot>["renderGutterUtility"]>;

/** The gutter add affordance, as a slot renderer. Nothing about the live line selection is
 * threaded through here: the button reads it from the handle when it needs it, so a drag's
 * per-line deltas never reach React at all. Keyed on `onOpenDraft` alone, which is what
 * keeps the identity stable across everything else the view holds — see `DiffFileHeader`
 * for why a slot renderer's identity is worth this much care. */
export function useGutterUtility(
  handleRef: RefObject<CodeViewHandle<CommentSlot> | null>,
  onOpenDraft: (fileId: string, anchor: ReviewAnchor) => void,
): GutterUtilityRenderer {
  return useCallback<GutterUtilityRenderer>(
    (getHoveredLine, item) => (
      <GutterAddButton
        getHoveredLine={getHoveredLine}
        item={item}
        handleRef={handleRef}
        onOpenDraft={onOpenDraft}
      />
    ),
    [handleRef, onOpenDraft],
  );
}

type GutterAddButtonProps = {
  getHoveredLine: Parameters<GutterUtilityRenderer>[0];
  item: CodeViewItem<CommentSlot>;
  handleRef: RefObject<CodeViewHandle<CommentSlot> | null>;
  onOpenDraft: (fileId: string, anchor: ReviewAnchor) => void;
};

/** The gutter `+`: the one deliberate gesture that opens the comment editor, on the
 * hovered line or on a deliberate multi-line drag.
 *
 * Pierre's line selection is never mirrored into React. It fires a change on every line
 * delta of a gutter drag, so a mirror would cost a DiffView render — and, through the
 * portal host, a re-render of every visible file's slots — per line dragged over. The
 * anchor has always been read imperatively at click time; the label is read the same way,
 * on the way in to the button. It cannot be read at render time instead: Pierre renders
 * this slot once per item and then moves it between gutter rows, so a render-time read
 * would freeze the label at whatever was selected when the file was first painted. */
const GutterAddButton = memo(function GutterAddButton({
  getHoveredLine,
  item,
  handleRef,
  onOpenDraft,
}: GutterAddButtonProps): ReactElement {
  // True while a deliberate multi-line drag covers this file. Re-read on every way the
  // button can be reached, each of which lands before the hint's 700 ms delay elapses or
  // the accessible name is announced. All four are needed and none is redundant: `enter`
  // for the button materializing under a resting pointer (Pierre places it in response to
  // the hover, so the move that caused the hover was dispatched to the line number, not to
  // a button that did not exist yet — the browser then re-fires only the boundary events);
  // `move` for a selection that changes while the pointer is already inside; `down` for
  // touch and pen, which can tap without ever having hovered; `focus` for the keyboard.
  // Repeats are free: React bails out of a setState that does not change the value.
  const [ranged, setRanged] = useState(false);
  const syncRanged = useCallback((): void => {
    setRanged(selectionRange(handleRef.current?.getSelectedLines() ?? null, item.id) !== null);
  }, [handleRef, item.id]);

  return (
    // size-6 (24px) meets the hit-target floor; the glyph stays 12px so
    // the affordance still reads as a gutter micro-control. Accent is the add
    // trigger (only one shows at a time, on the hovered line). The label names
    // the real action: a range when a deliberate multi-line drag covers this
    // file, a single line otherwise — and the hint says the same, because a bare
    // `+` in a gutter is the one glyph here that could plausibly mean expand.
    <TooltipHint
      side="right"
      align="center"
      content={ranged ? "Comment on the selected lines" : "Comment on this line"}
    >
      <Button
        type="button"
        size="icon-xs"
        // Keep the primary fill solid on hover: the default variant's
        // `hover:bg-primary/80` reads as the add affordance dimming, not lifting.
        className="hover:bg-primary"
        aria-label={ranged ? "Add a comment on the selected lines" : "Add a comment on this line"}
        onPointerEnter={syncRanged}
        onPointerMove={syncRanged}
        onPointerDown={syncRanged}
        onFocus={syncRanged}
        // Replacing Pierre's default `[data-utility-button]` drops the
        // stacking lift and gutter offset it carried (z-index + a negative
        // right margin in the gutter's own lh/ch metric); without them our
        // composite paints under, and sits inside, the line-number column.
        // Restore Pierre's exact values so the affordance clears the numbers.
        style={{ position: "relative", zIndex: 4, marginRight: "calc(-1lh + 1ch)" }}
        onClick={() => {
          const handle = handleRef.current;
          const raw = getHoveredLine();
          // Narrow Pierre's file|diff hovered union to an anchor-side line, or
          // null (a file-mode row with no side, never a diff gutter).
          let hovered: HoveredLine | null = null;
          if (raw !== undefined && "side" in raw) {
            const side = raw.side;
            if (side === "additions" || side === "deletions") {
              hovered = { lineNumber: raw.lineNumber, side };
            }
          }
          // A deliberate multi-line drag that covers this `+` commits its range,
          // clamped to the hunk it was committed from — hunks render contiguously,
          // so a drag across the separator would otherwise anchor across collapsed
          // context no hunk covers. Otherwise the single hovered line. Clear the
          // selection either way so its highlight does not linger under the opened
          // editor.
          const anchor = pickAddAnchor(
            item.id,
            hovered,
            handle?.getSelectedLines() ?? null,
            item.type === "diff" ? item.fileDiff.hunks : [],
          );
          if (anchor !== null) {
            onOpenDraft(item.id, anchor);
            handle?.clearSelectedLines();
            setRanged(false);
          }
        }}
      >
        <Plus />
      </Button>
    </TooltipHint>
  );
});
