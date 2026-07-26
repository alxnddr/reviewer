import type { ReactElement } from "react";
import { ChevronLeft, ChevronRight, Compass } from "lucide-react";
import type { ReviewLayer } from "../../../shared/review";
import type { FitToContentRefs } from "@/lib/fit-panel";
import { isComplete, type ReadTally } from "@/lib/read-progress";
import { Button } from "@/components/ui/button";
import { TooltipHint } from "@/components/ui/tooltip";
import { ShortcutHint } from "@/components/ui/kbd";
import { ReadRing, readLabel } from "@/components/ReadRing";
import { ReviewProse } from "@/components/ReviewProse";
import { cn } from "@/lib/utils";
import { useReviewStore } from "@/stores/review";

// A layer's long-form description read at reading width above the diff, not
// crammed into the rail. Links resolve against the files actually in the diff
// (the soloed subset), so a clickable chip always navigates to something on
// screen and an absent reference is inert.

type LayerIntroProps = {
  layer: ReviewLayer;
  /** The number this layer wears in the outline — `"6"`, or `"6.1"` inside a group —
   * shown beside the title, exactly as the rail and the doc show it. Null for the
   * inferred "not covered by layers" layer, which is no authored step. */
  ordinal: string | null;
  /** Whether a previous / next layer exists in the *effective* order (authored plus the
   * inferred layer), so the chevrons dead-end at the true ends of the walkthrough rather
   * than at the last authored layer when an inferred one follows it. */
  hasPrev: boolean;
  hasNext: boolean;
  /** How much of this chapter's extent has been read — measured over exactly the files the
   * band is sitting above, so its ring and the rail's row for the same layer are one
   * number. Empty (`total: 0`) on a chapter whose files drifted out of the diff, which
   * suppresses the control: there is nothing here left to read. */
  readTally: ReadTally;
  /** Flip the whole chapter: read when it isn't finished, unread when it is. */
  onToggleRead: () => void;
  /** Whether the review carries a tour doc: the position counter then reads as a
   * breadcrumb back to it, since the doc is the walkthrough's real first stop. */
  hasOverview: boolean;
  /** The files currently rendered in the diff (the soloed subset): both the link
   * resolution set and the navigation targets. */
  filePaths: string[];
  /** Whether the long-form prose is hidden; owned by the parent so it can drop the
   * resize panel when there is nothing to resize. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** True when the band lives inside the resizable panel: the section fills that
   * panel's dragged height and the prose scrolls within it (the border seam is the
   * handle below). False keeps the classic content-height band with a bounded prose. */
  fill: boolean;
  /** Marks what DiffScreen measures to fit the panel to the prose's own height (it
   * only does so in `fill` mode): the scroll viewport, and the reading-width block
   * inside it that stays at content height however tall that viewport is stretched. */
  fit?: FitToContentRefs;
};

