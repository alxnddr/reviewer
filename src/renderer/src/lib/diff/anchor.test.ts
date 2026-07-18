import { describe, expect, it } from "vitest";
import type { ReviewAnchor } from "../../../../shared/review";
import { resolveAnchor } from "./anchor";
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

function anchor(overrides: Partial<ReviewAnchor> = {}): ReviewAnchor {
  return { file: "src/foo.ts", side: "additions", startLine: 11, endLine: 13, ...overrides };
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
