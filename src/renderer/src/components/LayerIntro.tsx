import { useMemo, type ReactElement, type Ref } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, File } from "lucide-react";
import type { ReviewLayer } from "../../../shared/review";
import { parseLayerDescription, type DescriptionRun } from "@/lib/layer-description";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useReviewStore } from "@/stores/review";

// A layer's long-form description read at reading width above the diff, not
// crammed into the rail. Links resolve against the files actually in the diff
// (the soloed subset), so a clickable chip always navigates to something on
// screen and an absent reference is inert.

type FileChipProps = { label: string; onSelect: () => void };

/** A resolved file reference: a mono chip that jumps the diff to the file. */
function FileChip({ label, onSelect }: FileChipProps): ReactElement {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      onClick={onSelect}
      className="mx-0.5 gap-1 rounded border border-border-strong align-baseline font-mono hover:bg-border/60 dark:hover:bg-border/60"
    >
      <File aria-hidden="true" />
      {label}
    </Button>
  );
}

/** Unresolved reference: the target is not in this diff. Shown as a label, never a dead click. */
function DeadRef({ label }: { label: string }): ReactElement {
  return (
    <span
      className="mx-0.5 rounded border border-border/60 px-1 font-mono text-text-muted"
      title="Not in this diff"
    >
      {label}
    </span>
  );
}

function renderRun(
  run: DescriptionRun,
  index: number,
  onSelect: (file: string) => void,
): ReactElement {
  switch (run.kind) {
    case "text":
      return <span key={index}>{run.text}</span>;
    case "code": {
      if (run.file === null) {
        return (
          <code key={index} className="font-mono">
            {run.text}
          </code>
        );
      }
      const file = run.file;
      return <FileChip key={index} label={run.text} onSelect={() => onSelect(file)} />;
    }
    case "link": {
      if (run.file === null) {
        return <DeadRef key={index} label={run.label} />;
      }
      const file = run.file;
      return <FileChip key={index} label={run.label} onSelect={() => onSelect(file)} />;
    }
  }
}

type LayerIntroProps = {
  layer: ReviewLayer;
  /** 0-based position of the active layer in the authored order. */
  index: number;
  total: number;
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
  /** The parent measures this prose block's natural height to size the panel to fit
   * on expand (DiffScreen). Attached to the reading-width content, which stays at
   * content height even when the scroll viewport around it is stretched taller. */
  contentRef?: Ref<HTMLDivElement>;
};

export function LayerIntro({
  layer,
  index,
  total,
  filePaths,
  collapsed,
  onToggleCollapsed,
  fill,
  contentRef,
}: LayerIntroProps): ReactElement {
  const stepLayer = useReviewStore((state) => state.stepLayer);
  const selectFile = useReviewStore((state) => state.selectFile);

  // Falls back to the one-line summary when a layer carries no long-form prose.
  const content = layer.description ?? layer.summary;
  const diffFiles = useMemo(() => new Set(filePaths), [filePaths]);
  const paragraphs = useMemo(() => parseLayerDescription(content, diffFiles), [content, diffFiles]);

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
        <h2 className="min-w-0 flex-1" title={layer.label}>
          <Button
            type="button"
            variant="link"
            onClick={onToggleCollapsed}
            className="-ml-2 h-8 max-w-full justify-start px-2 text-title font-medium text-foreground hover:no-underline"
          >
            <span className="min-w-0 truncate">{layer.label}</span>
          </Button>
        </h2>
        <span className="shrink-0 text-xs text-text-muted">
          Layer {index + 1} of {total}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Previous layer"
            disabled={index === 0}
            className="hover:bg-border/60 dark:hover:bg-border/60"
            onClick={() => stepLayer(-1)}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Next layer"
            disabled={index === total - 1}
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
        <div className={cn("overflow-y-auto pb-3", fill ? "min-h-0 flex-1" : "max-h-48")}>
          <div
            ref={contentRef}
            className="max-w-3xl space-y-2 px-6 text-base leading-relaxed text-foreground select-text"
          >
            {paragraphs.map((paragraph, paragraphIndex) => (
              <p key={paragraphIndex} className="break-words">
                {paragraph.runs.map((run, runIndex) =>
                  renderRun(run, runIndex, (file) => selectFile(file)),
                )}
              </p>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
