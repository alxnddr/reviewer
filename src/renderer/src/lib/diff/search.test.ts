import { describe, expect, it } from "vitest";
import { MULTI_STATUS_PATCH } from "./fixtures";
import { parsePatch } from "./patch";
import { buildSearchIndex, findMatches } from "./search";

const files = parsePatch(MULTI_STATUS_PATCH, "search-test");

describe("buildSearchIndex", () => {
  it("addresses each hunk line by file, side, and 1-based number", () => {
    const index = buildSearchIndex(files);
    // greet.ts: @@ -1,3 +1,7 @@ — one context line, then a change (1 deletion,
    // 5 additions), then a trailing context line. Numbering walks from 1 on both
    // sides; deletions render before additions within the change block.
    const greet = index.filter((line) => line.fileId === "greet.ts");
    expect(greet).toEqual([
      {
        fileId: "greet.ts",
        side: "additions",
        lineNumber: 1,
        text: "export function greet(name: string): string {",
      },
      { fileId: "greet.ts", side: "deletions", lineNumber: 2, text: "  return `hello ${name}`;" },
      { fileId: "greet.ts", side: "additions", lineNumber: 2, text: "  return `hi ${name}`;" },
      { fileId: "greet.ts", side: "additions", lineNumber: 3, text: "}" },
      { fileId: "greet.ts", side: "additions", lineNumber: 4, text: "" },
      {
        fileId: "greet.ts",
        side: "additions",
        lineNumber: 5,
        text: "export function shout(name: string): string {",
      },
      {
        fileId: "greet.ts",
        side: "additions",
        lineNumber: 6,
        text: "  return greet(name).toUpperCase();",
      },
      { fileId: "greet.ts", side: "additions", lineNumber: 7, text: "}" },
    ]);
  });

  it("strips the trailing newline the parser keeps on each line", () => {
    const index = buildSearchIndex(files);
    expect(index.every((line) => !line.text.includes("\n"))).toBe(true);
  });

  it("gives binary changes and pure renames no searchable lines", () => {
    const index = buildSearchIndex(files);
    expect(index.some((line) => line.fileId === "img.png")).toBe(false);
    expect(index.some((line) => line.fileId === "newname.txt")).toBe(false);
  });

  it("numbers a deletion hunk from its old-file start", () => {
    const index = buildSearchIndex(files);
    // doomed.txt: @@ -1,2 +0,0 @@ — two deletions, no additions.
    expect(index.filter((line) => line.fileId === "doomed.txt")).toEqual([
      { fileId: "doomed.txt", side: "deletions", lineNumber: 1, text: "to be deleted" },
      { fileId: "doomed.txt", side: "deletions", lineNumber: 2, text: "line2" },
    ]);
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
    expect(fileOrder).toEqual([...fileOrder].sort(stableByFirstAppearance(fileOrder)));
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
