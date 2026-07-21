import { type ReactElement } from "react";
import { Pencil, Trash2 } from "lucide-react";
import type { Comment } from "../../../shared/review";
import { Button } from "@/components/ui/button";
import { CommentBody } from "@/components/CommentBody";
import { commentLocation } from "@/lib/comment-body";
import { cn } from "@/lib/utils";

type CommentThreadProps = {
  comment: Comment;
  /** The anchor drifted: this comment is pinned to the file header, and its
   * original location is shown (mono) since it no longer sits on its line. */
  outdated: boolean;
  /** The comment the reader just jumped to (via `n`/`p` or the sidebar list): it
   * gets a ring so the scrolled-to card is unmistakable among its neighbours. */
  active: boolean;
  onEdit: () => void;
  onDiscard: () => void;
};

/** One curated comment, rendered beneath its anchored line (or the file header
 * when outdated). The body is a human sentence in Geist sans; any inline `code`
 * ref inside it stays mono (per-element type rule). Edit/Discard are neutral —
 * the accent budget is spent only on the editor's Save. */
export function CommentThread({
  comment,
  outdated,
  active,
  onEdit,
  onDiscard,
}: CommentThreadProps): ReactElement {
  const location = commentLocation(comment);

  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border border-border bg-card px-3 py-2.5 font-sans text-card-foreground",
        // The jumped-to card: an accent ring lifts it off the surface (offset so
        // the ring reads as a halo, not a second border hugging the card edge).
        active && "ring-2 ring-primary ring-offset-2 ring-offset-diff-surface",
      )}
    >
      {outdated && (
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <span className="rounded bg-border/60 px-1.5 py-0.5 text-foreground">Outdated</span>
          <span className="truncate font-mono select-text" title={location}>
            {location}
          </span>
        </div>
      )}
      {/* Body leads, actions sit beside it top-aligned: with no timestamp header
          there is nothing to fill a dedicated top row, so the actions share the
          body's row instead of stacking an empty band above it. */}
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <CommentBody body={comment.body} />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* The ghost variant's wash is bg-muted, which equals bg-card here and
              vanishes; wash with border/60 (its dark twin too — the vendored
              dark:hover:bg-muted/50 is a separate merge group). */}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Edit comment"
            className="hover:bg-border/60 dark:hover:bg-border/60"
            onClick={onEdit}
          >
            <Pencil />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Discard comment"
            className="hover:bg-border/60 dark:hover:bg-border/60"
            onClick={onDiscard}
          >
            <Trash2 />
          </Button>
        </div>
      </div>
    </div>
  );
}
