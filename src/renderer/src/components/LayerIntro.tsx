import type { ReactElement } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from "lucide-react";
import type { ReviewLayer } from "../../../shared/review";
import type { FitToContentRefs } from "@/lib/fit-panel";
import { Button } from "@/components/ui/button";
import { TooltipHint } from "@/components/ui/tooltip";
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
  /** The layers this one hangs off, outermost first — the trail back up the outline. Each
   * is a real place to stand (soloing a parent shows its whole extent), so each crumb
   * navigates there rather than just naming it. */
  ancestors: { id: string; label: string }[];
  /** Whether a previous / next layer exists in the *effective* order (authored plus the
   * inferred layer), so the chevrons dead-end at the true ends of the walkthrough rather
   * than at the last authored layer when an inferred one follows it. */
  hasPrev: boolean;
  hasNext: boolean;
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
  ancestors,
  hasPrev,
  hasNext,
  hasOverview,
  filePaths,
  collapsed,
  onToggleCollapsed,
  fill,
  fit,
}: LayerIntroProps): ReactElement {
  const stepLayer = useReviewStore((state) => state.stepLayer);
  const setActiveLayer = useReviewStore((state) => state.setActiveLayer);
  const selectFile = useReviewStore((state) => state.selectFile);
  const openOverview = useReviewStore((state) => state.openOverview);

  // Falls back to the one-line summary when a layer carries no long-form prose.
  const content = layer.description ?? layer.summary;

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
          nothing jumps. The title reads as a link and is itself the toggle — clicking
          it expands or collapses the prose, the same action the chevron carries; the
          position counter beside it is inert. */}
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
            className="-ml-2 h-8 max-w-full justify-start px-2 text-title font-medium text-foreground hover:no-underline"
          >
            {/* On the label, not the heading: the heading stretches across the band
                and never clips, so only the label knows when it was cut off. */}
            <TooltipHint content={layer.label} whenTruncated side="bottom" align="start">
              <span className="min-w-0 truncate">{layer.label}</span>
            </TooltipHint>
          </Button>
        </h2>
        {/* The trail back up: the doc first, then every layer this one hangs off. The
            number beside the title says where in the order this is; the trail says what it
            is part of — and each crumb is a stop of its own, so clicking one widens the
            diff to that whole group. */}
        <div className="flex min-w-0 shrink items-center gap-1 text-xs text-text-muted">
          {hasOverview && (
            <Button
              type="button"
              variant="link"
              size="xs"
              onClick={() => openOverview()}
              className="h-6 shrink-0 px-1 text-xs text-text-muted hover:text-foreground"
            >
              Overview
            </Button>
          )}
          {ancestors.map((ancestor, index) => (
            <span key={ancestor.id} className="flex min-w-0 items-center gap-1">
              {(hasOverview || index > 0) && <span aria-hidden="true">/</span>}
              <TooltipHint content={ancestor.label} whenTruncated side="bottom" align="end">
                <Button
                  type="button"
                  variant="link"
                  size="xs"
                  onClick={() => setActiveLayer(ancestor.id)}
                  className="h-6 min-w-0 px-1 text-xs text-text-muted hover:text-foreground"
                >
                  <span className="min-w-0 truncate">{ancestor.label}</span>
                </Button>
              </TooltipHint>
            </span>
          ))}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
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
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={collapsed ? "Expand layer description" : "Collapse layer description"}
            className="hover:bg-border/60 dark:hover:bg-border/60"
            onClick={onToggleCollapsed}
          >
            {collapsed ? <ChevronDown aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}
          </Button>
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
