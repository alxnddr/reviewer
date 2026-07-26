import { type ReactElement, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipHint } from "@/components/ui/tooltip";

type CommentNavIndicatorProps = {
  /** 1-based place of the focused comment among the navigable ones. */
  position: number;
  /** How many comments the step-through walks (placed + outdated on the visible files). */
  count: number;
  onPrevious: () => void;
  onNext: () => void;
  /** Bring the focused comment back to the centre of the viewport after the reader
   * has scrolled away from it — the one thing this control does that nothing else
   * in the app does. */
  onRecenter: () => void;
  onClose: () => void;
};

/** A shortcut key inside a tooltip. The popup paints `bg-foreground/text-background`,
 * so the chip tints off the *background* token to stay legible on it. */
function Key({ children }: { children: ReactNode }): ReactElement {
  return (
    <kbd className="rounded-sm bg-background/20 px-1 py-px font-mono text-2xs text-background">
      {children}
    </kbd>
  );
}

/** The comment stepper: the heads-up control for walking a review's comments,
 * floating at the bottom of the diff while a walk is in progress.
 *
 * It answers exactly one question — *where am I in the walk* — and offers exactly
 * three moves: back, forward, and re-centre on the comment I am on. Everything it
 * used to also say is said better elsewhere and was dropped: the file path is on the
 * sticky header directly above and in the sidebar heading, and drift ("Outdated") is
 * on the card the jump lands on. Repeating either here put the loudest type in the
 * pill on the least useful fact.
 *
 * Presentational — every action routes up to the store's `stepComment` /
 * `clearActiveComment`, except re-centre, which is pure viewport and stays in
 * `DiffView` with the scroll handle. The scroll on focus and the card ring are both
 * driven from `activeCommentId`, so this control can never disagree with them. */
export function CommentNavIndicator({
  position,
  count,
  onPrevious,
  onNext,
  onRecenter,
  onClose,
}: CommentNavIndicatorProps): ReactElement {
  return (
    <div
      role="group"
      aria-label="Review comments"
      // The app's floating-surface idiom, shared with every popover in the kit
      // (select, dropdown, combobox): a hairline ring rather than `border-border`,
      // which on the dark themes is a near-invisible grey against a near-black diff —
      // the pill read as an unanchored smudge. A pill, not a panel: the find bar owns
      // the rounded-rect-with-a-field shape at the top right, and the two overlays
      // should never be mistaken for each other at a glance.
      className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-full bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
    >
      <TooltipHint
        content={
          <>
            Previous comment <Key>p</Key>
          </>
        }
        side="top"
        align="center"
      >
        <Button
          variant="ghost"
          size="icon-sm"
          className="rounded-full"
          aria-label="Previous comment"
          onClick={onPrevious}
        >
          <ChevronLeft />
        </Button>
      </TooltipHint>

      {/* The counter is the control, not a label: after reading around the code, one
          click puts the comment back under the eye. Tabular figures keep it from
          reflowing as it ticks, and the two halves carry different ink — the position
          is what changes and what is read, the total is context. */}
      <TooltipHint content="Scroll back to this comment" side="top" align="center">
        <Button
          variant="ghost"
          size="sm"
          className="rounded-full px-2 tabular-nums"
          aria-label={`Comment ${position} of ${count} — scroll back to it`}
          onClick={onRecenter}
        >
          <span className="text-foreground">{position}</span>
          <span aria-hidden="true" className="text-text-faint">
            /
          </span>
          <span className="text-text-muted">{count}</span>
        </Button>
      </TooltipHint>

      <TooltipHint
        content={
          <>
            Next comment <Key>n</Key>
          </>
        }
        side="top"
        align="center"
      >
        <Button
          variant="ghost"
          size="icon-sm"
          className="rounded-full"
          aria-label="Next comment"
          onClick={onNext}
        >
          <ChevronRight />
        </Button>
      </TooltipHint>

      {/* Leaving the walk is a different class of action from moving inside it, so it
          sits past a divider rather than reading as a fourth step. */}
      <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-border" />

      <TooltipHint
        content={
          <>
            Stop navigating <Key>Esc</Key>
          </>
        }
        side="top"
        align="center"
      >
        <Button
          variant="ghost"
          size="icon-sm"
          className="rounded-full"
          aria-label="Stop navigating comments"
          onClick={onClose}
        >
          <X />
        </Button>
      </TooltipHint>
    </div>
  );
}
