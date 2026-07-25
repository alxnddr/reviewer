import { useEffect, useMemo, type KeyboardEvent, type ReactElement } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Layers as LayersIcon } from "lucide-react";
import type { ReviewLayer } from "../../../shared/review";
import type { PatchFile } from "@/lib/diff/patch";
import type { FitToContentRefs } from "@/lib/fit-panel";
import { resolveLayerScroll } from "@/lib/layers";
import { coverageSummary } from "@/lib/coverage";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useReviewStore } from "@/stores/review";

// Hand-built single-select ARIA listbox: the active option IS the soloed layer,
// so roving the active descendant and soloing are the same move (arrows step,
// never animated). The order is the artifact's; nothing here sorts. The pure
// stepping/solo/scroll logic lives in lib/layers.ts.

function rowDomId(index: number): string {
  return `layer-option-${index}`;
}

type LayerRowProps = {
  layer: ReviewLayer;
  index: number;
  selected: boolean;
  outdated: boolean;
};

/** One layer row: the authored ordinal in a mono gutter beside the `label` over a
 * demoted `summary`; an outdated first range wears the same chip the comment header uses. */
function LayerRow({ layer, index, selected, outdated }: LayerRowProps): ReactElement {
  return (
    <div
      role="option"
      id={rowDomId(index)}
      data-layer-index={index}
      aria-selected={selected}
      className={cn(
        // Baseline alignment sits the ordinal on the label's first line, not the row's centre.
        "flex min-h-7 cursor-default items-baseline gap-2 px-2 py-1 select-none",
        // The soloed layer wears the themed selection fill (bg-selected); hover
        // stays a neutral wash a step below so a hovered row never reads as the
        // active solo.
        selected ? "bg-selected text-foreground" : "text-text-muted hover:bg-border/30",
      )}
    >
      {/* Right-aligned tabular gutter so 1→9 and double digits stay flush; a step
          fainter than the label since the number orders, it doesn't title. */}
      <span
        className={cn(
          "w-4 shrink-0 text-right font-mono text-xs tabular-nums",
          selected ? "text-foreground/70" : "text-text-muted",
        )}
      >
        {index + 1}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm" title={layer.label}>
            {layer.label}
          </span>
          {outdated && (
            // The neutral pill keeps a hairline so its shape stays legible against
            // the themed selection fill of a soloed row (bg-selected), whose hue and
            // tone it would otherwise wash into.
            <span className="shrink-0 rounded border border-border bg-border/60 px-1.5 py-0.5 text-xs text-foreground">
              Outdated
            </span>
          )}
        </div>
        <span
          className={cn("truncate text-xs", selected ? "text-foreground/80" : "text-text-muted")}
          title={layer.summary}
        >
          {layer.summary}
        </span>
      </div>
    </div>
  );
}

type UncoveredRowProps = {
  /** Its slot in the effective order (past the last authored row) — the id/keyboard
   * target and the value the click handler maps back to the inferred layer. */
  index: number;
  selected: boolean;
  /** Coverable files no layer walks — the row is file-based, matching what soloing it
   * shows (whole files), not the line-based header %. */
  files: number;
};

/** The inferred "not covered by layers" row: same option/solo mechanics and padding as a
 * `LayerRow`, so it flows as the last item of the list rather than a set-apart section — a
 * warning glyph simply stands in for the ordinal in the shared `w-4` gutter, keeping both
 * rows' text left-aligned. Rendered only when a gap exists. */
function UncoveredRow({ index, selected, files }: UncoveredRowProps): ReactElement {
  return (
    <div
      role="option"
      id={rowDomId(index)}
      data-layer-index={index}
      aria-selected={selected}
      className={cn(
        "flex min-h-7 cursor-default items-start gap-2 px-2 py-1 select-none",
        selected ? "bg-selected text-foreground" : "text-text-muted hover:bg-border/30",
      )}
    >
      {/* mt-0.5 optically centres the glyph on the first text line (its cap height sits
          above the row's baseline). */}
      <span className="mt-0.5 flex w-4 shrink-0 justify-end">
        <AlertTriangle
          aria-hidden="true"
          className={cn("size-3.5", selected ? "text-foreground/70" : "text-text-muted")}
        />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn("truncate text-sm", selected && "text-foreground")}>Not covered</span>
        <span
          className={cn(
            "truncate text-xs tabular-nums",
            selected ? "text-foreground/80" : "text-text-muted",
          )}
        >
          {files} {files === 1 ? "file" : "files"}
        </span>
      </div>
    </div>
  );
}

