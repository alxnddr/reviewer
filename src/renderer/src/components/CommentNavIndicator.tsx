import { type ReactElement } from "react";
import { ChevronLeft, ChevronRight, MessageSquare, X } from "lucide-react";
import { Button } from "@/components/ui/button";

type CommentNavIndicatorProps = {
  /** 1-based place of the focused comment among the navigable ones. */
  position: number;
  /** How many comments the step-through walks (placed + outdated on the visible files). */
  count: number;
  /** The focused comment's `path:Ln` location (mono). */
  location: string;
  /** The focused comment drifted off its line and sits at the file header. */
  outdated: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
};

/** The floating comment navigator: a bottom-centre pill that shows where the reader
 * is in the comment walk (`i/N` + the focused comment's location) and steps prev/
 * next. Kept clear of the top-right find bar so the two overlays never collide.
 * Presentational — every action routes up to the store's `stepComment`/
 * `clearActiveComment`; the scroll + card ring are driven from `activeCommentId`. */
export function CommentNavIndicator({
  position,
  count,
  location,
  outdated,
  onPrevious,
  onNext,
  onClose,
}: CommentNavIndicatorProps): ReactElement {
  return (
    <div
      role="navigation"
      aria-label="Review comments"
      className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-border bg-popover p-1 pl-2 text-sm shadow-md"
    >
      <MessageSquare aria-hidden="true" className="size-3.5 shrink-0 text-text-muted" />
      {/* Tabular figures keep the count from reflowing as it ticks through comments. */}
      <span className="shrink-0 px-1 text-xs text-text-muted tabular-nums">
        {position}/{count}
      </span>
      <span className="max-w-56 min-w-0 truncate font-mono text-xs select-text" title={location}>
        {location}
      </span>
      {outdated && (
        <span className="shrink-0 rounded bg-border/60 px-1.5 py-0.5 text-xs text-foreground">
          Outdated
        </span>
      )}
      <Button variant="ghost" size="icon-sm" aria-label="Previous comment" onClick={onPrevious}>
        <ChevronLeft />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Next comment" onClick={onNext}>
        <ChevronRight />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Stop navigating comments"
        onClick={onClose}
      >
        <X />
      </Button>
    </div>
  );
}
