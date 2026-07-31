import { describe, expect, it } from "vitest";
import type { ReviewLayer } from "./review";
import {
  capturesScroll,
  emptySoloReason,
  layerFilePaths,
  layerOutline,
  layerOwning,
  layerRanges,
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

  it("walks the tree in document order — a parent is a stop like any other", () => {
    // Selecting a parent shows its whole extent, so it is a place to stand, not a label
    // to skip. Stepping is therefore exactly the authored order.
    const parent = layer("parent", { ranges: [] });
    const child = layer("child", { parent: "parent" });
    const walk = [A, parent, child, C];

    expect(stepLayer(walk, "a", 1)).toBe("parent");
    expect(stepLayer(walk, "parent", 1)).toBe("child");
    expect(stepLayer(walk, "child", -1)).toBe("parent");
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

  it("gives a parent the extent of everything under it, at any depth", () => {
    // The aggregation rule: a layer covers its own ranges plus its descendants'. That is
    // what makes a parent a real place to stand — soloing it shows the whole group.
    const root = layer("root", { ranges: [] });
    const mid = layer("mid", { parent: "root", ranges: [] });
    const leaf = layer("leaf", {
      parent: "mid",
      ranges: [{ file: "src/bar.ts", side: "additions", startLine: 2, endLine: 3 }],
    });
    const all = [root, mid, leaf];

    expect(layerFilePaths(root, all)).toEqual(["src/bar.ts"]);
    expect(layerFilePaths(mid, all)).toEqual(["src/bar.ts"]);
    expect(layerRanges(root, all)).toHaveLength(1);
  });

  it("counts a parent's own ranges as well as its children's", () => {
    const parent = layer("parent");
    const child = layer("child", {
      parent: "parent",
      ranges: [{ file: "src/bar.ts", side: "additions", startLine: 2, endLine: 3 }],
    });
    expect(layerFilePaths(parent, [parent, child])).toEqual(["src/foo.ts", "src/bar.ts"]);
  });
});

describe("layerOutline", () => {
  it("numbers the tree by section: 1, 2, 2.1, 2.1.1, 3", () => {
    const first = layer("first");
    const parent = layer("parent", { ranges: [] });
    const childOne = layer("child-1", { parent: "parent", ranges: [] });
    const grandchild = layer("grandchild", { parent: "child-1" });
    const childTwo = layer("child-2", { parent: "parent" });
    const last = layer("last");
    const all = [first, parent, childOne, grandchild, childTwo, last];
    const outline = layerOutline(all);

    expect(outline.map((entry) => entry.ordinal)).toEqual(["1", "2", "2.1", "2.1.1", "2.2", "3"]);
    expect(outline.map((entry) => entry.depth)).toEqual([0, 0, 1, 2, 1, 0]);
    // The trail up, outermost first — what the band's breadcrumb walks.
    expect(outline[3]?.ancestors.map((l) => l.id)).toEqual(["parent", "child-1"]);
    // …and the extent down, in document order.
    expect(outline[1]?.subtree.map((l) => l.id)).toEqual([
      "parent",
      "child-1",
      "grandchild",
      "child-2",
    ]);
    expect(outline[1]?.children.map((l) => l.id)).toEqual(["child-1", "child-2"]);
  });

  it("reads an illegal link as no link, so a hand-edited artifact still opens flat", () => {
    // Each breaks a rule the CLI gate refuses at emit time. The app must still render the
    // review — it just reads the layer as top-level rather than inventing a hierarchy.
    const orphan = layer("orphan", { parent: "nobody" });
    const selfParent = layer("self", { parent: "self" });
    const outline = layerOutline([orphan, selfParent]);

    expect(outline.map((entry) => entry.ordinal)).toEqual(["1", "2"]);
    expect(outline.every((entry) => entry.depth === 0)).toBe(true);
  });

  it("terminates on a parent cycle rather than looping", () => {
    const one = layer("one", { parent: "two" });
    const two = layer("two", { parent: "one" });
    expect(layerOutline([one, two]).map((entry) => entry.ordinal)).toEqual(["1", "2"]);
  });

  it("stops honouring `parent` past the depth cap", () => {
    // Five levels is the cap, so a sixth reads as top-level rather than indenting further.
    const chain = [
      layer("l1", { ranges: [] }),
      layer("l2", { parent: "l1", ranges: [] }),
      layer("l3", { parent: "l2", ranges: [] }),
      layer("l4", { parent: "l3", ranges: [] }),
      layer("l5", { parent: "l4", ranges: [] }),
      layer("l6", { parent: "l5" }),
    ];
    const outline = layerOutline(chain);
    expect(outline.map((entry) => entry.depth)).toEqual([0, 1, 2, 3, 4, 0]);
  });
});

describe("layerOutline caching", () => {
  it("reuses the same tree across calls sharing a `layers` identity", () => {
    // `layerOutline` (and `layerRanges`, through `layerSubtree`) builds a tree from `layers`
    // on every call; each of `overview.ts`'s and `review-export.ts`'s per-comment loops calls
    // one of them once per item. A `WeakMap` cache keyed on `layers`' own identity — stable
    // because `layers` is memoized upstream — means the tree is built once and every lookup
    // after the first reads it back out. `childrenOf.get(id)` inside the (uncached) outline
    // entry is handed back by reference, not copied, so two calls sharing one cached tree
    // must hand back the very same array for a given layer's children — a fresh tree per
    // call would produce two content-equal but distinct arrays instead.
    const parent = layer("parent", { ranges: [] });
    const child = layer("child", { parent: "parent" });
    const all = [parent, child];

    const first = layerOutline(all);
    const second = layerOutline(all);

    const firstParentEntry = first.find((entry) => entry.layer.id === "parent");
    const secondParentEntry = second.find((entry) => entry.layer.id === "parent");
    expect(firstParentEntry?.children).toBe(secondParentEntry?.children);

    // A genuinely different array (even with identical content) misses the cache and
    // recomputes — so a real edit to `layers` is never served stale structure.
    const rebuilt = layerOutline([parent, child]);
    const rebuiltParentEntry = rebuilt.find((entry) => entry.layer.id === "parent");
    expect(rebuiltParentEntry?.children).not.toBe(firstParentEntry?.children);
    expect(rebuiltParentEntry?.children).toEqual(firstParentEntry?.children);
  });
});

describe("layerOwning", () => {
  it("gives a comment to the deepest layer whose own ranges cover it", () => {
    // The parent's extent covers the anchor too — by aggregation — but ownership belongs
    // to the most specific claim, so the section that explains those lines keeps it.
    const parent = layer("parent", {
      ranges: [{ file: "src/foo.ts", side: "additions", startLine: 11, endLine: 13 }],
    });
    const child = layer("child", {
      parent: "parent",
      ranges: [{ file: "src/foo.ts", side: "additions", startLine: 12, endLine: 12 }],
    });
    const anchor = { file: "src/foo.ts", side: "additions" as const, startLine: 12, endLine: 12 };

    expect(layerOwning([parent, child], anchor)?.id).toBe("child");
    expect(layerOwning([parent], anchor)?.id).toBe("parent");
    expect(layerOwning([parent, child], { ...anchor, file: "src/elsewhere.ts" })).toBeNull();
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

  it("solos a parent to its whole group, and a child to its own section", () => {
    const parent = layer("parent", { ranges: [] });
    const child = layer("child", {
      parent: "parent",
      ranges: [{ file: "src/bar.ts", side: "additions", startLine: 2, endLine: 3 }],
    });
    const sibling = layer("sibling", { parent: "parent" });
    const all = [parent, child, sibling];

    expect(soloFiles(FILES, parent, all).map((file) => file.path)).toEqual([
      "src/foo.ts",
      "src/bar.ts",
    ]);
    expect(soloFiles(FILES, child, all).map((file) => file.path)).toEqual(["src/bar.ts"]);
  });
});

describe("emptySoloReason", () => {
  it("reports 'drifted' when a layer names files the loaded diff no longer holds", () => {
    const gone = layer("gone", {
      ranges: [{ file: "src/gone.ts", side: "additions", startLine: 1, endLine: 1 }],
    });
    expect(emptySoloReason(gone, [gone])).toBe("drifted");
  });

  it("reports 'empty' only when the whole extent names no code — not a drift", () => {
    const bare = layer("bare", { ranges: [] });
    expect(emptySoloReason(bare, [bare])).toBe("empty");
    // With a child that names a (drifted) file, the extent is no longer empty.
    const child = layer("child", {
      parent: "bare",
      ranges: [{ file: "src/gone.ts", side: "additions", startLine: 1, endLine: 1 }],
    });
    expect(emptySoloReason(bare, [bare, child])).toBe("drifted");
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
    expect(resolveLayerScroll(A, LAYERS, FILES, false)).toEqual({
      kind: "placed",
      fileId: "src/foo.ts",
      range: { start: 11, end: 13, side: "additions" },
    });
  });

  it("flags outdated without throwing when the first range's file is gone", () => {
    const gone = layer("gone", {
      ranges: [{ file: "src/gone.ts", side: "additions", startLine: 1, endLine: 1 }],
    });
    expect(resolveLayerScroll(gone, [gone], FILES, false)).toEqual({ kind: "outdated" });
  });

  it("flags outdated without throwing when no hunk covers the first range", () => {
    const drifted = layer("drifted", {
      ranges: [{ file: "src/foo.ts", side: "additions", startLine: 500, endLine: 500 }],
    });
    expect(resolveLayerScroll(drifted, [drifted], FILES, false)).toEqual({ kind: "outdated" });
  });

  it("places an off-hunk range against a frozen patch, never outdated", () => {
    // The same range a re-derived diff flags outdated (no hunk covers line 500)
    // places on its authored first line when the review pins its own patch —
    // the layer surface must agree with the comment surface under a frozen diff.
    const drifted = layer("drifted", {
      ranges: [{ file: "src/foo.ts", side: "additions", startLine: 500, endLine: 502 }],
    });
    expect(resolveLayerScroll(drifted, [drifted], FILES, true)).toEqual({
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
    expect(resolveLayerScroll(gone, [gone], FILES, true)).toEqual({ kind: "outdated" });
  });

  it("reports none only when the whole extent carries no range", () => {
    const bare = layer("empty", { ranges: [] });
    expect(resolveLayerScroll(bare, [bare], FILES, false)).toEqual({ kind: "none" });
    // A parent resolves through its extent, so a group whose sections place is placed.
    const child = layer("child", { parent: "empty" });
    expect(resolveLayerScroll(bare, [bare, child], FILES, false)).toEqual({
      kind: "placed",
      fileId: "src/foo.ts",
      range: { start: 11, end: 13, side: "additions" },
    });
  });
});
