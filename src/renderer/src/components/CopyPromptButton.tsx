import { memo, type ReactElement } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ShortcutHint } from "@/components/ui/kbd";
import { TooltipHint } from "@/components/ui/tooltip";
import { useCopiedFlash } from "@/lib/copy-feedback";
import { useReviewStore } from "@/stores/review";

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
 * which a copy with no other feedback needs it to be. */
export function CopyAllCommentsPromptButton(): ReactElement {
  const copyAllCommentsPrompt = useReviewStore((state) => state.copyAllCommentsPrompt);
  const nonce = useReviewStore((state) =>
    state.promptCopy?.scope === "all" ? state.promptCopy.nonce : null,
  );
  const copied = useCopiedFlash(nonce);

  return (
    <TooltipHint
      content={copied ? "Copied" : <ShortcutHint id="comment.copyAllPrompts" />}
      side="right"
      align="center"
    >
      <Button
        variant="chrome"
        size="icon-xs"
        aria-label={copied ? "All comments copied as a prompt" : "Copy all comments as a prompt"}
        // The ink and hover the Layers bar's own action takes, so the two bars' trailing
        // controls read as one thing in two places rather than as two decisions.
        className="shrink-0 text-text-muted"
        onClick={() => void copyAllCommentsPrompt()}
      >
        <CopyGlyph copied={copied} />
      </Button>
    </TooltipHint>
  );
}
