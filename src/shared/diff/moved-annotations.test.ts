import { describe, expect, it } from "vitest";
import type { Comment } from "../review";
import { buildDiffItems, type CommentUiState } from "./comment-annotations";
import { IN_FILE_MOVE_PATCH, MOVED_BLOCK_PATCH } from "./fixtures";
import { detectMovedBlocks, type MovedBlock } from "./moved";
import { movedAnnotationsByFile, movedSlotKey, type MovedSlot } from "./moved-annotations";
import { ANALYSIS_CACHE_KEY, parsePatch } from "./patch";

// The three decisions in `moved-annotations.ts` are the three things worth pinning: both ends
// are annotated, an end whose partner is off screen draws nothing, and a moved note precedes
// a comment that shares its line. Everything is driven off real detection over a real patch
// rather than hand-built blocks, so a change to either half shows up here.

const NO_UI: CommentUiState = { editingId: null, draft: null };

const FILES = parsePatch(MOVED_BLOCK_PATCH, ANALYSIS_CACHE_KEY);
const BLOCKS = detectMovedBlocks(FILES);
const DRAWN = new Set(FILES.map((file) => file.path));

/** Every annotation as `path side:line → other (n)`, which is the whole of one note. */
function summarize(
  byFile: ReadonlyMap<string, { side: string; lineNumber: number; metadata: MovedSlot }[]>,
): string[] {
  return [...byFile].flatMap(([path, annotations]) =>
    annotations.map((annotation) => {
      const { other, lines, end } = annotation.metadata;
      return (
        `${path} ${annotation.side}:${annotation.lineNumber} ` +
        `${end} ${other.file}:${other.startLine}-${other.endLine} (${lines})`
      );
    }),
  );
}

describe("movedAnnotationsByFile", () => {
  it("annotates both ends, each on the block's first line, naming the other", () => {
    expect(summarize(movedAnnotationsByFile(BLOCKS, DRAWN))).toEqual([
      "src/moved-to.ts additions:3 to src/moved-from.ts:3-10 (8)",
      "src/moved-from.ts deletions:3 from src/moved-to.ts:3-10 (8)",
    ]);
  });

  it("draws neither end when one of them is not on screen", () => {
    // What a soloed chapter does to a move that left it: the note would be a link to a file
    // the surface is not rendering, so the pair is dropped rather than half-shown.
    expect(movedAnnotationsByFile(BLOCKS, new Set(["src/moved-to.ts"])).size).toBe(0);
  });

  it("keeps both ends of a move inside one file", () => {
    const inFile = parsePatch(IN_FILE_MOVE_PATCH, ANALYSIS_CACHE_KEY);
    const annotations = movedAnnotationsByFile(
      detectMovedBlocks(inFile),
      new Set(inFile.map((file) => file.path)),
    );
    expect(summarize(annotations)).toEqual([
      "src/reorder.ts additions:5 to src/reorder.ts:1-4 (4)",
      "src/reorder.ts deletions:1 from src/reorder.ts:5-8 (4)",
    ]);
  });

  it("changes its version key when the other end moves", () => {
    const [annotation] = movedAnnotationsByFile(BLOCKS, DRAWN).get("src/moved-to.ts") ?? [];
    expect(annotation).toBeDefined();
    const elsewhere = {
      ...annotation!,
      metadata: { ...annotation!.metadata, other: { ...annotation!.metadata.other, startLine: 9 } },
    };
    expect(movedSlotKey(elsewhere)).not.toBe(movedSlotKey(annotation!));
  });
});

describe("buildDiffItems with moved blocks", () => {
  function comment(overrides: Partial<Comment> = {}): Comment {
    return {
      id: "c1",
      file: "src/moved-to.ts",
      side: "additions",
      startLine: 3,
      endLine: 3,
      body: "why here?",
      ...overrides,
    };
  }

  it("puts a moved note above a comment that shares its line", () => {
    const items = buildDiffItems(
      FILES,
      [comment()],
      NO_UI,
      false,
      null,
      "unified",
      undefined,
      undefined,
      BLOCKS,
    );
    const annotations = items.find((item) => item.id === "src/moved-to.ts")?.annotations ?? [];
    expect(annotations.map((annotation) => annotation.metadata.kind)).toEqual(["moved", "comment"]);
    expect(annotations.every((annotation) => annotation.lineNumber === 3)).toBe(true);
  });

  it("draws no note at all without blocks, and repaints the item when they arrive", () => {
    const without = buildDiffItems(FILES, [], NO_UI, false);
    const annotated = buildDiffItems(
      FILES,
      [],
      NO_UI,
      false,
      null,
      "unified",
      undefined,
      undefined,
      BLOCKS,
    );
    const bare = without.find((item) => item.id === "src/moved-to.ts");
    const noted = annotated.find((item) => item.id === "src/moved-to.ts");
    expect(bare?.annotations).toEqual([]);
    expect(noted?.annotations).toHaveLength(1);
    // The version is what CodeView reconciles on: without this the surface would keep the
    // item it already drew and the note would never appear.
    expect(noted?.version).not.toBe(bare?.version);
  });

  it("leaves the moved lines ordinary additions and deletions", () => {
    // The acceptance criterion the detection half was built around, re-checked from the
    // render side: annotating a block changes nothing about the file it annotates.
    const items = buildDiffItems(
      FILES,
      [],
      NO_UI,
      false,
      null,
      "unified",
      undefined,
      undefined,
      BLOCKS,
    );
    const plain = buildDiffItems(FILES, [], NO_UI, false);
    for (const [index, item] of items.entries()) {
      expect(item.fileDiff).toBe(plain[index]?.fileDiff);
    }
  });
});

/** A block that names a file no diff carries — the shape a stale detection would produce. */
const STRANGER: MovedBlock = {
  from: { file: "src/gone.ts", side: "deletions", startLine: 1, endLine: 3 },
  to: { file: "src/moved-to.ts", side: "additions", startLine: 3, endLine: 5 },
  lines: 3,
};

describe("a block naming a file the surface does not draw", () => {
  it("contributes nothing to either file", () => {
    expect(movedAnnotationsByFile([STRANGER], DRAWN).size).toBe(0);
  });
});
