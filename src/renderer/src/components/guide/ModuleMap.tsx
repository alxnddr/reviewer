import { useMemo, useRef, type CSSProperties, type ReactElement } from "react";
import { layoutTreemap, type ModuleMapDir, type ModuleMapFile } from "@/lib/module-map";
import { badgeText, chapterTint, mapHeight, tileTone, type TileTone } from "@/lib/guide";
import { useElementWidth } from "@/lib/use-element-width";
import { cn } from "@/lib/utils";
import { TooltipHint } from "@/components/ui/tooltip";
import { UNCOVERED_HATCH } from "@/components/guide/ChapterStrip";

// The Map tab: the change's files as a treemap (`buildModuleMap` + `layoutTreemap`,
// `lib/module-map.ts`) — grouped into their directories, each tile as large as the lines it
// changed and tinted by the chapter that explains it. Where the chapter strip says how big each
// chapter is, this says *where* it is: one glance shows that chapter 2 lives in `src/main` and
// that one file in `scripts/` belongs to nobody.
//
// The drawing is the layout's, measured against the card's width; a tile names its file, and its
// chapter number once it is large enough to print one. A click opens the file in the full diff —
// `focusReference(path, null)`, the door a bare-path chip in the prose uses.

/** A tile prints its name past this size, and its chapter number past the next. */
const NAME_MIN = { width: 44, height: 18 };
const BADGE_MIN = { width: 64, height: 36 };

function toneStyle(tone: TileTone): CSSProperties {
  switch (tone.kind) {
    case "chapter":
      return {
        backgroundColor: chapterTint(tone.slot, "ground"),
        boxShadow: `inset 0 0 0 1px ${chapterTint(tone.slot, "strong")}`,
      };
    case "skim":
      return { backgroundColor: "color-mix(in oklch, var(--border) 65%, transparent)" };
    case "uncovered":
      return {
        ...UNCOVERED_HATCH,
        boxShadow: "inset 0 0 0 1px color-mix(in oklch, var(--warning) 45%, transparent)",
      };
    case "none":
      return { backgroundColor: "color-mix(in oklch, var(--border) 35%, transparent)" };
  }
}

function tileHint(file: ModuleMapFile): string {
  const counts = [
    file.additions > 0 ? `+${file.additions}` : null,
    file.deletions > 0 ? `−${file.deletions}` : null,
  ]
    .filter((part) => part !== null)
    .join(" ");
  const owner =
    file.chapter === null
      ? file.uncovered
        ? "not covered by any chapter"
        : "no changed lines"
      : `chapter ${file.chapter.ordinal}${file.chapter.skim ? " (skim)" : ""}`;
  return [file.path, counts, owner].filter((part) => part !== "").join(" · ");
}

type ModuleMapProps = {
  root: ModuleMapDir;
  slots: ReadonlyMap<string, number>;
  onOpenFile: (path: string) => void;
};

export function ModuleMap({ root, slots, onOpenFile }: ModuleMapProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref);
  const height = mapHeight(root.files);
  const rects = useMemo(
    () =>
      width === 0
        ? []
        : layoutTreemap(root.children, width, height, { header: 18, padding: 3, gap: 3 }),
    [root, width, height],
  );
  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {rects.map((rect) => {
        const box: CSSProperties = {
          left: rect.x,
          top: rect.y,
          width: rect.width,
          height: rect.height,
        };
        if (rect.node.kind === "dir") {
          return (
            <div
              key={`dir:${rect.node.path}`}
              style={box}
              className="absolute rounded-md border border-border/80"
            >
              {rect.header && (
                <span className="absolute inset-x-1.5 top-0.5 truncate font-mono text-[11px] leading-4 text-text-faint">
                  {rect.node.label}/
                </span>
              )}
            </div>
          );
        }
        const file = rect.node;
        const tone = tileTone(file, slots);
        const showName = rect.width >= NAME_MIN.width && rect.height >= NAME_MIN.height;
        const showBadge =
          file.chapter !== null && rect.width >= BADGE_MIN.width && rect.height >= BADGE_MIN.height;
        return (
          <TooltipHint key={`file:${file.path}`} content={tileHint(file)} side="top" align="start">
            <button
              type="button"
              aria-label={tileHint(file)}
              onClick={() => onOpenFile(file.path)}
              style={{ ...box, ...toneStyle(tone) }}
              className={cn(
                "absolute flex flex-col items-start justify-between overflow-hidden rounded-[4px] px-1.5 py-1 text-left outline-none",
                "cursor-pointer hover:brightness-[0.95] focus-visible:ring-2 focus-visible:ring-ring dark:hover:brightness-125",
              )}
            >
              {showName && (
                <span className="w-full truncate text-xs leading-4 text-foreground">
                  {file.name}
                </span>
              )}
              {showBadge && file.chapter !== null && (
                <span className="font-mono text-[11px] leading-4 tabular-nums text-text-muted">
                  {badgeText(file.chapter.ordinal)}
                </span>
              )}
            </button>
          </TooltipHint>
        );
      })}
    </div>
  );
}
