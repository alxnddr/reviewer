import { describe, expect, it } from "vitest";
import type { ReviewLayer } from "../../../shared/review";
import { buildPathsPatch } from "../../../shared/diff/fixtures";
import { parsePatch } from "../../../shared/diff/patch";
import {
  chapterStripInput,
  layoutChapterStrip,
  readState,
  type ChapterStripInput,
  type StripChapter,
} from "./chapter-strip";
import { UNCOVERED_LAYER_ID } from "./coverage";
import { buildOverview } from "./overview";
import { markFilesRead, NO_READ_FILES } from "./read-progress";

// Five new files of ten added lines each (lines 1..10), so a range's share is its line count.
const FILES = parsePatch(
  buildPathsPatch(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"], 10),
  "strip-test",
);

function layer(id: string, ranges: ReviewLayer["ranges"], extra: Partial<ReviewLayer> = {}) {
  return { id, label: `${id} label`, summary: `${id} summary`, ranges, ...extra };
}

function lines(file: string, startLine: number, endLine: number) {
  return { file, side: "additions" as const, startLine, endLine };
}

function chapter(id: string, count: number): StripChapter {
  return { id, ordinal: id, label: id, lines: count, read: { read: 0, total: 1 }, skim: false };
}

function strip(chapters: StripChapter[], remainder = 0): ChapterStripInput {
  return { chapters, remainder: { lines: remainder, layerId: null, read: null } };
}

describe("chapterStripInput", () => {
  // `one` spans a.ts and, overlapping `two`, half of b.ts; `two` spans all of b.ts and has a
  // nested child owning c.ts. d.ts is covered by nothing anyone references → the inferred layer;
  // e.ts is half covered by `two`.
  const one = layer("one", [lines("src/a.ts", 1, 10), lines("src/b.ts", 1, 5)]);
  const two = layer("two", [lines("src/b.ts", 1, 10), lines("src/e.ts", 1, 5)], { skim: true });
  const nested = layer("nested", [lines("src/c.ts", 1, 10)], { parent: "two" });
  const layers = [one, two, nested];
  const readFiles = markFilesRead(NO_READ_FILES, FILES.slice(0, 1), true);
  const overview = buildOverview({ layers, files: FILES, comments: [], frozen: false, readFiles });
  const input = chapterStripInput(overview, FILES, layers);

  it("partitions the change: every changed line counted once, the remainder included", () => {
    // Overlap goes to the first in document order (`layerOwning`'s tie-break among equals), and a
    // nested layer's lines to its top-level chapter.
    expect(input.chapters.map((current) => [current.id, current.lines])).toEqual([
      ["one", 15],
      ["two", 5 + 10 + 5],
    ]);
    expect(input.remainder.lines).toBe(10 + 5);
    const total = input.chapters.reduce((sum, current) => sum + current.lines, 0);
    expect(total + input.remainder.lines).toBe(overview.additions + overview.deletions);
    // The overview's own extents overlap, which is why the strip does not use them.
    const extents = overview.chapters
      .filter((current) => current.depth === 0 && current.ordinal !== null)
      .reduce((sum, current) => sum + current.additions + current.deletions, 0);
    expect(extents).toBeGreaterThan(total);
  });

  it("takes labels, numbers, skim and progress from the overview", () => {
    expect(input.chapters).toEqual([
      {
        id: "one",
        ordinal: "1",
        label: "one label",
        lines: 15,
        read: { read: 1, total: 2 },
        skim: false,
      },
      {
        id: "two",
        ordinal: "2",
        label: "two label",
        lines: 20,
        read: { read: 0, total: 3 },
        skim: true,
      },
    ]);
    expect(input.remainder).toEqual({
      lines: 15,
      layerId: UNCOVERED_LAYER_ID,
      read: { read: 0, total: 1 },
    });
  });

  it("has no remainder to open when every file is referenced, even if lines are uncovered", () => {
    const partial = [
      layer(
        "only",
        FILES.map((file) => lines(file.path, 1, 4)),
      ),
    ];
    const result = chapterStripInput(
      buildOverview({
        layers: partial,
        files: FILES,
        comments: [],
        frozen: false,
        readFiles: NO_READ_FILES,
      }),
      FILES,
      partial,
    );
    expect(result.remainder).toEqual({ lines: 30, layerId: null, read: null });
  });
});

describe("layoutChapterStrip", () => {
  it("splits the width in proportion to lines, gaps included", () => {
    const segments = layoutChapterStrip(strip([chapter("a", 30), chapter("b", 10)], 60), 204, {
      minSegmentWidth: 0,
      gap: 2,
    });
    expect(segments.map((segment) => [segment.kind, segment.x, segment.width])).toEqual([
      ["chapter", 0, 60],
      ["chapter", 62, 20],
      ["remainder", 84, 120],
    ]);
  });

  it("holds a tiny chapter at the floor and re-shares the rest", () => {
    const segments = layoutChapterStrip(
      strip([chapter("big", 990), chapter("tiny", 1), chapter("none", 0), chapter("mid", 9)]),
      100,
      { minSegmentWidth: 10, gap: 0 },
    );
    const widths = segments.map((segment) => segment.width);
    expect(widths[1]).toBe(10);
    expect(widths[2]).toBe(10);
    expect(widths[3]).toBe(10);
    expect(widths[0]).toBeCloseTo(70, 9);
    expect(widths.reduce((sum, width) => sum + width, 0)).toBeCloseTo(100, 9);
  });

  it("falls back to equal slivers when the floors alone do not fit", () => {
    const segments = layoutChapterStrip(strip([chapter("a", 1), chapter("b", 99)]), 15, {
      minSegmentWidth: 10,
      gap: 1,
    });
    expect(segments.map((segment) => [segment.x, segment.width])).toEqual([
      [0, 7],
      [8, 7],
    ]);
  });

  it("draws no remainder when every line is owned, and nothing for nothing", () => {
    expect(layoutChapterStrip(strip([chapter("a", 5)]), 50).map((s) => s.kind)).toEqual([
      "chapter",
    ]);
    expect(layoutChapterStrip(strip([]), 50)).toEqual([]);
  });

  it("states each segment's progress", () => {
    expect(readState({ read: 0, total: 0 })).toBe("empty");
    expect(readState({ read: 0, total: 3 })).toBe("unread");
    expect(readState({ read: 1, total: 3 })).toBe("partial");
    expect(readState({ read: 3, total: 3 })).toBe("read");
    const [remainder] = layoutChapterStrip(strip([], 4), 50);
    expect(remainder).toMatchObject({ kind: "remainder", state: null, layerId: null });
  });
});
