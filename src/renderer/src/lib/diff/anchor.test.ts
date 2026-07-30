import { describe, expect, it } from "vitest";
import type { ReviewAnchor } from "../../../../shared/review";
import { resolveAnchor } from "./anchor";
import { TWO_HUNKS_PATCH } from "./fixtures";
import { parsePatch } from "./patch";

// A modification hunk covering new-file lines 10..14 (additions) and old-file
// lines 10..12 (deletions), so coverage can be probed on both sides.
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
  "",
].join("\n");

const fileDiff = parsePatch(PATCH, "test")[0]?.fileDiff ?? null;

// Two hunks over lines 1..6 and 27..33 of one file, with 7..26 collapsed between
// them — the geometry a single-hunk fixture cannot express.
const twoHunks = parsePatch(TWO_HUNKS_PATCH, "test")[0]?.fileDiff ?? null;

function anchor(overrides: Partial<ReviewAnchor> = {}): ReviewAnchor {
  return { file: "src/foo.ts", side: "additions", startLine: 11, endLine: 13, ...overrides };
}

function onTwoHunks(overrides: Partial<ReviewAnchor> = {}): ReviewAnchor {
  return { file: "src/two-hunks.txt", side: "additions", startLine: 5, endLine: 6, ...overrides };
}

describe("resolveAnchor", () => {
  it("places an addition-side range that sits inside a hunk", () => {
    expect(resolveAnchor(anchor(), { kind: "derived", file: fileDiff })).toEqual({
      status: "placed",
      line: 11,
    });
  });

  it("places a deletion-side range against the old-file hunk lines", () => {
    const onDeletions = anchor({ side: "deletions", startLine: 11, endLine: 11 });
    expect(resolveAnchor(onDeletions, { kind: "derived", file: fileDiff })).toEqual({
      status: "placed",
      line: 11,
    });
  });

  it("flags outdated when the file is absent from the re-derived diff", () => {
    const gone = anchor({ file: "src/gone.ts" });
    expect(resolveAnchor(gone, { kind: "derived", file: null })).toEqual({
      status: "outdated",
      anchor: gone,
    });
  });

  it("flags outdated when no same-side hunk covers the range", () => {
    const drifted = anchor({ startLine: 50, endLine: 50 });
    expect(resolveAnchor(drifted, { kind: "derived", file: fileDiff })).toEqual({
      status: "outdated",
      anchor: drifted,
    });
  });

  it("places a range covered by the second hunk of a multi-hunk file", () => {
    const inSecond = onTwoHunks({ startLine: 27, endLine: 29 });
    expect(resolveAnchor(inSecond, { kind: "derived", file: twoHunks })).toEqual({
      status: "placed",
      line: 27,
    });
  });

  it("flags outdated a range that spans two hunks, since neither covers it alone", () => {
    // The tail of hunk one (5..6) through the head of hunk two (27..28): the union
    // would "cover" it, but the 7..26 between them is collapsed context the reader
    // never saw. The authoring side is what must not produce this range
    // (`pickAddAnchor` clamps); the resolver's answer stays no.
    const across = onTwoHunks({ startLine: 5, endLine: 28 });
    expect(resolveAnchor(across, { kind: "derived", file: twoHunks })).toEqual({
      status: "outdated",
      anchor: across,
    });
  });

  it("flags outdated a range in the collapsed gap between two hunks", () => {
    const inGap = onTwoHunks({ startLine: 10, endLine: 12 });
    expect(resolveAnchor(inGap, { kind: "derived", file: twoHunks })).toEqual({
      status: "outdated",
      anchor: inGap,
    });
  });

  it("places every anchor against a frozen embedded patch, even ones a re-derive would flag", () => {
    const missingFile = anchor({ file: "src/gone.ts" });
    const drifted = anchor({ startLine: 50, endLine: 50 });
    for (const outdatable of [anchor(), missingFile, drifted]) {
      expect(resolveAnchor(outdatable, { kind: "frozen" })).toEqual({
        status: "placed",
        line: outdatable.startLine,
      });
    }
  });
});
