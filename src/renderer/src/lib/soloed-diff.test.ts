import { describe, expect, it, vi } from "vitest";
import type { ReviewLayer } from "../../../shared/review";
import { parsePatch, type PatchFile } from "../../../shared/diff/patch";

// The one thing this module promises beyond its parts is that it *is* its parts, computed
// once: the derivation has to be indistinguishable from `effectiveLayers` + `findLayer` +
// `soloFiles` called by hand, and the diff has to be walked once per input change however
// many surfaces ask. So the coverage core is counted here — the walk is the cost the
// three former call sites were each paying, and the count is the acceptance criterion.
const counter = vi.hoisted(() => ({ walks: 0 }));

vi.mock("../../../tools/review-coverage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../tools/review-coverage")>();
  return {
    ...actual,
    coverageOfFiles: (...args: Parameters<typeof actual.coverageOfFiles>) => {
      counter.walks += 1;
      return actual.coverageOfFiles(...args);
    },
  };
});

const { coverageSummary, effectiveLayers, UNCOVERED_LAYER_ID } = await import("./coverage");
const { findLayer, soloFiles } = await import("../../../shared/layers");
const { coverageFor, soloedDiff } = await import("./soloed-diff");

// Three files: foo and bar are walked by a layer, skipped by none — so the inferred
// "not covered by layers" layer exists and can be soloed like an authored one.
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
  "diff --git a/src/skipped.ts b/src/skipped.ts",
  "new file mode 100644",
  "index 0000000..5555555",
  "--- /dev/null",
  "+++ b/src/skipped.ts",
  "@@ -0,0 +1 @@",
  "+lonely",
  "",
].join("\n");

const FILES: PatchFile[] = parsePatch(PATCH, "test");

const FOO: ReviewLayer = {
  id: "foo",
  label: "foo",
  summary: "foo",
  ranges: [{ file: "src/foo.ts", side: "additions", startLine: 11, endLine: 13 }],
};
const BAR: ReviewLayer = {
  id: "bar",
  label: "bar",
  summary: "bar",
  ranges: [{ file: "src/bar.ts", side: "additions", startLine: 2, endLine: 3 }],
};
const LAYERS: ReviewLayer[] = [FOO, BAR];

/** What the surfaces used to compute for themselves, kept here as the reference the shared
 * derivation is checked against. */
function byHand(activeLayerId: string | null): {
  layers: ReviewLayer[];
  activeLayer: ReviewLayer | null;
  files: PatchFile[];
} {
  const layers = effectiveLayers(FILES, LAYERS);
  const activeLayer = findLayer(layers, activeLayerId);
  return { layers, activeLayer, files: soloFiles(FILES, activeLayer, layers) };
}

describe("soloedDiff", () => {
  it("matches the derivation it replaces, for every kind of active id", () => {
    for (const id of [null, "foo", UNCOVERED_LAYER_ID, "no-such-layer"]) {
      expect(soloedDiff(FILES, LAYERS, id)).toEqual(byHand(id));
    }
  });

  it("solos the inferred layer to exactly the files no layer walks", () => {
    const soloed = soloedDiff(FILES, LAYERS, UNCOVERED_LAYER_ID);
    expect(soloed.activeLayer?.id).toBe(UNCOVERED_LAYER_ID);
    expect(soloed.files.map((file) => file.path)).toEqual(["src/skipped.ts"]);
    // An unknown id is not a solo: the full diff, as if nothing were active.
    expect(soloedDiff(FILES, LAYERS, "no-such-layer").files).toHaveLength(FILES.length);
  });

  it("walks the diff once per (files, layers) pair, however many solos are asked for", () => {
    // A fresh pair, so this test owns its cache entry no matter what ran before it.
    const layers = [FOO];
    counter.walks = 0;
    soloedDiff(FILES, layers, null);
    expect(counter.walks).toBe(1);
    // Every other consumer of the same pair — the rail, the code view, the store's
    // navigation, the coverage header — rides that one walk.
    soloedDiff(FILES, layers, null);
    soloedDiff(FILES, layers, "foo");
    soloedDiff(FILES, layers, UNCOVERED_LAYER_ID);
    coverageFor(FILES, layers);
    expect(counter.walks).toBe(1);
  });

  it("re-derives when either input changes identity", () => {
    const layers = [BAR];
    counter.walks = 0;
    soloedDiff(FILES, layers, null);
    // Same contents, new array: a new load or a re-import, and the old derivation cannot be
    // assumed to still describe it.
    soloedDiff(FILES, [...layers], null);
    soloedDiff([...FILES], layers, null);
    expect(counter.walks).toBe(3);
  });

  it("holds one identity per (files, layers, activeLayerId), so consumers' memos hold", () => {
    const first = soloedDiff(FILES, LAYERS, "foo");
    const again = soloedDiff(FILES, LAYERS, "foo");
    expect(again).toBe(first);
    // The file subset especially: a fresh array here is what used to invalidate the file
    // tree's `visibleFiles` and `tally` memos on every unrelated re-render.
    expect(again.files).toBe(first.files);
    expect(again.layers).toBe(first.layers);
    expect(soloedDiff(FILES, LAYERS, "bar").files).not.toBe(first.files);
    // The effective layer list does not depend on the solo, so it stays one object.
    expect(soloedDiff(FILES, LAYERS, "bar").layers).toBe(first.layers);
  });
});

describe("coverageFor", () => {
  it("is `coverageSummary`, shared", () => {
    expect(coverageFor(FILES, LAYERS)).toEqual(coverageSummary(FILES, LAYERS));
    // And the layer list is built from that same report, not a second one.
    expect(soloedDiff(FILES, LAYERS, null).layers.at(-1)).toBe(
      coverageFor(FILES, LAYERS).uncoveredLayer,
    );
  });
});
