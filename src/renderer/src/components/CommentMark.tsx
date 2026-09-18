import { type ReactElement } from "react";
import { CircleCheck, CircleMinus, CircleSlash, CircleX } from "lucide-react";
import { CommentResolution } from "../../../shared/review-progress";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipHint } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// The reader's own mark on a finding — addressed, skipped, disagree — drawn once for the
// card and the rail, exactly as `CommentMeta.tsx` is drawn once for both.
//
// The two modules are deliberately separate, and the separation is the design. `CommentMeta`
// is the *author's* vocabulary: `severity` is a closed enum the app is allowed to colour, so
// it carries hue. This is the *reader's* answer to that vocabulary, and it carries none — no
// green for addressed, no red for disagree, no fourth and fifth hue added to a palette
// `design/README.md` keeps by hand. What it spends instead is weight: a marked comment's card
// and row go quiet, and the glyph plus the word say which of the three it was.
//
// That split also settles the one thing task 009 asked for by name — the mechanical hint has
// to be distinguishable from the reader's mark. `outdated` is drawn in `--warning` with a
// History glyph, because it is the app's own claim about placement; a mark is greyscale,
// because it is a person's. The reader never has to learn which is which: colour means the
// review said something, grey means they did.

/** Glyph per word. A `switch` with no `default`, so a fourth resolution added to the enum is
 * a compile error here rather than a blank space in the row (the closed-union rule,
 * `CLAUDE.md`) — and the enum is closed precisely because it mirrors the three words the fix
 * prompt asks for. One circle family, so the three read as one axis at 12px. */
function markGlyph(resolution: CommentResolution): ReactElement {
  switch (resolution) {
    case "addressed":
      return <CircleCheck aria-hidden="true" className="size-3 shrink-0" />;
    case "skipped":
      return <CircleMinus aria-hidden="true" className="size-3 shrink-0" />;
    case "disagree":
      return <CircleX aria-hidden="true" className="size-3 shrink-0" />;
  }
}

/** The mark as the card shows it: a quiet line above the body saying which word the reader
 * picked. Null when unmarked, so an unanswered comment renders exactly as it did before this
 * existed — no reserved row, no empty glyph. */
export function CommentMark({
  resolution,
  className,
}: {
  resolution: CommentResolution | null;
  className?: string;
}): ReactElement | null {
  if (resolution === null) {
    return null;
  }
  return (
    <span className={cn("flex items-center gap-1.5 text-xs text-text-muted", className)}>
      {markGlyph(resolution)}
      <span className="capitalize">{resolution}</span>
    </span>
  );
}

/** The same mark where there is room for a glyph and nothing else — the rail row, which
 * already spends its width on the body preview. The word travels in the row's hover hint
 * instead (`commentMarkLabel`). */
export function CommentMarkGlyph({ resolution }: { resolution: CommentResolution }): ReactElement {
  // `--text-muted`, not the fainter step: the row it sits in is already dimmed for being
  // marked, and a faint glyph inside a dimmed row was invisible on screen — the two
  // reductions compound, which is exactly what looking at it showed.
  return <span className="shrink-0 text-text-muted">{markGlyph(resolution)}</span>;
}

/** The mark as a sentence, for the rail's hover hint. Null on an unmarked comment, so the
 * hint gains no empty line — `commentMetaLabel`'s contract beside it. */
export function commentMarkLabel(resolution: CommentResolution | null): string | null {
  switch (resolution) {
    case null:
      return null;
    case "addressed":
      return "You marked this addressed";
    case "skipped":
      return "You marked this skipped";
    case "disagree":
      return "You disagreed with this";
  }
}

/** Setting the mark: one glyph in the card's hover toolbar, opening the three words as a
 * radio list with a way back to unmarked.
 *
 * A menu rather than three buttons in the strip. The toolbar is four glyphs already and the
 * reader arrives at it without labels (`CommentThread`'s own note); three more unlabelled
 * circles there would be a row of seven things to tell apart by shape, on a surface that
 * only appears while the pointer is over the card. A menu also gets the words themselves on
 * screen, which is the point — they are the same three the agent was asked to answer with,
 * and reading them beside the reply is how a mark gets transcribed rather than guessed.
 *
 * The trigger wears the current mark's glyph, so the toolbar says what the card already
 * says and the state is reachable without opening anything. */
export function CommentMarkMenu({
  resolution,
  onSetResolution,
}: {
  resolution: CommentResolution | null;
  onSetResolution: (resolution: CommentResolution | null) => void;
}): ReactElement {
  return (
    <DropdownMenu>
      <TooltipHint content="Mark this comment" side="top" align="center">
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Mark this comment"
              className={cn(
                "hover:bg-foreground/10 hover:text-foreground dark:hover:bg-foreground/10",
                resolution === null ? "text-text-muted" : "text-foreground",
              )}
            />
          }
        >
          {resolution === null ? (
            <CircleSlash className="size-3.5" />
          ) : (
            <span className="[&_svg]:size-3.5">{markGlyph(resolution)}</span>
          )}
        </DropdownMenuTrigger>
      </TooltipHint>
      {/* `start`, so the list hangs down-right from the glyph that opened it — the leftmost
          of the five, where `end` would grow back across the toolbar it came from. */}
      <DropdownMenuContent align="start" className="w-auto min-w-40">
        <DropdownMenuRadioGroup
          value={resolution ?? ""}
          onValueChange={(next) => {
            // The menu lists only our own values, but the primitive hands back a bare string
            // — parsed rather than cast, so a value that is not one of the three can never
            // become a stored mark. The same gate `addComment` puts on an anchor.
            const parsed = CommentResolution.safeParse(next);
            if (parsed.success) {
              onSetResolution(parsed.data);
            }
          }}
        >
          <DropdownMenuRadioItem value="addressed" className="min-h-7">
            <CircleCheck />
            Addressed
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="skipped" className="min-h-7">
            <CircleMinus />
            Skipped
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="disagree" className="min-h-7">
            <CircleX />
            Disagree
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        {resolution !== null && (
          <>
            <DropdownMenuSeparator />
            {/* Only when there is a mark to take off: an always-present "Clear" on an
                unmarked comment is a row that does nothing, and the radio group above
                already has no selected value to look wrong. */}
            <DropdownMenuItem className="min-h-7" onClick={() => onSetResolution(null)}>
              Clear mark
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
