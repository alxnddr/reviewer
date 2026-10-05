import { type ReactElement } from "react";
import { History, Pencil, Trash2 } from "lucide-react";
import type { Comment, CommentProse } from "../../../shared/review";
import type { CommentResolution } from "../../../shared/review-progress";
import { Button } from "@/components/ui/button";
import { TooltipHint } from "@/components/ui/tooltip";
import { CommentBody } from "@/components/CommentBody";
import { CommentEvidence } from "@/components/CommentEvidence";
import { CommentPostable } from "@/components/CommentPostable";
import { CommentMeta } from "@/components/CommentMeta";
import { CommentMark, CommentMarkMenu } from "@/components/CommentMark";
import { CopyCommentPromptButton } from "@/components/CopyPromptButton";
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
  /** What the reader decided about this finding, or null for one they have not answered.
   * Handed in from the slot rather than read here: the card lives in a CodeView portal that
   * only re-renders on an item `version` change, and the mark is folded into that version
   * (`buildDiffItems`). */
  resolution: CommentResolution | null;
  /** The postable's editor is open, inside this card. (The body's editor replaces the card
   * outright, so a card that is drawn at all is never editing its body.) */
  editingPostable: boolean;
  /** Open an editor on one of the comment's prose fields: the toolbar's Edit opens the body,
   * the postable block's own Edit opens the postable. That block is drawn only for a comment
   * the agent wrote a postable for, so there is no way here to start one. */
  onEdit: (field: CommentProse) => void;
  /** Save the postable's editor. Empty text removes the postable (`editComment`). */
  onSavePostable: (postable: string) => void;
  onCancelEdit: () => void;
  onDiscard: () => void;
  onSetResolution: (resolution: CommentResolution | null) => void;
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
 * so reaching up for the toolbar does not dismiss it.
 *
 * **One container, stacked sections.** The finding, the text for its author and its evidence
 * are sections of the one card, split by full-width dividers rather than nested inside the
 * finding's padding. Each section owns a header row and the buttons in it, so an action is
 * read as being about the section it sits in: the toolbar over the card's top edge acts on the
 * comment and edits the finding under it, and the author's text has its own Edit in its own
 * row. The earlier shape — evidence and the author's text inset under the body, inside the
 * same padding — made the toolbar's Edit read as editing all of it.
 *
 * **A marked comment goes quiet, and nothing else.** The card is not collapsed, struck
 * through or moved: the reader answered it, they did not delete it, and a review read a
 * second time has to show the same twelve findings in the same order it showed the first
 * time. Dimming is enough to make the open ones stand out in a scroll, and hovering — or
 * focusing — brings the card back to full ink so a marked comment is still readable without
 * unmarking it. */
export function CommentThread({
  comment,
  outdated,
  active,
  resolution,
  editingPostable,
  onEdit,
  onSavePostable,
  onCancelEdit,
  onDiscard,
  onSetResolution,
}: CommentThreadProps): ReactElement {
  const location = commentLocation(comment);

  return (
    <div className="group/comment relative">
      <div
        className={cn(
          // `overflow-hidden` so a section's full-width hover fill keeps the card's corners. The
          // dividers take the card edge's own ink: on a dark theme the card is lifted 11% toward
          // the foreground, which lands it on `--border` and would erase a lighter divider.
          "divide-y divide-border-strong overflow-hidden rounded-lg border border-border-strong bg-comment-surface font-sans text-foreground shadow-surface transition-[color,background-color,border-color,opacity]",
          // Answered findings recede so the open ones read as the work left. Not `hidden`
          // and not `line-through`: the first loses the review's own order and the second
          // makes prose unreadable at exactly the moment someone is re-checking whether the
          // mark was right. Full ink is one hover away, and the toolbar that unmarks it is
          // on the same hover. Focus inside the card counts as hover too: the postable's
          // editor opens in here, and text being written must not fade to 55% the moment the
          // pointer drifts off the card.
          resolution !== null &&
            "opacity-55 group-hover/comment:opacity-100 focus-within:opacity-100",
          // The jumped-to card wears the kit's own focus shape — a 1px accent edge
          // inside a soft accent halo, exactly what every control in the system does
          // on `focus-visible`.
          active && "border-primary ring-3 ring-primary/25",
        )}
      >
        <div className="px-4 py-3">
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
                <span className="truncate text-text-muted tabular-nums select-text">
                  {location}
                </span>
              </TooltipHint>
            </div>
          )}
          {/* Above the author's pills, because it is the reader's answer *to* them and the
            first thing they need on a second pass ("did I already deal with this?"). It is
            greyscale where those are coloured, which is the whole visual grammar: hue is
            what the review said, ink is what the reader did — and it is what keeps the mark
            apart from the warning-toned drift row above it. */}
          <CommentMark resolution={resolution} className="mb-1.5" />
          {/* Above the body, on its own line, and only when the author set something: the
            pills are how the reader decides whether to read this card at all, so they come
            before the sentence rather than trailing it. Sharing the outdated row was the
            rejected alternative — drift is a warning about placement and these are the
            author's own vocabulary, and a row that mixes them reads as one claim. */}
          <CommentMeta comment={comment} className="mb-1.5 flex-wrap" />
          <CommentBody body={comment.body} />
        </div>
        {/* Straight under the finding, above its receipts: the author's text is the finding
            rewritten, so it reads as the second half of the claim, and it is always open where
            the evidence is a folded row — a fold between the two would split the claim from
            its rewrite and push the visible text below a control the reader mostly skips. */}
        <CommentPostable
          comment={comment}
          editing={editingPostable}
          onEdit={() => onEdit("postable")}
          onSave={onSavePostable}
          onCancel={onCancelEdit}
        />
        {comment.evidence !== undefined && <CommentEvidence evidence={comment.evidence} />}
      </div>
      {/* Its own popover surface, so it reads as hovering above the diff rather than
          printed on it — the same treatment the stepper and the find bar take. */}
      <div className="absolute right-2 bottom-full mb-1 flex items-center gap-0.5 rounded-lg bg-popover p-0.5 opacity-0 shadow-md ring-1 ring-foreground/10 transition-opacity duration-(--duration-fast) group-hover/comment:opacity-100 focus-within:opacity-100">
        {/* Four glyphs on a surface that only appears on hover: whichever one the reader is
            reaching for, they arrived without a label. `top`, so the popup opens away from
            the card it is about rather than over the comment body.

            The mark leads, then Copy, then Edit, and Discard trails — the order of how often
            they are wanted and the reverse of how much they cost. Every one of them is about
            *this comment*, which is the set's rule and the reason there were five: an open-in-
            editor glyph sat second, and an external-link arrow inside a card whose subject is
            the comment reads as a link to the comment while doing something else entirely.
            `E` opens the focused comment's line (`App.tsx`, through `lib/editor-target.ts`),
            so the capability is where it was advertised and the card no longer claims it.

            The order is also the only one that takes a new glyph without moving the rest: the
            strip is right-anchored and grows leftward, so an insertion at this end leaves
            Copy, Edit and Discard under the hand that already knows where they are. */}
        <CommentMarkMenu resolution={resolution} onSetResolution={onSetResolution} />
        <CopyCommentPromptButton commentId={comment.id} />
        <TooltipHint content="Edit finding" side="top" align="center">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Edit finding"
            className="text-text-muted hover:bg-foreground/10 hover:text-foreground dark:hover:bg-foreground/10"
            onClick={() => onEdit("body")}
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
