import { describe, expect, it } from "vitest";
import type { ReviewLayer } from "../../../shared/review";
import {
  capturesScroll,
  emptySoloReason,
  layerFilePaths,
  resolveLayerScroll,
  soloFiles,
  stepLayer,
} from "./layers";
import { parsePatch, type PatchFile } from "./diff/patch";

// A two-file diff: foo.ts carries a hunk covering addition lines 10..14, bar.ts a
// hunk covering addition lines 1..3. Real parsePatch construction so the fileDiff
// hunks the scroll resolver reads are the genuine shape, not a hand-stubbed one.
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

function layer(id: string, overrides: Partial<ReviewLayer> = {}): ReviewLayer {
  return {
    id,
    label: `Layer ${id}`,
    summary: `Summary ${id}`,
    kind: "feature",
    ranges: [{ file: "src/foo.ts", side: "additions", startLine: 11, endLine: 13 }],
    ...overrides,
  };
}

const A = layer("a");
const B = layer("b", {
  ranges: [{ file: "src/bar.ts", side: "additions", startLine: 2, endLine: 3 }],
});
const C = layer("c");
const LAYERS: ReviewLayer[] = [A, B, C];

describe("stepLayer", () => {
  it("returns the authored-order neighbour in each direction", () => {
    expect(stepLayer(LAYERS, "a", 1)).toBe("b");
    expect(stepLayer(LAYERS, "b", 1)).toBe("c");
    expect(stepLayer(LAYERS, "c", -1)).toBe("b");
    expect(stepLayer(LAYERS, "b", -1)).toBe("a");
  });

  it("clamps at both ends rather than wrapping", () => {
    expect(stepLayer(LAYERS, "c", 1)).toBe("c");
    expect(stepLayer(LAYERS, "a", -1)).toBe("a");
  });

  it("enters at the first layer forward and the last layer backward from a cleared solo", () => {
    expect(stepLayer(LAYERS, null, 1)).toBe("a");
    expect(stepLayer(LAYERS, null, -1)).toBe("c");
  });

  it("returns null for an empty layer set", () => {
    expect(stepLayer([], null, 1)).toBeNull();
    expect(stepLayer([], "a", -1)).toBeNull();
  });

  it("does not re-sort: authored order drives stepping even when ids are unordered", () => {
    const unordered = [layer("z"), layer("m"), layer("a")];
    expect(stepLayer(unordered, "z", 1)).toBe("m");
    expect(stepLayer(unordered, "m", 1)).toBe("a");
  });
});

describe("layerFilePaths", () => {
  it("collapses repeated files to one entry in first-appearance order", () => {
    const overlapping = layer("x", {
      ranges: [
        { file: "src/bar.ts", side: "additions", startLine: 2, endLine: 2 },
        { file: "src/foo.ts", side: "additions", startLine: 11, endLine: 11 },
        { file: "src/bar.ts", side: "additions", startLine: 3, endLine: 3 },
      ],
    });
    expect(layerFilePaths(overlapping, [overlapping])).toEqual(["src/bar.ts", "src/foo.ts"]);
  });

  it("rolls a no-ranges parent up to the union of its descendants' files", () => {
    // `parent` (no ranges) rolls up child-foo + child-bar; grandchild deepens the
    // chain to prove the rollup is transitive, and the union is in authored order.
    const parent = layer("parent", { ranges: [] });
    const childFoo = layer("child-foo", { parent: "parent" });
    const childBar = layer("child-bar", {
      parent: "parent",
      ranges: [{ file: "src/bar.ts", side: "additions", startLine: 2, endLine: 3 }],
    });
    const grandchild = layer("grandchild", {
      parent: "child-bar",
      ranges: [{ file: "src/baz.ts", side: "additions", startLine: 1, endLine: 1 }],
    });
    const all = [parent, childFoo, childBar, grandchild];
    expect(layerFilePaths(parent, all)).toEqual(["src/foo.ts", "src/bar.ts", "src/baz.ts"]);
  });

  it("is empty for a bare no-ranges layer with no descendants", () => {
    const bare = layer("p", { ranges: [] });
    expect(layerFilePaths(bare, [bare])).toEqual([]);
  });

  it("terminates on a parent cycle rather than looping", () => {
    // A tampered artifact can point two no-ranges layers at each other; the union
    // must still resolve (to empty — neither carries ranges) instead of hanging.
    const one = layer("one", { ranges: [], parent: "two" });
    const two = layer("two", { ranges: [], parent: "one" });
    expect(layerFilePaths(one, [one, two])).toEqual([]);
  });
});