type LayerListProps = {
  layers: ReviewLayer[];
  activeLayerId: string | null;
  /** The full loaded diff — never the soloed subset — so each layer's first-range
   * outdated flag is resolved against the whole file set. */
  files: PatchFile[];
  /** True when the review pins its own frozen patch: every layer anchor places
   * against it, so no layer wears the outdated chip — the same rule the comment
   * surface applies to a frozen review. */
  frozen: boolean;
  /** Disclosure is owned by the parent (SidebarNav) so it can host the open list in a
   * resizable panel and fall back to a plain bar when collapsed — the same split it
   * makes for the comment overview above. */
  expanded: boolean;
  onToggleExpanded: () => void;
  /** Present when the list lives in a panel the parent fits to the rows' own height:
   * the listbox is the scroll viewport, the row block inside it the measured content. */
  fit?: FitToContentRefs;
};

/** The ordered-layers panel: solos a layer's files across the tree and the code
 * view. Selection is derived view state routed through the store — it never touches
 * the session's persisted diff/scroll. Stepping the order is the diff-side intro's
 * job (its chevrons walk it); here the rows themselves are the affordance, so the
 * rail keeps only what it needs — a disclosure and the way back to the full diff. */
export function LayerList({
  layers,
  activeLayerId,
  files,
  frozen,
  expanded,
  onToggleExpanded,
  fit,
}: LayerListProps): ReactElement | null {
  const setActiveLayer = useReviewStore((state) => state.setActiveLayer);
  const stepLayer = useReviewStore((state) => state.stepLayer);

  // The computed coverage of the loaded diff by these layers — same core the `rvw
  // coverage` CLI reports, so the header number and the CLI never disagree. `uncovered`
  // is the inferred remainder, present only when a coverable file sits in no layer at all.
  const summary = useMemo(() => coverageSummary(files, layers), [files, layers]);
  const uncovered = summary.uncoveredLayer;

  // The rove/solo order: the authored rows, then the inferred row when it exists. The
  // click handler and Home/End map a row's slot back to an id through this.
  const optionIds = useMemo(
    () =>
      uncovered === null ? layers.map((l) => l.id) : [...layers.map((l) => l.id), uncovered.id],
    [layers, uncovered],
  );
  const activeIndex = activeLayerId === null ? -1 : optionIds.indexOf(activeLayerId);
  const focusIndex = activeIndex === -1 ? null : activeIndex;

  // Resolve each layer's first-range outdated flag once per layers/diff change,
  // not per row per render — the scan is O(files × hunks) per layer.
  const outdatedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const layer of layers) {
      if (resolveLayerScroll(layer, files, frozen).kind === "outdated") {
        ids.add(layer.id);
      }
    }
    return ids;
  }, [layers, files, frozen]);

  useEffect(() => {
    // Keep the soloed row visible as arrows walk the order.
    if (focusIndex !== null) {
      document.getElementById(rowDomId(focusIndex))?.scrollIntoView({ block: "nearest" });
    }
  }, [focusIndex]);

  if (layers.length === 0) {
    return null;
  }

  const rowIndexAtEvent = (target: EventTarget | null): number | null => {
    if (!(target instanceof HTMLElement)) {
      return null;
    }
    const row = target.closest("[data-layer-index]");
    if (!(row instanceof HTMLElement) || row.dataset["layerIndex"] === undefined) {
      return null;
    }
    const index = Number(row.dataset["layerIndex"]);
    return Number.isInteger(index) ? index : null;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        stepLayer(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        stepLayer(-1);
        break;
      case "Home": {
        event.preventDefault();
        const first = optionIds[0];
        if (first !== undefined) {
          setActiveLayer(first);
        }
        break;
      }
      case "End": {
        event.preventDefault();
        const last = optionIds[optionIds.length - 1];
        if (last !== undefined) {
          setActiveLayer(last);
        }
        break;
      }
      case "Escape":
        if (activeLayerId !== null) {
          event.preventDefault();
          setActiveLayer(null);
        }
        break;
      default:
        break;
    }
  };

  // The disclosure's own content, shared by both branches below: the twisty, the
  // section glyph, and the count that keeps the collapsed bar informative.
  const disclosure = (
    <>
      {expanded ? (
        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
      ) : (
        <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />
      )}
      <LayersIcon aria-hidden="true" className="size-3.5 shrink-0" />
      {layers.length === 1 ? "1 layer" : `${layers.length} layers`}
    </>
  );
  // Stretches to the bar's full height so the whole left of the row is the hit target,
  // matching the comment overview's full-width disclosure button.
  const toggleClass =
    "flex h-full min-w-0 flex-1 items-center gap-1.5 text-xs text-text-muted hover:text-foreground";

  return (
    // Open, it fills its resize panel (the seam handle below draws the separator line)
    // and the list scrolls within whatever height the panel was fitted or dragged to.
    // Collapsed, the section *is* the bar, carrying its own border down to the tree.
    <div
      className={cn(
        "flex flex-col",
        expanded ? "h-full min-h-0" : "shrink-0 border-b border-border",
      )}
    >
      <div className="flex h-9 shrink-0 items-center gap-1 px-2">
        {/* The narrow rail has no room for a coverage chip beside the controls, so the
            full readout — headline % and the line/file counts — lives in a tooltip on
            the disclosure; the inferred "Not covered" row carries the at-a-glance signal. */}
        {summary.coverableLines > 0 ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={onToggleExpanded}
                    className={toggleClass}
                  />
                }
              >
                {disclosure}
              </TooltipTrigger>
              <TooltipContent side="bottom" align="start">
                <div className="flex flex-col gap-0.5">
                  <span className="tabular-nums">{summary.linePct}% covered by layers</span>
                  <span className="tabular-nums text-background/70">
                    {summary.coveredLines}/{summary.coverableLines} changed lines ·{" "}
                    {summary.coveredFiles} of {summary.coverableFiles} files
                  </span>
                </div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={onToggleExpanded}
            className={toggleClass}
          >
            {disclosure}
          </button>
        )}
        {/* Collapsed, the rows that would explain a solo aren't on screen — so the way
            back to the full diff rides with them, not on the bare bar. */}
        {expanded && activeLayerId !== null && (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 hover:bg-border/60 dark:hover:bg-border/60"
            onClick={() => setActiveLayer(null)}
          >
            Show all
          </Button>
        )}
      </div>
      {expanded && (
        <div
          ref={fit?.viewportRef}
          role="listbox"
          aria-label="Layers"
          aria-activedescendant={focusIndex === null ? undefined : rowDomId(focusIndex)}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onClick={(event) => {
            const index = rowIndexAtEvent(event.target);
            const id = index === null ? undefined : optionIds[index];
            if (id !== undefined) {
              // Clicking the soloed row again clears back to the full diff.
              setActiveLayer(id === activeLayerId ? null : id);
            }
          }}
          // pb-1 only (no top padding): the header already carries its own bottom inset,
          // so a listbox top pad would push the first row down and make the header read
          // as bottom-heavy — the gap above the bar's label must equal the gap down to
          // the first row.
          className="min-h-0 flex-1 overflow-y-auto pb-1 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <div ref={fit?.contentRef}>
            {layers.map((layer, index) => (
              <LayerRow
                key={layer.id}
                layer={layer}
                index={index}
                selected={layer.id === activeLayerId}
                outdated={outdatedIds.has(layer.id)}
              />
            ))}
            {uncovered !== null && (
              <UncoveredRow
                index={layers.length}
                selected={uncovered.id === activeLayerId}
                files={summary.uncoveredFiles}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
