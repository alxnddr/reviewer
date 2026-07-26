import { type ReactElement } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipHint } from "@/components/ui/tooltip";
import { ShortcutHint } from "@/components/ui/kbd";
import { isFileRead, NO_READ_FILES } from "@/lib/read-progress";
import { cn } from "@/lib/utils";
import { selectActiveSlice, useReviewStore } from "@/stores/review";

// The atom's control, on the file's own header band — where a reader who has just finished
// reading a file already is, and where the same control sits on every review tool they
// have used. Everything else the progress feature draws is derived from this one click.
//
// It reads the store directly rather than taking props, unlike the rest of the diff
// surface. Two reasons, and they point the same way: Pierre re-renders a file item's slots
// only when the item's `version` fingerprint changes (`buildCommentItems`), so a
// prop-threaded toggle would need read state folded into that fingerprint and would still
// only refresh on reconciliation — while a component with its own subscription repaints on
// the click that caused it. And read state is genuinely per-file: threading a whole map
// through `DiffView` to have each header pick one entry out of it is plumbing for nothing.

type FileReadToggleProps = { path: string };

/** A checkbox and the word for what it means. Deliberately labelled rather than a bare
 * glyph: this is the gesture the whole feature rests on, and a header band has room for
 * two syllables. */
export function FileReadToggle({ path }: FileReadToggleProps): ReactElement | null {
  const file = useReviewStore((state) => {
    const diff = selectActiveSlice(state)?.diff;
    return diff !== undefined && diff.phase === "loaded"
      ? (diff.files.find((candidate) => candidate.path === path) ?? null)
      : null;
  });
  const readFiles = useReviewStore((state) => selectActiveSlice(state)?.readFiles ?? NO_READ_FILES);
  // `r` acts on the focused file, so the key only rides the hint on the file it would
  // actually reach — a shortcut advertised on a row it does not apply to is worse than no
  // shortcut at all.
  const focused = useReviewStore((state) => selectActiveSlice(state)?.selectedFilePath === path);
  const setFileRead = useReviewStore((state) => state.setFileRead);

  if (file === null) {
    return null;
  }
  const read = isFileRead(readFiles, file);
  const action = read ? "Mark unread" : "Mark read";

  return (
    <TooltipHint
      side="bottom"
      align="end"
      content={focused ? <ShortcutHint action={action} keys="R" /> : action}
    >
      <Button
        variant="ghost"
        size="xs"
        aria-pressed={read}
        aria-label={read ? `Mark ${path} unread` : `Mark ${path} read`}
        onClick={() => setFileRead(path, !read)}
        className={cn(
          "gap-1.5 hover:bg-border/60 dark:hover:bg-border/60",
          // Read is the resting state of a finished file, so the label recedes into it
          // rather than lighting up: the box is the signal, and a row of lit labels down a
          // long diff would read as a list of alerts.
          read ? "text-text-muted" : "text-text-muted hover:text-foreground",
        )}
      >
        {/* A real checkbox shape — the one control everybody already knows this job by.
            It fills with the theme's own ink rather than an accent, matching how the shell
            paints every other selected/committed state. */}
        <span
          aria-hidden="true"
          className={cn(
            "flex size-3.5 items-center justify-center rounded-[4px] border transition-colors duration-(--duration-fast)",
            read ? "border-foreground bg-foreground text-background" : "border-border",
          )}
        >
          {read && <Check className="size-2.5" strokeWidth={3} />}
        </span>
        Read
      </Button>
    </TooltipHint>
  );
}
