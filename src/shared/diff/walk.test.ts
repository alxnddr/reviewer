import { describe, expect, it } from "vitest";
import {
  buildHugeAdditionPatch,
  buildManyFilesPatch,
  buildPathsPatch,
  MULTI_STATUS_PATCH,
  ONE_HUNK_PATCH,
  QUOTED_BINARY_RENAME_PATCH,
  RENAMES_PATCH,
  RENAME_WITH_EDIT_PATCH,
  SPACED_NAME_PATCH,
  TWO_HUNKS_PATCH,
} from "./fixtures";
import { parsePatch, type PatchFile } from "./patch";
import { hunkSpan, walkFileLines, type WalkedLine } from "./walk";

// The one walk every line-addressed surface reads (search index, snippet preview, coverage
// universe), so its emission order and its coordinates are pinned here rather than three
// times over. The load-bearing test is the last one: that the walk and `hunkSpan` — the two
// models of the same geometry — tile identically on every fixture the parser handles.

const files = parsePatch(ONE_HUNK_PATCH, "walk-test");
const fileDiff = files[0]!.fileDiff;

function walked(file: PatchFile["fileDiff"]): WalkedLine[] {
  const lines: WalkedLine[] = [];
  walkFileLines(file, (line) => {
    lines.push(line);
  });
  return lines;
}

/** `kind:side:lineNumber` per emitted line — the readable form for order assertions that do
 * not care about which array slot the text came from. */
function trace(file: PatchFile["fileDiff"]): string[] {
  return walked(file).map((line) => `${line.kind}:${line.side}:${line.lineNumber}`);
}

function fileNamed(patch: string, name: string, cacheKey: string): PatchFile {
  const file = parsePatch(patch, cacheKey).find((candidate) => candidate.path === name);
  if (file === undefined) {
    throw new Error(`fixture has no file ${name}`);
  }
  return file;
}

describe("walkFileLines", () => {
  it("numbers each side from its own hunk header and indexes into that side's lines", () => {
    // ONE_HUNK_PATCH: `@@ -8,7 +8,9 @@` — three context lines, a change (one deletion, three
    // additions), three more context lines. A context line is emitted on both sides, in each
    // side's own coordinates; a change block emits its deletions before its additions.
    expect(walked(fileDiff)).toEqual([
      { side: "deletions", kind: "context", lineNumber: 8, index: 0 },
      { side: "deletions", kind: "context", lineNumber: 9, index: 1 },
      { side: "deletions", kind: "context", lineNumber: 10, index: 2 },
      { side: "additions", kind: "context", lineNumber: 8, index: 0 },
      { side: "additions", kind: "context", lineNumber: 9, index: 1 },
      { side: "additions", kind: "context", lineNumber: 10, index: 2 },
      { side: "deletions", kind: "deletion", lineNumber: 11, index: 3 },
      { side: "additions", kind: "addition", lineNumber: 11, index: 3 },
      { side: "additions", kind: "addition", lineNumber: 12, index: 4 },
      { side: "additions", kind: "addition", lineNumber: 13, index: 5 },
      { side: "deletions", kind: "context", lineNumber: 12, index: 4 },
      { side: "deletions", kind: "context", lineNumber: 13, index: 5 },
      { side: "deletions", kind: "context", lineNumber: 14, index: 6 },
      { side: "additions", kind: "context", lineNumber: 14, index: 6 },
      { side: "additions", kind: "context", lineNumber: 15, index: 7 },
      { side: "additions", kind: "context", lineNumber: 16, index: 8 },
    ]);
  });

  it("reads each line's text at the index it carries, on the side it carries", () => {
    const texts = walked(fileDiff).map(
      (line) =>
        (line.side === "additions" ? fileDiff.additionLines : fileDiff.deletionLines)[line.index],
    );
    expect(texts).toEqual([
      "ctx8\n",
      "ctx9\n",
      "ctx10\n",
      "ctx8\n",
      "ctx9\n",
      "ctx10\n",
      "old11\n",
      "new11\n",
      "new12\n",
      "new13\n",
      "ctx12\n",
      "ctx13\n",
      "ctx14\n",
      "ctx12\n",
      "ctx13\n",
      "ctx14\n",
    ]);
  });

  it("walks a one-sided file on that side alone", () => {
    // doomed.txt is `@@ -1,2 +0,0 @@` — two deletions and no new-file side at all.
    const deleted = fileNamed(MULTI_STATUS_PATCH, "doomed.txt", "walk-deleted");
    expect(trace(deleted.fileDiff)).toEqual(["deletion:deletions:1", "deletion:deletions:2"]);
    const added = fileNamed(MULTI_STATUS_PATCH, "added.txt", "walk-added");
    expect(trace(added.fileDiff)).toEqual(["addition:additions:1", "addition:additions:2"]);
  });

  it("walks hunk after hunk, each from its own header", () => {
    const twoHunks = parsePatch(TWO_HUNKS_PATCH, "walk-two")[0]!;
    const additions = walked(twoHunks.fileDiff).filter((line) => line.side === "additions");
    // Lines 7..26 are collapsed between the hunks and belong to neither, so the walk jumps.
    expect(additions.map((line) => line.lineNumber)).toEqual([
      1, 2, 3, 4, 5, 6, 27, 28, 29, 30, 31, 32, 33,
    ]);
  });

  it("walks nothing for a file that carries no hunks", () => {
    // A binary change and a pure rename are both zero-hunk, which is why neither reaches a
    // search index, a preview or the coverage universe.
    expect(trace(fileNamed(MULTI_STATUS_PATCH, "img.png", "walk-binary").fileDiff)).toEqual([]);
    expect(trace(fileNamed(MULTI_STATUS_PATCH, "newname.txt", "walk-rename").fileDiff)).toEqual([]);
  });

  it("stops the whole walk the moment the visitor returns false, later hunks included", () => {
    // Walked on the two-hunk fixture on purpose: "the whole walk" is the part of the
    // contract a single-hunk file cannot witness at all.
    const twoHunks = parsePatch(TWO_HUNKS_PATCH, "walk-stop")[0]!;
    const seen: number[] = [];
    walkFileLines(twoHunks.fileDiff, (line) => {
      seen.push(line.lineNumber);
      return line.lineNumber < 5;
    });
    // Deletions-side line 5 answered false, two lines into the trailing context run of the
    // first hunk. Nothing after it is visited: not the rest of that run, not the additions
    // copy of that same context, and not the second hunk (27..33) at all — the stop leaves
    // the hunk it was raised in rather than merely ending it.
    expect(seen).toEqual([1, 2, 1, 2, 3, 3, 4, 5]);
  });

  it("keeps walking for a visitor that returns nothing", () => {
    let count = 0;
    walkFileLines(fileDiff, () => {
      count += 1;
    });
    expect(count).toBe(16);
  });
});

