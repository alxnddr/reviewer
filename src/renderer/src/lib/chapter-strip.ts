import type { ReviewLayer } from "../../../shared/review";
import type { PatchFile } from "../../../shared/diff/patch";
import { layerOutline } from "../../../shared/layers";
import { UNCOVERED_LAYER_ID } from "./coverage";
import { lineOwnership } from "./module-map";
import type { OverviewModel } from "./overview";
import { isFullyRead, type ReadTally } from "./read-progress";

// The chapter strip: the whole change as one horizontal bar, one segment per top-level chapter,
// each as wide as the share of the changed lines it explains, then the remainder no chapter
// explains — so "how big is each part, and how far through it am I" is one glance, and each
// segment is a door into its chapter.
//
// **The widths partition the change; they do not sum the chapters.** A chapter's own figure in
// the overview (`OverviewChapter.additions/deletions`) is its *extent* — every line any of its
// ranges spans — and two chapters may span the same lines, so those figures can add up to more
// than the diff. A bar is a whole cut into parts, so here every changed line is counted exactly
// once: to the top-level chapter above the layer that *owns* it (`lineOwnership`, the same
// attribution the module map tints by, which is `layerOwning`'s deepest-layer rule), or to the
// remainder when no layer owns it. The segments therefore sum to the diff's changed lines, and a
// tile on the map and a segment on the strip can never name different owners for one line.
//
// Everything else a segment shows is read off the overview model rather than re-derived: the
// label, the section number, `skim`, and the read tally (`layerTally`, the rail's ring), so the
// strip and the chapters below it report one reader's progress one way.
//
// Pure geometry at the end (`layoutChapterStrip`): proportional widths with a floor, so a
// two-line chapter is still something a pointer can land on.

/** One top-level chapter's share of the change. */
export type StripChapter = {
  id: string;
  ordinal: string;
  label: string;
  /** Changed lines owned by this chapter or anything nested under it. */
  lines: number;
  read: ReadTally;
  skim: boolean;
};

/** The lines no layer owns. `layerId` is the inferred "not covered" layer when there is one to
 * solo — it exists only for files *no* layer references, so a remainder made only of the gaps
 * in partly covered files has nothing to open and reads null; `read` is that layer's tally. */
export type StripRemainder = { lines: number; layerId: string | null; read: ReadTally | null };

export type ChapterStripInput = { chapters: StripChapter[]; remainder: StripRemainder };

/** A segment's progress, for its fill: nothing to read (`empty` — a chapter whose files all
 * left the diff), none, some, or all of it read. */
export type ReadState = "empty" | "unread" | "partial" | "read";

export function readState(tally: ReadTally): ReadState {
  if (tally.total === 0) {
    return "empty";
  }
  if (isFullyRead(tally)) {
    return "read";
  }
  return tally.read === 0 ? "unread" : "partial";
}

/** The strip's content: every top-level chapter of the overview, in authored order, with its
 * share of the change measured by ownership (see the module header), plus the remainder.
 * `layers` are the authored layers the overview was built from — not `effectiveLayers`, whose
 * inferred layer would own the very lines the remainder counts. */
export function chapterStripInput(
  overview: OverviewModel,
  files: readonly PatchFile[],
  layers: readonly ReviewLayer[],
): ChapterStripInput {
  const topOf = new Map(
    layerOutline(layers).map((entry) => [entry.layer.id, entry.ancestors[0]?.id ?? entry.layer.id]),
  );
  const linesByTop = new Map<string, number>();
  let uncovered = 0;
  for (const file of files) {
    const ownership = lineOwnership(file, layers);
    uncovered += ownership.uncovered;
    for (const [layerId, count] of ownership.byLayer) {
      const top = topOf.get(layerId) ?? layerId;
      linesByTop.set(top, (linesByTop.get(top) ?? 0) + count);
    }
  }

  const chapters: StripChapter[] = [];
  let inferred: OverviewModel["chapters"][number] | undefined;
  for (const chapter of overview.chapters) {
    if (chapter.layer.id === UNCOVERED_LAYER_ID) {
      inferred = chapter;
      continue;
    }
    if (chapter.depth !== 0 || chapter.ordinal === null) {
      continue;
    }
    chapters.push({
      id: chapter.layer.id,
      ordinal: chapter.ordinal,
      label: chapter.layer.label,
      lines: linesByTop.get(chapter.layer.id) ?? 0,
      read: chapter.read,
      skim: chapter.skim,
    });
  }
  return {
    chapters,
    remainder: {
      lines: uncovered,
      layerId: inferred?.layer.id ?? null,
      read: inferred?.read ?? null,
    },
  };
}

