import { useMemo, useRef, type CSSProperties, type ReactElement } from "react";
import { Check } from "lucide-react";
import { countLabel } from "../../../../shared/plural";
import { layoutChapterStrip, type ChapterStripInput, type StripSegment } from "@/lib/chapter-strip";
import { badgeText, chapterTint } from "@/lib/guide";
import { useElementWidth } from "@/lib/use-element-width";
import { cn } from "@/lib/utils";
import { TooltipHint } from "@/components/ui/tooltip";

// The whole change as one thin bar: a segment per top-level chapter as wide as the share of the
// changed lines it explains, then the remainder no chapter explains (`lib/chapter-strip.ts`
// holds every number, including why the widths partition the diff rather than sum the
// chapters). Each segment is its chapter's door — the same `setActiveLayer` the chapter row's
// heading uses — and shows how far through it the reader is: a fill along its foot that grows
// with the read tally, full and ticked once the chapter is read.
//
// Tinted per chapter exactly as the map below it is (`chapterTint`, one slot per top-level
// chapter), so a segment and a tile of one chapter are visibly one thing; skim is neutral, and
// the remainder is hatched in the warning hue — the same mark the map gives an uncovered file.

/** Segments narrower than this print no number; narrower than `LABEL_MIN` no label. */
const NUMBER_MIN = 26;
const LABEL_MIN = 84;

/** The hatch the strip and the map both draw for lines no chapter explains. */
export const UNCOVERED_HATCH: CSSProperties = {
  backgroundImage:
    "repeating-linear-gradient(135deg, color-mix(in oklch, var(--warning) 28%, transparent) 0 2px, transparent 2px 6px)",
};

function segmentGround(segment: StripSegment, slot: number | undefined): CSSProperties {
  if (segment.kind === "remainder") {
    return UNCOVERED_HATCH;
  }
  if (segment.skim || slot === undefined) {
    return { backgroundColor: "color-mix(in oklch, var(--border) 70%, transparent)" };
  }
  return { backgroundColor: chapterTint(slot, "ground") };
}

function segmentInk(segment: StripSegment, slot: number | undefined): string {
  if (segment.kind === "remainder" || segment.skim || slot === undefined) {
    return "var(--text-muted)";
  }
  return chapterTint(slot, "strong");
}

function readFraction(segment: StripSegment): number {
  const tally = segment.read;
  if (tally === null || tally.total === 0) {
    return 0;
  }
  return tally.read / tally.total;
}

function segmentHint(segment: StripSegment): string {
  const lines = countLabel(segment.lines, "changed line");
  const read =
    segment.read === null || segment.read.total === 0
      ? ""
      : ` · ${segment.read.read} of ${segment.read.total} files read`;
  if (segment.kind === "remainder") {
    return `Not covered by any chapter · ${lines}${read}`;
  }
  return `${segment.ordinal} ${segment.label} · ${lines}${read}`;
}

type ChapterStripProps = {
  input: ChapterStripInput;
  slots: ReadonlyMap<string, number>;
  onOpen: (layerId: string) => void;
};

export function ChapterStrip({ input, slots, onOpen }: ChapterStripProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref);
  const segments = useMemo(
    () => (width === 0 ? [] : layoutChapterStrip(input, width, { minSegmentWidth: 14, gap: 3 })),
    [input, width],
  );
  return (
    <div ref={ref} className="relative h-7 w-full">
      {segments.map((segment, index) => {
        const slot = segment.kind === "chapter" ? slots.get(segment.id) : undefined;
        const layerId = segment.kind === "chapter" ? segment.id : segment.layerId;
        const fraction = readFraction(segment);
        const done = segment.state === "read";
        const content = (
          <>
            <span
              aria-hidden="true"
              className="absolute inset-x-0 bottom-0 h-[3px] rounded-b-[5px] transition-[width]"
              style={{
                width: `${fraction * 100}%`,
                backgroundColor: segmentInk(segment, slot),
              }}
            />
            {segment.width >= NUMBER_MIN && (
              <span className="relative flex min-w-0 items-center gap-1.5 px-1.5 text-xs">
                {done ? (
                  <Check aria-hidden="true" className="size-3 shrink-0 text-foreground" />
                ) : null}
                {segment.kind === "chapter" && (
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-foreground/80">
                    {badgeText(segment.ordinal)}
                  </span>
                )}
                {segment.width >= LABEL_MIN && (
                  <span className="min-w-0 truncate text-text-muted">
                    {segment.kind === "chapter" ? segment.label : "Not covered"}
                  </span>
                )}
              </span>
            )}
          </>
        );
        const box: CSSProperties = {
          left: segment.x,
          width: segment.width,
          ...segmentGround(segment, slot),
        };
        const className =
          "absolute inset-y-0 flex items-center overflow-hidden rounded-[5px] text-left outline-none focus-visible:ring-2 focus-visible:ring-ring";
        return (
          <TooltipHint key={index} content={segmentHint(segment)} side="top" align="start">
            {layerId === null ? (
              <div style={box} className={className}>
                {content}
              </div>
            ) : (
              <button
                type="button"
                aria-label={segmentHint(segment)}
                onClick={() => onOpen(layerId)}
                style={box}
                className={cn(
                  className,
                  "cursor-pointer hover:brightness-[0.96] dark:hover:brightness-125",
                )}
              >
                {content}
              </button>
            )}
          </TooltipHint>
        );
      })}
    </div>
  );
}
