import { describe, expect, it } from "vitest";
import type { CoverageReport } from "../src/tools/review-coverage";
import { emitCoverageLines } from "./coverage-report";

// The emit-time coverage lines are pure, so they are tested here on a hand-built report rather
// than through a spawned `rvw emit` (`emit.test.ts` covers that path end to end).

/** A report in which `file` has changed lines and no layer touches any of them. */
function untouched(file: string): CoverageReport {
  return {
    headline: { coverableChangedLines: 2, coveredChangedLines: 0 },
    files: [{ file, status: "uncovered", coverableChangedLines: 2, coveredChangedLines: 0 }],
    uncoveredSpans: [{ file, side: "additions", startLine: 1, endLine: 2 }],
  };
}

describe("emitCoverageLines", () => {
  it("offers a whole-file range an author can paste, escaped as JSON whatever the path holds", () => {
    // A path with a quote and a backslash: interpolated between quotes it printed a range that
    // does not parse, and the line exists to be pasted into the draft.
    const path = 'docs/say "hi"\\now.md';
    const lines = emitCoverageLines(untouched(path));
    const offered = lines[1] ?? "";
    expect(offered).toContain(`{ "file": ${JSON.stringify(path)} }`);

    const range = /\{ "file": .* \}/u.exec(offered)?.[0] ?? "";
    expect(JSON.parse(range)).toEqual({ file: path });
  });
});
