import { describe, expect, it } from "vitest";
import type { ReviewAnchor } from "../review";
import { resolveAnchor } from "./anchor";
import { ONE_HUNK_PATCH, TWO_HUNKS_PATCH } from "./fixtures";
import { parsePatch } from "./patch";

// A modification hunk spanning new-file lines 8..16 (additions) and old-file lines
// 8..14 (deletions), so coverage can be probed on both sides.
const fileDiff = parsePatch(ONE_HUNK_PATCH, "test")[0]?.fileDiff ?? null;

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

  it("reads the span of the anchor's own side, not whichever side's is wider", () => {
    // The hunk claims new-file 8..16 against old-file 8..14 — three additions for one
    // deletion make the new side two lines longer — so 15..16 is additions-only ground: one
    // range, placed on one side and outdated on the other. Every other case here sits where
    // the two spans overlap, so without this pair a `coversRange` that read a fixed side
    // rather than `anchor.side` would pass the whole suite.
    const onAdditions = anchor({ startLine: 15, endLine: 16 });
    const onDeletions = anchor({ startLine: 15, endLine: 16, side: "deletions" });
    expect(resolveAnchor(onAdditions, { kind: "derived", file: fileDiff })).toEqual({
      status: "placed",
      line: 15,
    });
    expect(resolveAnchor(onDeletions, { kind: "derived", file: fileDiff })).toEqual({
      status: "outdated",
      anchor: onDeletions,
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
