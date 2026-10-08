import { useMemo, type ReactElement } from "react";
import type { AnchorSpan, SkeletonVisual, VisualPresence } from "../../../../shared/review";
import { skeletonRows, type ChapterBadge as Badge } from "@/lib/guide";
import { cn } from "@/lib/utils";
import { ChapterBadge } from "@/components/guide/ChapterBadge";
import {
  AnchorTarget,
  canOpen,
  VISUAL_CODE_FACE,
  elementHint,
  type AnchorDoor,
} from "@/components/guide/anchor-door";

// A skeleton visual: what one function now does, as its call tree without bodies — one
// monospace row per signature or call, indented by `depth`, `+`/`−` per row in the diff's own
// grammar (a tinted row with a coloured bar at its left edge), the author's grey note trailing
// the code, and the derived chapter badge at the right edge. Capy's guide sets the same picture
// for "Retry blob reads": the reader sees the shape of the new path before reading a line of it.
//
// Rows are text React renders — `code` is a signature the author typed, not code the app parsed
// or highlighted. A row whose anchor this surface can follow is a door to it (`AnchorTarget`).
//
// The code never gives way: it is the thing the picture is of, so a row too wide for the card
// scrolls the figure sideways rather than eliding a signature (the row is `min-w-fit`). The note
// gives way instead — `w-0 flex-1`, so it adds nothing to that minimum and only the code can
// widen a row; it truncates to whatever the code leaves — and the row's hint carries it whole, above the anchor,
// so a cut-off note is one hover from readable (the hint is the app's `title`; see
// `TooltipHint`).

/** Indent per depth level, in `ch` of the row's own monospace. */
const INDENT_CH = 2;

function rowTone(status: VisualPresence): { row: string; marker: string; glyph: string } {
  switch (status) {
    case "added":
      return { row: "border-l-diff-add-fg bg-diff-add-bg", marker: "text-diff-add-fg", glyph: "+" };
    case "removed":
      return { row: "border-l-diff-del-fg bg-diff-del-bg", marker: "text-diff-del-fg", glyph: "−" };
    case "same":
      return { row: "border-l-transparent", marker: "", glyph: "" };
  }
}

type SkeletonViewProps = {
  visual: SkeletonVisual;
  badgeOf: (anchor: AnchorSpan | undefined) => Badge | null;
  door: AnchorDoor;
  compact?: boolean | undefined;
  className?: string;
};

export function SkeletonView({
  visual,
  badgeOf,
  door,
  compact = false,
  className,
}: SkeletonViewProps): ReactElement {
  const rows = useMemo(() => skeletonRows(visual.lines, badgeOf), [visual, badgeOf]);
  return (
    <div
      className={cn(
        "flex flex-col overflow-x-auto",
        VISUAL_CODE_FACE,
        compact ? "text-xs" : "text-[13px]",
        className,
      )}
    >
      {rows.map(({ line, badge }, index) => {
        const tone = rowTone(line.status);
        const open = canOpen(door, line.at);
        return (
          <AnchorTarget
            key={index}
            door={door}
            anchor={line.at}
            hint={elementHint(line.note, line.at, badge)}
            label={open ? `${line.code}, open its code` : undefined}
            className={cn(
              "flex w-full min-w-fit items-baseline gap-2 border-l-2 pr-2",
              compact ? "py-0.5 leading-5" : "py-[3px] leading-6",
              tone.row,
              open && "hover:brightness-[0.97] dark:hover:brightness-110",
            )}
          >
            <span aria-hidden="true" className={cn("w-5 shrink-0 text-center", tone.marker)}>
              {tone.glyph}
            </span>
            <span className="flex min-w-0 flex-1 items-baseline gap-3">
              <span
                className={cn(
                  "shrink-0 whitespace-pre text-foreground",
                  line.status === "removed" && "text-foreground/80",
                )}
                style={{ paddingLeft: `${line.depth * INDENT_CH}ch` }}
              >
                {line.code}
              </span>
              {line.note !== undefined && (
                <span className="w-0 min-w-0 flex-1 truncate font-sans text-text-faint">
                  {line.note}
                </span>
              )}
            </span>
            {badge !== null && <ChapterBadge badge={badge} className="self-center" />}
          </AnchorTarget>
        );
      })}
    </div>
  );
}
