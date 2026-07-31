import { memo, type ReactElement } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipHint } from "@/components/ui/tooltip";
import { ShortcutHint } from "@/components/ui/kbd";
import { fileSignatures } from "@/lib/read-progress";
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

/** The checkbox alone — no word beside it. The box is the one control everybody already
 * reads as "done", and the header band it sits in is a row of quiet metadata; a lit word
 * repeated down a long diff is louder than the state it reports. What it means is carried
 * by the tooltip and the accessible name, which say it in full.
 *
 * Memoized on its one prop: Pierre re-renders every visible file's header slots whenever
 * the portal host re-renders, and this component answers three store selectors per render —
 * each a primitive, not an object, so a store write that changes nothing about this file
 * costs a comparison, not a re-render. The click that changes it comes through its own
 * subscription, not through the parent. */
export const FileReadToggle = memo(function FileReadToggle({
  path,
}: FileReadToggleProps): ReactElement | null {
  // One selector, one primitive: whether `path` is on the loaded diff, and if so whether
  // it is read. `fileSignatures` keys every file's signature by path once per `diff.files`
  // identity, so this is a `Map.get` on every store write, not the O(files) `find` + a
  // freshly joined `fileSignature` this used to redo per header, per render — see
  // `fileSignatures`' own comment for why that matters while scrolling.
  const readState = useReviewStore((state): "missing" | "read" | "unread" => {
    const slice = selectActiveSlice(state);
    if (slice === null || slice.diff.phase !== "loaded") {
      return "missing";
    }
    const signature = fileSignatures(slice.diff.files).get(path);
    if (signature === undefined) {
      return "missing";
    }
    return slice.readFiles.get(path) === signature ? "read" : "unread";
  });
  // `r` acts on the focused file, so the key only rides the hint on the file it would
  // actually reach — a shortcut advertised on a row it does not apply to is worse than no
  // shortcut at all.
  const focused = useReviewStore((state) => selectActiveSlice(state)?.selectedFilePath === path);
  const setFileRead = useReviewStore((state) => state.setFileRead);

  if (readState === "missing") {
    return null;
  }
  const read = readState === "read";
  const action = read ? "Mark unread" : "Mark read";

  return (
    <TooltipHint
      side="bottom"
      align="end"
      content={focused ? <ShortcutHint id="file.read" label={action} /> : action}
    >
      <Button
        variant="chrome"
        size="icon-xs"
        aria-pressed={read}
        aria-label={read ? `Mark ${path} unread` : `Mark ${path} read`}
        onClick={() => setFileRead(path, !read)}
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
      </Button>
    </TooltipHint>
  );
});