describe("soloFiles", () => {
  it("passes exactly the active layer's file subset, in diff order", () => {
    expect(soloFiles(FILES, A, LAYERS).map((file) => file.path)).toEqual(["src/foo.ts"]);
    expect(soloFiles(FILES, B, LAYERS).map((file) => file.path)).toEqual(["src/bar.ts"]);
  });

  it("restores the full set when no layer is active", () => {
    expect(soloFiles(FILES, null, LAYERS).map((file) => file.path)).toEqual([
      "src/foo.ts",
      "src/bar.ts",
    ]);
  });

  it("keeps a file shared across layers visible under whichever layer solos it", () => {
    const shared = layer("shared", {
      ranges: [
        { file: "src/foo.ts", side: "additions", startLine: 11, endLine: 11 },
        { file: "src/bar.ts", side: "additions", startLine: 2, endLine: 2 },
      ],
    });
    expect(soloFiles(FILES, shared, [shared]).map((file) => file.path)).toEqual([
      "src/foo.ts",
      "src/bar.ts",
    ]);
  });

  it("solos a no-ranges parent to its descendants' files, not the drifted dead-end", () => {
    // A parent rollup resolves to the files its descendants touch, not an empty
    // subset, so soloing it is not a dead-end.
    const parent = layer("parent", { ranges: [] });
    const childFoo = layer("child-foo", { parent: "parent" });
    const childBar = layer("child-bar", {
      parent: "parent",
      ranges: [{ file: "src/bar.ts", side: "additions", startLine: 2, endLine: 3 }],
    });
    const all = [parent, childFoo, childBar];
    expect(soloFiles(FILES, parent, all).map((file) => file.path)).toEqual([
      "src/foo.ts",
      "src/bar.ts",
    ]);
  });
});

describe("emptySoloReason", () => {
  it("reports 'drifted' when a layer names files the loaded diff no longer holds", () => {
    const gone = layer("gone", {
      ranges: [{ file: "src/gone.ts", side: "additions", startLine: 1, endLine: 1 }],
    });
    expect(emptySoloReason(gone, [gone])).toBe("drifted");
  });

  it("reports 'rollup' for a bare parent with no diff of its own — not a drift", () => {
    // An empty-ranges layer with nothing under it to union never had files to
    // drift, so it reads as a rollup, not the outdated case.
    const bare = layer("bare", { ranges: [] });
    expect(emptySoloReason(bare, [bare])).toBe("rollup");
  });

  it("reports 'drifted' when a parent's rolled-up descendant files all drifted out", () => {
    // The rollup resolves to real file paths, but none survive in the diff — that
    // is a genuine drift of the whole subtree, not a bare-parent empty state.
    const parent = layer("parent", { ranges: [] });
    const child = layer("child", {
      parent: "parent",
      ranges: [{ file: "src/gone.ts", side: "additions", startLine: 1, endLine: 1 }],
    });
    expect(emptySoloReason(parent, [parent, child])).toBe("drifted");
  });
});

describe("capturesScroll", () => {
  it("captures scroll only on the un-soloed full diff, so layer nav never persists", () => {
    expect(capturesScroll(null)).toBe(true);
    expect(capturesScroll("layer-a")).toBe(false);
  });
});

describe("resolveLayerScroll", () => {
  it("targets the first range when it resolves against the loaded diff", () => {
    expect(resolveLayerScroll(A, FILES, false)).toEqual({
      kind: "placed",
      fileId: "src/foo.ts",
      range: { start: 11, end: 13, side: "additions" },
    });
  });

  it("flags outdated without throwing when the first range's file is gone", () => {
    const gone = layer("gone", {
      ranges: [{ file: "src/gone.ts", side: "additions", startLine: 1, endLine: 1 }],
    });
    expect(resolveLayerScroll(gone, FILES, false)).toEqual({ kind: "outdated" });
  });

  it("flags outdated without throwing when no hunk covers the first range", () => {
    const drifted = layer("drifted", {
      ranges: [{ file: "src/foo.ts", side: "additions", startLine: 500, endLine: 500 }],
    });
    expect(resolveLayerScroll(drifted, FILES, false)).toEqual({ kind: "outdated" });
  });

  it("places an off-hunk range against a frozen patch, never outdated", () => {
    // The same range a re-derived diff flags outdated (no hunk covers line 500)
    // places on its authored first line when the review pins its own patch —
    // the layer surface must agree with the comment surface under a frozen diff.
    const drifted = layer("drifted", {
      ranges: [{ file: "src/foo.ts", side: "additions", startLine: 500, endLine: 502 }],
    });
    expect(resolveLayerScroll(drifted, FILES, true)).toEqual({
      kind: "placed",
      fileId: "src/foo.ts",
      range: { start: 500, end: 502, side: "additions" },
    });
  });

  it("fails soft even when frozen if the first range's file is absent from the patch", () => {
    // The frozen sidestep still requires the file to render: a layer pointing at a
    // file the embedded patch lacks fails soft, matching the comment surface which
    // never annotates a file it does not render.
    const gone = layer("gone", {
      ranges: [{ file: "src/gone.ts", side: "additions", startLine: 1, endLine: 1 }],
    });
    expect(resolveLayerScroll(gone, FILES, true)).toEqual({ kind: "outdated" });
  });

  it("reports none for a layer with no ranges, frozen or not", () => {
    expect(resolveLayerScroll(layer("empty", { ranges: [] }), FILES, false)).toEqual({
      kind: "none",
    });
    expect(resolveLayerScroll(layer("empty", { ranges: [] }), FILES, true)).toEqual({
      kind: "none",
    });
  });
});
