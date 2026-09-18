import { type ReactElement } from "react";
import { History, Pencil, Trash2 } from "lucide-react";
import type { Comment } from "../../../shared/review";
import { Button } from "@/components/ui/button";
import { TooltipHint } from "@/components/ui/tooltip";
import { CommentBody } from "@/components/CommentBody";
import { CommentEvidence } from "@/components/CommentEvidence";
import { CommentMeta } from "@/components/CommentMeta";
import { CopyCommentPromptButton } from "@/components/CopyPromptButton";
import { OpenInEditorButton } from "@/components/OpenInEditorButton";
import { commentLocation } from "@/lib/comment-location";
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
 * when outdated).
 *
 * **The surface.** `--comment-surface`, which on a light theme is the same paper
 * white as the code behind it: prose belongs on white, and the ramp's own raised
 * tones do not offer it — `--muted` is a grey wash under the body on both light
 * themes, and `--surface` is that same wash on pierre-light and the page itself on
 * github-light, which leaves the card no edge at all.
 * What a white card gives up is *noticeability*, so that job moves out to the band
 * the card sits in — see `CommentAnnotationFrame`. On a dark theme there is nothing
 * lighter than the diff surface to be paper, so the card rises off the band instead.
 * Either way the reader gets three distinct tones and a body at full contrast.
 *
 * **The actions float above it.** Edit and discard used to sit in the body's row,
 * so every comment surrendered a strip of measure to two buttons the reader mostly
 * does not want. They are now a small toolbar on its own popover surface, pinned
 * over the card's top edge and revealed on hover or keyboard focus. It costs no
 * layout and covers no comment text; while shown it overlaps the code line above,
 * which is hover-only, right-aligned (where lines have usually already ended), and
 * back the moment the pointer leaves. The hover group is the wrapper, not the card,
 * so reaching up for the toolbar does not dismiss it. */
export function CommentThread({
  comment,
  outdated,
  active,
  onEdit,
  onDiscard,
}: CommentThreadProps): ReactElement {
  const location = commentLocation(comment);

  return (
    <div className="group/comment relative">
      <div
        className={cn(
          "rounded-lg border border-border-strong bg-comment-surface px-4 py-3 font-sans text-foreground shadow-surface transition-colors",
          // The jumped-to card wears the kit's own focus shape — a 1px accent edge
          // inside a soft accent halo, exactly what every control in the system does
          // on `focus-visible`.
          active && "border-primary ring-3 ring-primary/25",
        )}
      >
        {outdated && (
          // Drift is a warning about placement, not a chip: the badge fill used here
          // before was `--selected`, the app's neutral selection tone, so a drifted
          // comment read as a *selected* one. The glyph carries the state and the
          // authored location follows it quietly — the same pairing the sidebar row uses
          // for the same fact.
          <div className="mb-1.5 flex min-w-0 items-center gap-1.5 text-xs">
            <History aria-hidden="true" className="size-3 shrink-0 text-warning" />
            <span className="shrink-0 text-warning">Outdated</span>
            <span aria-hidden="true" className="shrink-0 text-text-faint">
              ·
            </span>
            <TooltipHint content={location} whenTruncated side="top" align="start">
              <span className="truncate text-text-muted tabular-nums select-text">{location}</span>
            </TooltipHint>
          </div>
        )}
        {/* Above the body, on its own line, and only when the author set something: the
            pills are how the reader decides whether to read this card at all, so they come
            before the sentence rather than trailing it. Sharing the outdated row was the
            rejected alternative — drift is a warning about placement and these are the
            author's own vocabulary, and a row that mixes them reads as one claim. */}
        <CommentMeta comment={comment} className="mb-1.5 flex-wrap" />
        <CommentBody body={comment.body} />
        {comment.evidence !== undefined && <CommentEvidence evidence={comment.evidence} />}
      </div>
      {/* Its own popover surface, so it reads as hovering above the diff rather than
          printed on it — the same treatment the stepper and the find bar take. */}
      <div className="absolute right-2 bottom-full mb-1 flex items-center gap-0.5 rounded-lg bg-popover p-0.5 opacity-0 shadow-md ring-1 ring-foreground/10 transition-opacity duration-(--duration-fast) group-hover/comment:opacity-100 focus-within:opacity-100">
        {/* Four glyphs on a surface that only appears on hover: whichever one the reader is
            reaching for, they arrived without a label. `top`, so the popup opens away from
            the card it is about rather than over the comment body.

            Open in editor leads, then Copy, and Discard trails — the order of how often they
            are wanted and the reverse of how much they cost. It is also the only order that
            takes a new glyph without moving the rest: the strip is right-anchored and grows
            leftward, so an insertion at this end leaves Copy, Edit and Discard under the
            hand that already knows where they are. The open lands on the comment's first
            line, translated to the file on disk (`lib/editor-target.ts`). */}
        <OpenInEditorButton
          path={comment.file}
          anchorSide={comment.side}
          anchorLine={comment.startLine}
          hintSide="top"
          hintAlign="start"
          className="hover:bg-foreground/10 hover:text-foreground dark:hover:bg-foreground/10"
        />
        <CopyCommentPromptButton commentId={comment.id} />
        <TooltipHint content="Edit comment" side="top" align="center">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Edit comment"
            className="text-text-muted hover:bg-foreground/10 hover:text-foreground dark:hover:bg-foreground/10"
            onClick={onEdit}
          >
            <Pencil />
          </Button>
        </TooltipHint>
        <TooltipHint content="Discard comment" side="top" align="end">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Discard comment"
            className="text-text-muted hover:bg-destructive/10 hover:text-destructive dark:hover:bg-destructive/15"
            onClick={onDiscard}
          >
            <Trash2 />
          </Button>
        </TooltipHint>
      </div>
    </div>
  );
}
