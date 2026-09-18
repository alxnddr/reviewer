import { memo, type ReactElement } from "react";
import type { Comment } from "../../../shared/review";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ShortcutHint } from "@/components/ui/kbd";
import { TooltipHint } from "@/components/ui/tooltip";
import { useCopiedFlash } from "@/lib/copy-feedback";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { countLabel } from "../../../shared/plural";
import { tallyResolutions, NO_RESOLUTIONS } from "../../../shared/comment-resolution";
import { selectActiveSlice, useReviewStore } from "@/stores/review";

// The two controls that hand a review's comments to an agent: one comment, from the card it
// is on, and every comment, from the bar that counts them.
//
// Both read the store and call it directly rather than taking a callback, which is what the
// diff surface's other leaf controls do (`FileReadToggle`, `FileFoldToggle`) and for the
// same two reasons. Pierre re-renders a file's slots only when the item's fingerprint
// changes, so a prop-threaded copy would flash its check on a reconciliation rather than on
// the click; and a callback threaded through `DiffScreen` → `DiffView` → the annotation
// renderer is plumbing for a button that needs exactly one id.
//
// The check is driven by the store's `promptCopy` nonce, not by the click, because the click
// is not the only way here: ⇧⌘C and ⌥⇧⌘C arrive as menu commands and never touch these
// components. Watching what was copied rather than what was pressed is what lets the glyph
// answer either one.
//
// A failed clipboard write shows nothing at all. That is the whole error surface, and it is
// enough precisely because the success case is so quiet: no check means it did not happen.

/** The copy glyph, or the check that stands in for it after a copy landed. */
function CopyGlyph({ copied }: { copied: boolean }): ReactElement {
  return copied ? <Check /> : <Copy />;
}

/** One comment, on the clipboard as a prompt. Sits leftmost in the card's hover toolbar:
 * furthest from Discard, which is the one control there that cannot be taken back, and — the
 * strip being right-anchored and growing leftward — the one insertion point that leaves Edit
 * and Discard exactly where a returning hand already expects them. */
export const CopyCommentPromptButton = memo(function CopyCommentPromptButton({
  commentId,
}: {
  commentId: string;
}): ReactElement {
  const copyCommentPrompt = useReviewStore((state) => state.copyCommentPrompt);
  const nonce = useReviewStore((state) => {
    const copy = state.promptCopy;
    return copy?.scope === "comment" && copy.commentId === commentId ? copy.nonce : null;
  });
  const copied = useCopiedFlash(nonce);

  return (
    // `start`, so the popup opens away from the two buttons beside it — the same rule that
    // gives Edit `center` and Discard `end`.
    <TooltipHint
      content={copied ? "Copied" : <ShortcutHint id="comment.copyPrompt" />}
      side="top"
      align="start"
    >
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={copied ? "Comment copied as a prompt" : "Copy comment as a prompt"}
        className="text-text-muted hover:bg-foreground/10 hover:text-foreground dark:hover:bg-foreground/10"
        onClick={() => void copyCommentPrompt(commentId)}
      >
        <CopyGlyph copied={copied} />
      </Button>
    </TooltipHint>
  );
});

/** Every comment in the review, as one prompt. Rides the Comments bar's action slot, beside
 * the count it copies — the count is already the number a reviewer acts on, and this is the
 * act. The bar is also the only place this could go that is on screen when ⌥⇧⌘C is pressed,
 * which a copy with no other feedback needs it to be.
 *
 * **One button until the reader marks something, then a two-item menu.** The payload is the
 * work order — the comments still open — and a reader who has marked none of them is handed
 * exactly the control and the payload that existed before marks did: one click, everything.
 * The choice only appears once there is a choice to make, which is also the only point at
 * which the two payloads differ. ⌥⇧⌘C keeps its one meaning throughout (the open set, which
 * a keystroke with no dialog can only sensibly be), and the payload itself says how many it
 * left out, so the fast path can never quietly under-report. */
export function CopyAllCommentsPromptButton(): ReactElement {
  const copyAllCommentsPrompt = useReviewStore((state) => state.copyAllCommentsPrompt);
  const nonce = useReviewStore((state) =>
    state.promptCopy?.scope === "all" ? state.promptCopy.nonce : null,
  );
  const copied = useCopiedFlash(nonce);
  // Two identity-stable subscriptions rather than one computed object: the slice replaces
  // each of these wholesale on a change and never mutates either in place, so subscribing to
  // them is a reference check and the tally is derived here for free. A selector returning a
  // fresh `{ open, total }` would need `useShallow` to avoid re-rendering on every store
  // write, which is a shallow compare to save an addition.
  const comments = useReviewStore((state) => selectActiveSlice(state)?.comments ?? EMPTY_COMMENTS);
  const resolutions = useReviewStore(
    (state) => selectActiveSlice(state)?.resolvedComments ?? NO_RESOLUTIONS,
  );
  const { open, total } = tallyResolutions(comments, resolutions);

  const label = copied ? "All comments copied as a prompt" : "Copy all comments as a prompt";
  /** The one button shape, given a click for the plain control and none for the menu
   * trigger, which supplies its own. Written once so the two branches below cannot drift
   * into two differently-styled copy buttons. */
  const button = (onClick?: () => void) => (
    <Button
      variant="chrome"
      size="icon-xs"
      aria-label={label}
      // The ink and hover the Layers bar's own action takes, so the two bars' trailing
      // controls read as one thing in two places rather than as two decisions.
      className="shrink-0 text-text-muted"
      onClick={onClick}
    >
      <CopyGlyph copied={copied} />
    </Button>
  );
  const hint = copied ? "Copied" : <ShortcutHint id="comment.copyAllPrompts" />;

  if (open === total) {
    return (
      <TooltipHint content={hint} side="right" align="center">
        {button(() => void copyAllCommentsPrompt())}
      </TooltipHint>
    );
  }

  return (
    <DropdownMenu>
      <TooltipHint content={hint} side="right" align="center">
        <DropdownMenuTrigger render={button()} />
      </TooltipHint>
      <DropdownMenuContent align="end" className="w-auto min-w-48">
        <DropdownMenuItem className="min-h-7" onClick={() => void copyAllCommentsPrompt()}>
          {`Copy ${countLabel(open, "open comment")}`}
        </DropdownMenuItem>
        <DropdownMenuItem
          className="min-h-7"
          onClick={() => void copyAllCommentsPrompt({ includeResolved: true })}
        >
          {`Copy all ${total}, marked included`}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A stable empty list, so a sessionless render hands the tally one constant reference
 * instead of a fresh [] per tick. */
const EMPTY_COMMENTS: Comment[] = [];
