import { describe, expect, it } from "vitest";
import { DIFF_ARGS, DIFF_CONFIG, committedDiffArgs, rangeDiffArgs, rangeSpec } from "./git-diff";

// The correctness pin. The app's git runner and the CLI's both build a review range's
// diff from these, so the *shape* of the argument vector is the contract: a two-dot range
// or a dropped `--` would produce a patch whose line numbers no longer match the anchors
// authored against it — coverage and anchor placement would drift in silence, which is the
// exact failure this module exists to prevent. Asserted here so a drift is a red test, not
// a wrong review.

describe("rangeSpec", () => {
  it("is three-dot, so a range is what head adds over the merge base", () => {
    expect(rangeSpec("main", "feature")).toBe("main...feature");
  });
});

describe("committedDiffArgs", () => {
  it("wraps the revs in the pinned config and flags, terminated by `--`", () => {
    expect(committedDiffArgs(["main...feature"])).toEqual([
      ...DIFF_CONFIG,
      ...DIFF_ARGS,
      "main...feature",
      "--",
    ]);
  });

  it("ends with `--` so a rev that looks like a path can never be read as one", () => {
    expect(committedDiffArgs(["main...feature"]).at(-1)).toBe("--");
  });
});

describe("rangeDiffArgs", () => {
  it("is the committed-diff vector over the three-dot range — one builder, both runners", () => {
    expect(rangeDiffArgs("main", "feature")).toEqual(
      committedDiffArgs([rangeSpec("main", "feature")]),
    );
  });
});
