import { describe, expect, it } from "vitest";
import type { ReviewLayer } from "../../../shared/review";
import {
  coverageSummary,
  effectiveLayers,
  uncoveredLayerFrom,
  UNCOVERED_LAYER_ID,
} from "./coverage";
import { parsePatch, type PatchFile } from "../../../shared/diff/patch";

// A two-file diff measured by the real parser, so the changed-line universe the summary
// scores against is the genuine one. foo.ts: additions {11,12,13}, deletion {11} — four
// coverable lines. bar.ts: additions {2,3} — two coverable lines. Six coverable in all.
const PATCH = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "index 1111111..2222222 100644",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -10,3 +10,5 @@",
  " ctx10",
  "-old11",
  "+new11",
  "+new12",
  "+new13",
  " ctx14",
  "diff --git a/src/bar.ts b/src/bar.ts",
  "index 3333333..4444444 100644",
  "--- a/src/bar.ts",
  "+++ b/src/bar.ts",
  "@@ -1,1 +1,3 @@",
  " ctx1",
  "+new2",
  "+new3",
  "",
].join("\n");

const FILES: PatchFile[] = parsePatch(PATCH, "test");

function layer(id: string, ranges: ReviewLayer["ranges"]): ReviewLayer {
  return { id, label: id, summary: id, ranges };
}

// Covers only foo's three additions — leaves foo's deletion 11 and bar's additions 2..3.
const FOO_ADDS = layer("foo-adds", [
  { file: "src/foo.ts", side: "additions", startLine: 11, endLine: 13 },
]);

// Covers everything coverable across both files.
const ALL = [
  layer("foo-all", [
    { file: "src/foo.ts", side: "additions", startLine: 11, endLine: 13 },
    { file: "src/foo.ts", side: "deletions", startLine: 11, endLine: 11 },
  ]),
  layer("bar-all", [{ file: "src/bar.ts", side: "additions", startLine: 2, endLine: 3 }]),
];

describe("coverageSummary", () => {
  it("reports line-based headline numbers alongside the file-based remainder", () => {
    const summary = coverageSummary(FILES, [FOO_ADDS]);
    expect(summary.coveredLines).toBe(3);
    expect(summary.coverableLines).toBe(6);
    expect(summary.linePct).toBe(50);
    // foo is only partially covered, bar not at all — neither is a fully-covered file.
    expect(summary.coveredFiles).toBe(0);
    expect(summary.coverableFiles).toBe(2);
    // But only bar is *unwalked*: foo's deletion 11 is line-uncovered, yet FOO_ADDS walks
    // the file, so foo is not part of the remainder.
    expect(summary.uncoveredFiles).toBe(1);
  });

  it("projects the unwalked files into a synthetic soloable layer", () => {
    const { uncoveredLayer } = coverageSummary(FILES, [FOO_ADDS]);
    expect(uncoveredLayer).not.toBeNull();
    expect(uncoveredLayer?.id).toBe(UNCOVERED_LAYER_ID);
    expect(uncoveredLayer?.ranges).toEqual([
      { file: "src/bar.ts", side: "additions", startLine: 2, endLine: 3 },
    ]);
    expect(uncoveredLayer?.summary).toBe("1 file that no layer covers.");
  });

  it("omits a partially-walked file from the remainder", () => {
    // FOO_ADDS leaves foo's deletion 11 uncovered; the file must still not surface here,
    // or it would show under both its own layer's solo and this one.
    const { uncoveredLayer } = coverageSummary(FILES, [FOO_ADDS]);
    expect(uncoveredLayer?.ranges.some((range) => range.file === "src/foo.ts")).toBe(false);
  });

  it("has no synthetic layer when every coverable file is walked", () => {
    const summary = coverageSummary(FILES, ALL);
    expect(summary.linePct).toBe(100);
    expect(summary.uncoveredFiles).toBe(0);
    expect(summary.coveredFiles).toBe(2);
    expect(summary.uncoveredLayer).toBeNull();
  });

  it("treats a layer-less diff as entirely uncovered", () => {
    const summary = coverageSummary(FILES, []);
    // No layers at all: every coverable file is a gap, so the remainder is the whole diff.
    expect(summary.linePct).toBe(0);
    expect(summary.uncoveredFiles).toBe(2);
    expect(summary.uncoveredLayer?.summary).toBe("2 files that no layer covers.");
    expect(summary.uncoveredLayer?.ranges).toEqual([
      // deletions first, then additions (the report's fixed side order); files in diff order.
      { file: "src/foo.ts", side: "deletions", startLine: 11, endLine: 11 },
      { file: "src/foo.ts", side: "additions", startLine: 11, endLine: 13 },
      { file: "src/bar.ts", side: "additions", startLine: 2, endLine: 3 },
    ]);
  });
});

describe("effectiveLayers", () => {
  it("appends the synthetic layer when a gap exists", () => {
    const layers = effectiveLayers(FILES, [FOO_ADDS]);
    expect(layers).toHaveLength(2);
    expect(layers[0]).toBe(FOO_ADDS);
    expect(layers[1]?.id).toBe(UNCOVERED_LAYER_ID);
  });

  it("returns just the authored layers when fully covered", () => {
    const layers = effectiveLayers(FILES, ALL);
    expect(layers.map((l) => l.id)).toEqual(["foo-all", "bar-all"]);
  });

  it("reads a precomputed summary instead of walking the diff again", () => {
    // The shortcut has to answer the same question the walk does — including the
    // fully-covered case, where "no inferred layer" is a real answer and not a missing one.
    for (const layers of [[FOO_ADDS], ALL, []]) {
      expect(effectiveLayers(FILES, layers, coverageSummary(FILES, layers))).toEqual(
        effectiveLayers(FILES, layers),
      );
    }
  });
});

describe("uncoveredLayerFrom", () => {
  it("lifts the remainder out of a report the caller already holds", () => {
    const { report, uncoveredLayer } = coverageSummary(FILES, [FOO_ADDS]);
    expect(uncoveredLayerFrom(report, [FOO_ADDS])).toEqual(uncoveredLayer);
  });
});
