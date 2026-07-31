import { describe, expect, it } from "vitest";
import { MULTI_STATUS_PATCH } from "../../../../shared/diff/fixtures";
import { parsePatch } from "../../../../shared/diff/patch";
import { buildSearchIndex, findMatches, partialSignature } from "./search";

const files = parsePatch(MULTI_STATUS_PATCH, "search-test");

/** `text` plus its precomputed lowercase form, for `toEqual` against a real index entry. */
function line(fileId: string, side: "additions" | "deletions", lineNumber: number, text: string) {
  return { fileId, side, lineNumber, text, lowerText: text.toLowerCase() };
}

describe("buildSearchIndex", () => {
  it("addresses each hunk line by file, side, and 1-based number", () => {
    const index = buildSearchIndex(files);
    // greet.ts: @@ -1,3 +1,7 @@ — one context line, then a change (1 deletion,
    // 5 additions), then a trailing context line. Numbering walks from 1 on both
    // sides; deletions render before additions within the change block.
    const greet = index.filter((entry) => entry.fileId === "greet.ts");
    expect(greet).toEqual([
      line("greet.ts", "additions", 1, "export function greet(name: string): string {"),
      line("greet.ts", "deletions", 2, "  return `hello ${name}`;"),
      line("greet.ts", "additions", 2, "  return `hi ${name}`;"),
      line("greet.ts", "additions", 3, "}"),
      line("greet.ts", "additions", 4, ""),
      line("greet.ts", "additions", 5, "export function shout(name: string): string {"),
      line("greet.ts", "additions", 6, "  return greet(name).toUpperCase();"),
      line("greet.ts", "additions", 7, "}"),
    ]);
  });

  it("strips the trailing newline the parser keeps on each line", () => {
    const index = buildSearchIndex(files);
    expect(index.every((entry) => !entry.text.includes("\n"))).toBe(true);
  });

  it("precomputes lowerText as the lowercase of text", () => {
    const index = buildSearchIndex(files);
    expect(index.length).toBeGreaterThan(0);
    expect(index.every((entry) => entry.lowerText === entry.text.toLowerCase())).toBe(true);
  });

  it("gives binary changes and pure renames no searchable lines", () => {
    const index = buildSearchIndex(files);
    expect(index.some((entry) => entry.fileId === "img.png")).toBe(false);
    expect(index.some((entry) => entry.fileId === "newname.txt")).toBe(false);
  });

  it("numbers a deletion hunk from its old-file start", () => {
    const index = buildSearchIndex(files);
    // doomed.txt: @@ -1,2 +0,0 @@ — two deletions, no additions.
    expect(index.filter((entry) => entry.fileId === "doomed.txt")).toEqual([
      line("doomed.txt", "deletions", 1, "to be deleted"),
      line("doomed.txt", "deletions", 2, "line2"),
    ]);
  });
});

describe("partialSignature", () => {
  it("is stable for the same files and changes when a file's isPartial flag flips", () => {
    const before = partialSignature(files);
    expect(partialSignature(files)).toBe(before);

    const flipped = files.map((file, i) =>
      i === 0
        ? { ...file, fileDiff: { ...file.fileDiff, isPartial: !file.fileDiff.isPartial } }
        : file,
    );
    expect(partialSignature(flipped)).not.toBe(before);
  });
});

describe("findMatches", () => {
  const index = buildSearchIndex(files);

  it("returns nothing for an empty query", () => {
    expect(findMatches(index, { text: "", caseSensitive: false })).toEqual([]);
  });

  it("is case-insensitive by default", () => {
    const matches = findMatches(index, { text: "GREET", caseSensitive: false });
    expect(matches).toContainEqual({ fileId: "greet.ts", side: "additions", lineNumber: 1 });
    expect(matches).toContainEqual({ fileId: "greet.ts", side: "additions", lineNumber: 6 });
  });

  it("honors the case-sensitive flag", () => {
    // notes.txt turns `b` into `B`: only the deletion carries a lowercase b.
    const lower = findMatches(index, { text: "b", caseSensitive: true }).filter(
      (match) => match.fileId === "notes.txt",
    );
    expect(lower).toEqual([{ fileId: "notes.txt", side: "deletions", lineNumber: 2 }]);
    const upper = findMatches(index, { text: "B", caseSensitive: true }).filter(
      (match) => match.fileId === "notes.txt",
    );
    expect(upper).toEqual([{ fileId: "notes.txt", side: "additions", lineNumber: 2 }]);
  });

  it("counts a line once even when it contains the query twice", () => {
    // `name` appears three times on greet.ts new line 1, but the line is one result.
    const matches = findMatches(index, { text: "name", caseSensitive: false });
    const line1 = matches.filter(
      (match) =>
        match.fileId === "greet.ts" && match.lineNumber === 1 && match.side === "additions",
    );
    expect(line1).toHaveLength(1);
  });

  it("preserves top-to-bottom, cross-file order", () => {
    const matches = findMatches(index, { text: "e", caseSensitive: false });
    const fileOrder = matches.map((match) => match.fileId);
    // Files appear in patch order and never interleave.
    expect(fileOrder).toEqual([...fileOrder].toSorted(stableByFirstAppearance(fileOrder)));
  });
});

/** A comparator that keeps ids in their first-seen order — asserts the match list
 * groups each file's hits contiguously in patch order rather than shuffling them. */
function stableByFirstAppearance(order: readonly string[]): (a: string, b: string) => number {
  const firstIndex = new Map<string, number>();
  order.forEach((id, index) => {
    if (!firstIndex.has(id)) {
      firstIndex.set(id, index);
    }
  });
  return (a, b) => (firstIndex.get(a) ?? 0) - (firstIndex.get(b) ?? 0);
}
