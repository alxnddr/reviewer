import { useState, type ReactElement } from "react";
import { ChevronDown } from "lucide-react";
import type { AnchorSpan, ReviewVisual } from "../../../../shared/review";
import { assertNever } from "../../../../shared/assert";
import { visualCounts, type ChapterBadge } from "@/lib/guide";
import { cn } from "@/lib/utils";
import { FlowDiagram } from "@/components/guide/FlowDiagram";
import { SkeletonView } from "@/components/guide/SkeletonView";
import type { AnchorDoor } from "@/components/guide/anchor-door";

// The "Before / after" card: an authored visual with its caption and the count of what it shows
// changing, in the guide's right column (the overview's picture, and a chapter's when it has
// one) and, compact and frameless, in the band above the diff.
//
// The figure is chosen by `kind` in a closed switch: a third visual kind is a compile error here
// until it has a renderer, which is the point of the discriminated union in `shared/review.ts`.

type VisualFigureProps = {
  visual: ReviewVisual;
  badgeOf: (anchor: AnchorSpan | undefined) => ChapterBadge | null;
  door: AnchorDoor;
  compact?: boolean | undefined;
};

export function VisualFigure({ visual, badgeOf, door, compact }: VisualFigureProps): ReactElement {
  switch (visual.kind) {
    case "flow":
      return <FlowDiagram visual={visual} badgeOf={badgeOf} door={door} compact={compact} />;
    case "skeleton":
      return <SkeletonView visual={visual} badgeOf={badgeOf} door={door} compact={compact} />;
    default:
      return assertNever(visual);
  }
}

/** `+2 −1 ~1`, each in its own signal colour; a zero is dropped. */
export function VisualCountsLabel({ visual }: { visual: ReviewVisual }): ReactElement {
  const counts = visualCounts(visual);
  return (
    <span className="flex shrink-0 items-baseline gap-1.5 text-sm tabular-nums">
      {counts.added > 0 && <span className="text-diff-add-fg">+{counts.added}</span>}
      {counts.removed > 0 && <span className="text-diff-del-fg">−{counts.removed}</span>}
      {counts.changed > 0 && <span className="text-warning">~{counts.changed}</span>}
    </span>
  );
}

type VisualCardProps = VisualFigureProps & {
  /** The card's title. "Before / after" on the overview; a chapter's card says the same. */
  title?: string;
  className?: string;
};

export function VisualCard({
  visual,
  badgeOf,
  door,
  title = "Before / after",
  className,
}: VisualCardProps): ReactElement {
  // Folding is the reader's, per mount: the card is the first big thing on the page, and a
  // reader who has taken it in can put it away without it costing them the steps beside it.
  const [open, setOpen] = useState(true);
  return (
    <figure
      className={cn("min-w-0 rounded-xl border border-border bg-diff-surface shadow-xs", className)}
    >
      <div className="flex items-center gap-2 px-4 pt-3">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="-ml-1 flex min-w-0 items-center gap-1.5 rounded px-1 text-base text-foreground hover:bg-border/40"
        >
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-text-faint transition-transform duration-(--duration-fast)",
              !open && "-rotate-90",
            )}
          />
          {title}
        </button>
        <span className="ml-auto">
          <VisualCountsLabel visual={visual} />
        </span>
      </div>
      <figcaption className={cn("px-4 pt-1 text-sm text-text-muted", open ? "pb-2" : "pb-3")}>
        {visual.caption}
      </figcaption>
      {open && (
        <div className={cn(visual.kind === "skeleton" ? "pb-3" : "px-1 pb-2")}>
          <VisualFigure visual={visual} badgeOf={badgeOf} door={door} />
        </div>
      )}
    </figure>
  );
}