export type StripSegment =
  | (StripChapter & { kind: "chapter"; x: number; width: number; state: ReadState })
  | (StripRemainder & { kind: "remainder"; x: number; width: number; state: ReadState | null });

export type StripLayoutOptions = {
  /** No segment is drawn narrower than this, so every chapter stays clickable. */
  minSegmentWidth: number;
  /** Space between two segments. */
  gap: number;
};

export const DEFAULT_STRIP_LAYOUT_OPTIONS: StripLayoutOptions = { minSegmentWidth: 12, gap: 2 };

/** Widths proportional to `weights` over `available` px, none below `min`: segments whose share
 * would fall under the floor are pinned to it and the rest re-share what is left, until nothing
 * else falls under. When even the floors do not fit, every segment gets an equal share — a strip
 * of equal slivers still navigates, where one that overflowed its box would not. */
function flooredWidths(weights: readonly number[], available: number, min: number): number[] {
  const count = weights.length;
  if (count === 0) {
    return [];
  }
  if (available <= count * min) {
    return weights.map(() => Math.max(0, available / count));
  }
  const pinned = new Set<number>();
  for (;;) {
    const free = available - pinned.size * min;
    const open = weights.flatMap((weight, index) => (pinned.has(index) ? [] : [{ weight, index }]));
    const total = open.reduce((sum, entry) => sum + entry.weight, 0);
    const share = (weight: number): number =>
      total > 0 ? (weight / total) * free : free / open.length;
    const under = open.filter((entry) => share(entry.weight) < min);
    if (under.length === 0) {
      return weights.map((weight, index) => (pinned.has(index) ? min : share(weight)));
    }
    for (const entry of under) {
      pinned.add(entry.index);
    }
  }
}

/** The strip laid out across `width` px: the chapters in order, then the remainder when it has
 * lines. Every segment's `x` and `width` are px from the strip's left edge, and together with
 * the gaps they fill `width` exactly. */
export function layoutChapterStrip(
  input: ChapterStripInput,
  width: number,
  options: Partial<StripLayoutOptions> = {},
): StripSegment[] {
  const settings = { ...DEFAULT_STRIP_LAYOUT_OPTIONS, ...options };
  const parts: (
    | { kind: "chapter"; chapter: StripChapter }
    | { kind: "remainder"; remainder: StripRemainder }
  )[] = input.chapters.map((chapter) => ({ kind: "chapter", chapter }));
  if (input.remainder.lines > 0) {
    parts.push({ kind: "remainder", remainder: input.remainder });
  }
  const available = Math.max(0, width - settings.gap * Math.max(0, parts.length - 1));
  const widths = flooredWidths(
    parts.map((part) => (part.kind === "chapter" ? part.chapter.lines : part.remainder.lines)),
    available,
    settings.minSegmentWidth,
  );
  let x = 0;
  return parts.map((part, index): StripSegment => {
    const segmentWidth = widths[index] ?? 0;
    const at = x;
    x += segmentWidth + settings.gap;
    if (part.kind === "chapter") {
      return {
        ...part.chapter,
        kind: "chapter",
        x: at,
        width: segmentWidth,
        state: readState(part.chapter.read),
      };
    }
    return {
      ...part.remainder,
      kind: "remainder",
      x: at,
      width: segmentWidth,
      state: part.remainder.read === null ? null : readState(part.remainder.read),
    };
  });
}
