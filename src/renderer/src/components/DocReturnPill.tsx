import { type ReactElement } from "react";
import { ArrowLeft, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GLASS_DIVIDER, GLASS_MUTED, GLASS_PRIMARY } from "@/components/Glass";
import { ShortcutHint } from "@/components/ui/kbd";
import { TooltipHint } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type DocReturnPillProps = {
  /** Reopen the overview — on a live trip, which is the only time this is drawn, that is the
   * exact paragraph the reader left (`planDocReturn`). */
  onBack: () => void;
  /** End the trip where the reader stands: the pill goes and does not come back until the
   * document is next left. */
  onDismiss: () => void;
};

/** The way back to the overview, floating over the diff for as long as the reader is on a
 * *trip* (`docTrip` in `stores/review/slice.ts`): they left the document and have not
 * navigated by their own hand since.
 *
 * It is the overview's own island turned round. "Start reviewing →" sits bottom-centre on the
 * document as a glass pill; the click that takes it lands the reader on the diff with this in
 * the same place, the same glass, the arrow pointing the other way — so the way out and the way
 * back read as one control, and nobody has to be told where to look for it.
 *
 * It replaced a `↩` trailing the rail's Overview row, which was the whole visible surface of
 * the return and was not enough of one: a 14 px glyph in a column the reader is not looking at
 * at the moment they need it (they have just clicked something in the *page* and are looking
 * at the page), invisible with the sidebar hidden, and saying nothing a reader who had not
 * read the tooltip could decode. The reader's word for it was "trash". The row is the plain
 * door to the document again; `o` and the row still return to the exact place during a trip,
 * they just no longer advertise it.
 *
 * Two ways for it to go, and both are the trip ending. The reader navigates — a file step, a
 * chapter, a comment — and it goes on its own, because a Back that outlives the glance it was
 * for is "a back button on the diff, on offer for ever", which is what the trip rule exists to
 * avoid. Or they press ×, which says the same thing out loud for the reader who is staying to
 * read this file for a while and wants the code under the pill back (`dismissDocTrip`). There
 * is no third state in which the pill is hidden and the trip is live.
 *
 * Presentational, like the comment stepper it shares the bottom of the pane with; `DiffView`
 * owns where the two sit. */
export function DocReturnPill({ onBack, onDismiss }: DocReturnPillProps): ReactElement {
  return (
    <div
      role="group"
      aria-label="Return to the overview"
      data-glass
      data-doc-return
      className="pointer-events-auto flex items-center rounded-full p-1 text-popover-foreground"
    >
      <TooltipHint
        content={<ShortcutHint id="overview.toggle" label="Back to where you were" />}
        side="top"
        align="center"
      >
        <Button
          variant="ghost"
          className={cn("rounded-full", GLASS_PRIMARY)}
          // Invoked, not handed over, for the stepper's reason: both handlers are
          // session-bound upstream and would take React's event as an argument.
          onClick={() => onBack()}
        >
          <ArrowLeft aria-hidden="true" data-icon="inline-start" />
          Back to overview
        </Button>
      </TooltipHint>

      {/* Going back and giving up the way back are different classes of action, so the × sits
          past a divider, as the stepper's does. */}
      <span aria-hidden="true" className={GLASS_DIVIDER} />

      <TooltipHint content="Dismiss" side="top" align="center">
        <Button
          variant="ghost"
          size="icon"
          className={cn("rounded-full", GLASS_MUTED)}
          aria-label="Dismiss the way back to the overview"
          onClick={() => onDismiss()}
        >
          <X />
        </Button>
      </TooltipHint>
    </div>
  );
}