describe("hunkSpan", () => {
  it("reads the header's inclusive span on each side", () => {
    const hunk = fileDiff.hunks[0]!;
    expect(hunkSpan(hunk, "additions")).toEqual({ start: 8, end: 16 });
    expect(hunkSpan(hunk, "deletions")).toEqual({ start: 8, end: 14 });
  });

  it("yields an empty span for a side the hunk does not touch", () => {
    // `@@ -1,2 +0,0 @@`: the additions side has count 0, so `end` lands below `start` and
    // nothing is inside it — which is how an addition anchor fails to land on a deletion.
    const deleted = fileNamed(MULTI_STATUS_PATCH, "doomed.txt", "span-deleted");
    const span = hunkSpan(deleted.fileDiff.hunks[0]!, "additions");
    expect(span.end).toBeLessThan(span.start);
  });
});

describe("the two models of the same geometry", () => {
  const PATCHES: Record<string, string> = {
    MULTI_STATUS_PATCH,
    RENAME_WITH_EDIT_PATCH,
    QUOTED_BINARY_RENAME_PATCH,
    RENAMES_PATCH,
    ONE_HUNK_PATCH,
    TWO_HUNKS_PATCH,
    SPACED_NAME_PATCH,
    MANY_FILES: buildManyFilesPatch(3, 4),
    PATHS: buildPathsPatch(["a.ts", "src/deep/b.ts"], 2),
    HUGE_ADDITION: buildHugeAdditionPatch(200),
  };
  // Every patch `fixtures.ts` exports, so "the two models agree" is a claim about the whole
  // corpus the parser is proven on rather than about a hand-picked subset of it.

  it("walks exactly the lines each hunk header claims, on both sides, in every fixture", () => {
    // The invariant that lets `coversRange` keep asking the header while everything else
    // reads the walk: for a hunk git wrote, a side's context lines plus its own changed lines
    // sum to that side's header count, so the walked numbers tile `[start, end]` with no gap
    // and nothing over.
    for (const [name, patch] of Object.entries(PATCHES)) {
      for (const file of parsePatch(patch, `tile:${name}`)) {
        for (const [index, hunk] of file.fileDiff.hunks.entries()) {
          // The walk takes a whole file, so one hunk at a time is one file's worth of it.
          const oneHunk = { ...file.fileDiff, hunks: [hunk] };
          for (const side of ["additions", "deletions"] as const) {
            const span = hunkSpan(hunk, side);
            const expected = Array.from(
              { length: Math.max(span.end - span.start + 1, 0) },
              (_unused, offset) => span.start + offset,
            );
            const lines = walked(oneHunk)
              .filter((line) => line.side === side)
              .map((line) => line.lineNumber);
            expect(lines, `${name} ${file.path} hunk ${index} ${side}`).toEqual(expected);
          }
        }
      }
    }
  });

  it("parts with the header only when the header lies about its body", () => {
    // A hand-written patch claiming nine lines a side and carrying three. An embedded artifact
    // patch can be any bytes, so the divergence is real — and deliberate: the walk names the
    // lines that exist, while the span keeps answering for the geometry stored anchors were
    // resolved against.
    const lying = [
      "diff --git a/src/lie.ts b/src/lie.ts",
      "index 1111111..2222222 100644",
      "--- a/src/lie.ts",
      "+++ b/src/lie.ts",
      "@@ -10,9 +10,9 @@",
      " ctx10",
      "-old11",
      "+new11",
      " ctx12",
      "",
    ].join("\n");
    const file = parsePatch(lying, "walk-lying")[0]!;
    const additions = walked(file.fileDiff)
      .filter((line) => line.side === "additions")
      .map((line) => line.lineNumber);
    expect(additions).toEqual([10, 11, 12]);
    expect(hunkSpan(file.fileDiff.hunks[0]!, "additions")).toEqual({ start: 10, end: 18 });
  });
});
