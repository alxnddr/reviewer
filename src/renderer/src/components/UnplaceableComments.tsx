import { useState, type ReactElement } from "react";
import { ChevronDown, ChevronUp, MapPinOff } from "lucide-react";
import type { Comment } from "../../../shared/review";
import { Button } from "@/components/ui/button";
import { TooltipHint } from "@/components/ui/tooltip";
import { CommentBody } from "@/components/CommentBody";
import { commentLocation } from "@/lib/comment-body";

type UnplaceableCommentsProps = {
  /** Comments whose file is absent from the loaded diff — already derived by
   * `unplaceableComments`, never the full set. */
  comments: Comment[];
  onDiscard: (commentId: string) => void;
  /** True when these comments are absent only because the reviewer narrowed to a
   * subset of the review's commits, not because their file genuinely drifted. The
   * fix is to widen back, so the bar offers that and withholds Discard — the
   * comments belong to the review, just not to the commits currently on screen. */
  narrowed: boolean;
  onReset: () => void;
};

/** The surface for comments the loaded diff has no line to host: either the
 * re-derived diff drifted (they stay in session state so they round-trip), or the
 * reviewer narrowed to a subset of the review's commits and their file is outside
 * it. A collapsed count bar keeps them discoverable without taking the reader's
 * space; expanded, each names its file (mono — machine text) so the reader knows
 * where it belonged. When narrowed, a "Show full review" action widens back (the
 * real fix) and Discard is withheld; when genuinely drifted, Discard curates. Null
 * when nothing is stranded, so the bar is absent on an ordinary review. */
export function UnplaceableComments({
  comments,
  onDiscard,
  narrowed,
  onReset,
}: UnplaceableCommentsProps): ReactElement | null {
  const [expanded, setExpanded] = useState(false);

  if (comments.length === 0) {
    return null;
  }
  const count = comments.length;
  const label = narrowed
    ? count === 1
      ? "1 comment isn’t in the selected commits"
      : `${count} comments aren’t in the selected commits`
    : count === 1
      ? "1 comment couldn’t be placed"
      : `${count} comments couldn’t be placed`;

  return (
    <div className="shrink-0 border-b border-border bg-sidebar">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          // A count/hint line, not a CTA: the whole label stays clickable, but the
          // hover only brightens the ink (no wide fill box) — the chevron carries the
          // disclosure affordance.
          className="-ml-1.5 gap-1.5 text-text-muted hover:bg-transparent hover:text-foreground dark:hover:bg-transparent"
        >
          <MapPinOff aria-hidden="true" className="size-3.5" />
          {label}
          {expanded ? (
            <ChevronUp aria-hidden="true" className="size-3.5" />
          ) : (
            <ChevronDown aria-hidden="true" className="size-3.5" />
          )}
        </Button>
        {narrowed && (
          // The widen-back shortcut stays a quiet neutral action — hover only brightens
          // the ink (no fill, no underline, no accent), not a filled button competing
          // with the diff below.
          <Button
            variant="ghost"
            size="sm"
            onClick={onReset}
            className="ml-auto text-text-muted hover:bg-transparent hover:text-foreground dark:hover:bg-transparent"
          >
            Show full review
          </Button>
        )}
      </div>
      {expanded && (
        <ul className="max-h-56 overflow-y-auto px-3 pb-3">
          {comments.map((comment) => (
            <li key={comment.id} className="pt-2">
              <UnplaceableRow comment={comment} onDiscard={onDiscard} showDiscard={!narrowed} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type UnplaceableRowProps = {
  comment: Comment;
  onDiscard: (commentId: string) => void;
  showDiscard: boolean;
};

/** One stranded comment, on the same raised surface as a placed `CommentThread` —
 * same fill, same edge, same body — but headed by its file location, since it has no
 * line to sit on. */
function UnplaceableRow({ comment, onDiscard, showDiscard }: UnplaceableRowProps): ReactElement {
  const location = commentLocation(comment);

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border-strong bg-comment-surface px-4 py-3 font-sans text-foreground">
      <div className="flex items-center gap-2 text-xs text-text-muted">
        <TooltipHint content={location} whenTruncated side="top" align="start">
          <span className="min-w-0 truncate tabular-nums select-text">{location}</span>
        </TooltipHint>
        {showDiscard && (
          <Button
            variant="ghost"
            size="sm"
            // `bg-border/60` is `--selected`, the app's neutral selection tone — a
            // discard button that washes selection-coloured reads as a picked row.
            className="ml-auto shrink-0 text-text-muted hover:bg-destructive/10 hover:text-destructive dark:hover:bg-destructive/15"
            onClick={() => onDiscard(comment.id)}
          >
            Discard
          </Button>
        )}
      </div>
      <CommentBody body={comment.body} />
    </div>
  );
}
