import { describe, expect, it } from "vitest";
import {
  buildMovedLinesPatch,
  IN_FILE_MOVE_PATCH,
  MOVED_BLOCK_PATCH,
  MULTI_STATUS_PATCH,
  NEAR_MISS_MOVE_PATCH,
  TWO_FILE_PATCH,
} from "./fixtures";
import { detectMovedBlocks, type MovedBlock } from "./moved";
import { ANALYSIS_CACHE_KEY, parsePatch } from "./patch";

// Move detection is a claim about a real patch, so every case here is one: the fixtures are
// git output, parsed by the same `parsePatch` the app and the CLI use, and the assertions name
// the line numbers a reader would see in the diff. The four that matter are the move it must
// find, the two coincidences it must refuse (a shared preamble, a two-line tail), the
// reformat-in-place it must not call a move, and the cost.

function detect(patch: string): MovedBlock[] {
  return detectMovedBlocks(parsePatch(patch, ANALYSIS_CACHE_KEY));
}

/** `from → to (n)` — the whole of a block in one readable string. */
function summarize(blocks: readonly MovedBlock[]): string[] {
  return blocks.map(
    (block) =>
      `${block.from.file}:${block.from.startLine}-${block.from.endLine} → ` +
      `${block.to.file}:${block.to.startLine}-${block.to.endLine} (${block.lines})`,
  );
}

describe("detectMovedBlocks", () => {
  it("finds a function moved between files, re-indented on the way", () => {
    expect(summarize(detect(MOVED_BLOCK_PATCH))).toEqual([
      "src/moved-from.ts:3-10 → src/moved-to.ts:3-10 (8)",
    ]);
  });

  it("gives both ends as anchors, one per side", () => {
    const block = detect(MOVED_BLOCK_PATCH)[0];
    expect(block?.from).toEqual({
      file: "src/moved-from.ts",
      side: "deletions",
      startLine: 3,
      endLine: 10,
    });
    expect(block?.to).toEqual({
      file: "src/moved-to.ts",
      side: "additions",
      startLine: 3,
      endLine: 10,
    });
  });

  it("finds a move within one file and ignores a reformat in place", () => {
    // `src/reindented.ts` matches itself line for line at 2..4 on both sides; only
    // `src/reorder.ts`, where the block really travelled past its neighbour, survives.
    expect(summarize(detect(IN_FILE_MOVE_PATCH))).toEqual([
      "src/reorder.ts:1-4 → src/reorder.ts:5-8 (4)",
    ]);
  });

  it("refuses a shared preamble and a two-line tail", () => {
    expect(detect(NEAR_MISS_MOVE_PATCH)).toEqual([]);
  });

  it("finds nothing in a diff whose deletion runs are all too short", () => {
    expect(detect(MULTI_STATUS_PATCH)).toEqual([]);
    expect(detect(TWO_FILE_PATCH)).toEqual([]);
  });

  it("finds nothing in an empty or unparseable patch", () => {
    expect(detectMovedBlocks([])).toEqual([]);
    expect(detect("")).toEqual([]);
  });

  it("claims every line at most once", () => {
    // File N adds exactly what file N-1 deleted, so every added line is part of a move and
    // every block must be the whole 6-line run — no line left over to seed a second block.
    const blocks = detect(buildMovedLinesPatch(4, 6));
    expect(blocks).toHaveLength(4);
    expect(blocks.every((block) => block.lines === 6)).toBe(true);
    expect(summarize(blocks)[0]).toBe("src/moved-003.ts:1-6 → src/moved-000.ts:1-6 (6)");
  });

  it("is ordered the way the destination reads", () => {
    const blocks = detect(buildMovedLinesPatch(4, 6));
    expect(blocks.map((block) => block.to.file)).toEqual([
      "src/moved-000.ts",
      "src/moved-001.ts",
      "src/moved-002.ts",
      "src/moved-003.ts",
    ]);
  });

  // The cost criterion from the task, discharged by running it rather than by reasoning about
  // it: 400 files, 24,000 deleted lines and 24,000 added lines, all of them moves — the shape
  // that makes every seed find a candidate and every candidate extend the full run, and an
  // order of magnitude larger than any review this app opens. Measured at ~40 ms here. The
  // number is not asserted, because that would be asserting the machine; vitest's default 5 s
  // timeout is the regression guard, which a quadratic rewrite of the inner loop would blow
  // through by a wide margin.
  it("detects a 48,000-line diff of pure moves without a quadratic blow-up", () => {
    const blocks = detect(buildMovedLinesPatch(400, 60));
    expect(blocks).toHaveLength(400);
    expect(blocks.every((block) => block.lines === 60)).toBe(true);
  });
});
