import { useEffect, useMemo, type KeyboardEvent, type ReactElement, type Ref } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { ReviewLayer } from "../../../shared/review";
import type { PatchFile } from "@/lib/diff/patch";
import { resolveLayerScroll } from "@/lib/layers";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
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
  /** Measures the rows' natural height (the listbox itself is scroll-clamped, so
   * its own heights can't) — the parent fits its resize panel against this. */
  contentRef?: Ref<HTMLDivElement>;
};

/** The ordered-layers panel: solos a layer's files across the tree and the code
 * view, and steps the authored order. Selection is derived view state routed
 * through the store — it never touches the session's persisted diff/scroll. */
export function LayerList({
  layers,
  activeLayerId,
  files,
  frozen,
  contentRef,
}: LayerListProps): ReactElement | null {
  const setActiveLayer = useReviewStore((state) => state.setActiveLayer);
  const stepLayer = useReviewStore((state) => state.stepLayer);

  const activeIndex =
    activeLayerId === null ? null : layers.findIndex((l) => l.id === activeLayerId);
  const focusIndex = activeIndex === null || activeIndex === -1 ? null : activeIndex;

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
        const first = layers[0];
        if (first !== undefined) {
          setActiveLayer(first.id);
        }
        break;
      }
      case "End": {
        event.preventDefault();
        const last = layers[layers.length - 1];
        if (last !== undefined) {
          setActiveLayer(last.id);
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

  return (
    // Fills its resize panel (the seam handle below draws the separator line);
    // the list scrolls within whatever height the panel was fitted or dragged to.
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 px-2">
        <span className="text-xs text-text-muted">Layers</span>
        {activeLayerId !== null && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto hover:bg-border/60 dark:hover:bg-border/60"
            onClick={() => setActiveLayer(null)}
          >
            Show all
          </Button>
        )}
        <div className={cn("flex items-center gap-0.5", activeLayerId === null && "ml-auto")}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Previous layer"
            className="hover:bg-border/60 dark:hover:bg-border/60"
            onClick={() => stepLayer(-1)}
          >
            <ChevronUp aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Next layer"
            className="hover:bg-border/60 dark:hover:bg-border/60"
            onClick={() => stepLayer(1)}
          >
            <ChevronDown aria-hidden="true" />
          </Button>
        </div>
      </div>
      <div
        role="listbox"
        aria-label="Layers"
        aria-activedescendant={focusIndex === null ? undefined : rowDomId(focusIndex)}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onClick={(event) => {
          const index = rowIndexAtEvent(event.target);
          const layer = index === null ? undefined : layers[index];
          if (layer !== undefined) {
            // Clicking the soloed row again clears back to the full diff.
            setActiveLayer(layer.id === activeLayerId ? null : layer.id);
          }
        }}
        className="min-h-0 flex-1 overflow-y-auto py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <div ref={contentRef}>
          {layers.map((layer, index) => (
            <LayerRow
              key={layer.id}
              layer={layer}
              index={index}
              selected={layer.id === activeLayerId}
              outdated={outdatedIds.has(layer.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