export function LayerIntro({
  layer,
  ordinal,
  hasPrev,
  hasNext,
  hasOverview,
  readTally,
  onToggleRead,
  filePaths,
  collapsed,
  onToggleCollapsed,
  fill,
  fit,
}: LayerIntroProps): ReactElement {
  const stepLayer = useReviewStore((state) => state.stepLayer);
  const selectFile = useReviewStore((state) => state.selectFile);
  const openOverview = useReviewStore((state) => state.openOverview);

  // Falls back to the one-line summary when a layer carries no long-form prose.
  const content = layer.description ?? layer.summary;
  const complete = isComplete(readTally);

  return (
    <section
      className={cn(
        "bg-diff-surface",
        // The heading always occupies the same 44px bar (see the header row below), so
        // expanding never shifts it — the prose simply grows underneath. Collapsed, the
        // section is that bar exactly (44px incl. border), lining up with the rail's
        // `h-11` header across the seam; expanded it flex-fills the panel, or the
        // bounded band, with the prose taking the remaining height.
        fill
          ? "flex h-full min-h-0 flex-col"
          : collapsed
            ? "flex h-11 shrink-0 items-center border-b border-border"
            : "shrink-0 border-b border-border",
      )}
    >
      {/* When the prose shows, the row keeps the collapsed bar's fixed height so
          nothing jumps. The title reads as a link and is itself the disclosure — clicking
          it expands or collapses the prose. */}
      <div className={cn("flex w-full shrink-0 items-center gap-3 px-6", !collapsed && "h-11")}>
        <h2 className="flex min-w-0 flex-1 items-baseline gap-2">
          {/* The layer's number, in the same tabular figures the rail and the doc set it
              in — one layer, one number, wherever it is read. */}
          {ordinal !== null && (
            <span className="shrink-0 text-xs tabular-nums text-text-faint">{ordinal}</span>
          )}
          <Button
            type="button"
            variant="link"
            onClick={onToggleCollapsed}
            aria-expanded={!collapsed}
            className="-ml-2 h-8 max-w-full justify-start px-2 text-title font-medium text-foreground hover:no-underline"
          >
            {/* On the label, not the heading: the heading stretches across the band
                and never clips, so only the label knows when it was cut off. */}
            <TooltipHint content={layer.label} whenTruncated side="bottom" align="start">
              <span className="min-w-0 truncate">{layer.label}</span>
            </TooltipHint>
          </Button>
        </h2>
        {/* One cluster, four verbs, in the order a reader uses them: up to the hub, back,
            forward, done. Nothing here is prose — the band's whole middle is the chapter's
            own title, and everything else it used to carry is said better elsewhere.

            The trail of parent links this replaced was navigation nobody needed twice: the
            rail is always beside this band with the selection revealed and its ancestors in
            full ink, so a group is one click away there, and the section number in the
            heading already says which group this is. */}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {hasOverview && (
            <TooltipHint
              side="bottom"
              align="end"
              content={<ShortcutHint action="Overview" keys="O" />}
            >
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Open the overview"
                className="mr-1 hover:bg-border/60 dark:hover:bg-border/60"
                onClick={() => openOverview()}
              >
                {/* The rail's own glyph for the same stop, so the door out is recognisably
                    the row it leads to. */}
                <Compass aria-hidden="true" />
              </Button>
            </TooltipHint>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Previous layer"
            disabled={!hasPrev}
            className="hover:bg-border/60 dark:hover:bg-border/60"
            onClick={() => stepLayer(-1)}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Next layer"
            disabled={!hasNext}
            className="hover:bg-border/60 dark:hover:bg-border/60"
            onClick={() => stepLayer(1)}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
          {/* Done, in the slot a second collapse control used to hold: the title has always
              been this band's disclosure, so the chevron beside it was one action wearing
              two controls in the app's densest row — and this is the third thing a reader
              does at a chapter, after back and forward. The cluster now reads as the
              walkthrough's own verbs, and the row gained nothing to hold it.

              The glyph is the state and the state is the label: an empty ring is a chapter
              not started, a pie is one part-way through (the same figure its row in the
              rail shows), a check is a chapter finished. A chapter whose files left the
              diff has nothing to mark, and shows no control at all. */}
          {readTally.total > 0 && (
            <TooltipHint
              side="bottom"
              align="end"
              content={
                complete
                  ? `Layer read — click to mark its ${readTally.total === 1 ? "file" : `${readTally.total} files`} unread`
                  : `${readLabel(readTally)} — click to mark the layer read`
              }
            >
              <Button
                variant="ghost"
                size="icon-sm"
                aria-pressed={complete}
                aria-label={complete ? "Mark this layer unread" : "Mark this layer read"}
                onClick={onToggleRead}
                className="hover:bg-border/60 dark:hover:bg-border/60"
              >
                <ReadRing tally={readTally} className="size-3.5" />
              </Button>
            </TooltipHint>
          )}
        </div>
      </div>
      {!collapsed && (
        // The scroll viewport spans the full pane so its scrollbar rides the diff's
        // right edge, not a narrow column; the prose keeps its reading width inside.
        // In the panel it fills the dragged height; otherwise it stays a bounded band.
        <div
          ref={fit?.viewportRef}
          className={cn("overflow-y-auto pb-3", fill ? "min-h-0 flex-1" : "max-h-48")}
        >
          <ReviewProse
            ref={fit?.contentRef}
            text={content}
            filePaths={filePaths}
            onSelectFile={(file) => selectFile(file)}
            className="max-w-3xl space-y-2 px-6 text-base leading-relaxed text-foreground select-text"
          />
        </div>
      )}
    </section>
  );
}
