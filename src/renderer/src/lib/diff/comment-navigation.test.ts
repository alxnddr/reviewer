import { describe, expect, it } from "vitest";
import type { Comment } from "../../../../shared/review";
import {
  commentCountsByFile,
  indexOfComment,
  navigableEntries,
  orderedComments,
} from "./comment-navigation";
import { parsePatch } from "./patch";

// Two files, each with one modification hunk. foo covers additions 10..14; bar
// covers additions 20..22 — so a comment can be placed, drifted off the end
// (outdated), or aimed at a file absent from this pair (unplaceable).
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
  "diff --git a/src/bar.ts b/src/bar.ts",
  "index 3333333..4444444 100644",
  "--- a/src/bar.ts",
  "+++ b/src/bar.ts",
  "@@ -20,1 +20,3 @@",
  " ctx20",
  "+new21",
  "+new22",
  "",
].join("\n");

const FILES = parsePatch(PATCH, "test");

let seq = 0;
function comment(overrides: Partial<Comment> = {}): Comment {
  seq += 1;
  const hex = seq.toString(16).padStart(12, "0");
  return {
    file: "src/foo.ts",
    side: "additions",
    startLine: 11,
    endLine: 11,
    body: "look here",
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${hex}`,
    ...overrides,
  };
}

describe("orderedComments", () => {
  it("orders placeable comments by the file's diff order, then by resolved line", () => {
    const barLater = comment({ file: "src/bar.ts", startLine: 22, endLine: 22 });
    const barEarly = comment({ file: "src/bar.ts", startLine: 20, endLine: 20 });
    const foo = comment({ file: "src/foo.ts", startLine: 12, endLine: 12 });
    const ordered = orderedComments(FILES, [barLater, foo, barEarly], false);
    expect(ordered.map((entry) => entry.comment.startLine)).toEqual([12, 20, 22]);
    expect(ordered.map((entry) => entry.comment.file)).toEqual([
      "src/foo.ts",
      "src/bar.ts",
      "src/bar.ts",
    ]);
    expect(ordered.every((entry) => entry.status === "placed")).toBe(true);
  });

  it("leads a file's outdated (header-pinned) comments before its placed ones", () => {
    const placed = comment({ startLine: 12, endLine: 12 });
    const drifted = comment({ startLine: 90, endLine: 90 });
    const ordered = orderedComments(FILES, [placed, drifted], false);
    expect(ordered[0]?.status).toBe("outdated");
    expect(ordered[0]?.line).toBeNull();
    expect(ordered[1]?.status).toBe("placed");
    expect(ordered[1]?.line).toBe(12);
  });

  it("resolves a placed comment to its authored line", () => {
    const [entry] = orderedComments(FILES, [comment({ startLine: 11, endLine: 13 })], false);
    expect(entry?.status).toBe("placed");
    expect(entry?.line).toBe(11);
  });

  it("trails unplaceable comments after every placeable one", () => {
    const stranded = comment({ file: "src/gone.ts", startLine: 5, endLine: 5 });
    const placed = comment({ file: "src/foo.ts", startLine: 12, endLine: 12 });
    const ordered = orderedComments(FILES, [stranded, placed], false);
    expect(ordered.map((entry) => entry.status)).toEqual(["placed", "unplaceable"]);
    expect(ordered[1]?.comment.file).toBe("src/gone.ts");
    expect(ordered[1]?.line).toBeNull();
  });

  it("places every anchor against a frozen patch, so nothing is outdated", () => {
    const wouldDrift = comment({ startLine: 90, endLine: 90 });
    const [entry] = orderedComments(FILES, [wouldDrift], true);
    expect(entry?.status).toBe("placed");
    expect(entry?.line).toBe(90);
  });
});

describe("navigableEntries", () => {
  it("keeps placed and outdated, drops unplaceable", () => {
    const entries = orderedComments(
      FILES,
      [
        comment({ startLine: 12, endLine: 12 }),
        comment({ startLine: 90, endLine: 90 }),
        comment({ file: "src/gone.ts" }),
      ],
      false,
    );
    const nav = navigableEntries(entries);
    expect(nav).toHaveLength(2);
    expect(nav.every((entry) => entry.status !== "unplaceable")).toBe(true);
  });
});

describe("indexOfComment", () => {
  it("finds a comment by id and reports -1 for an unknown id", () => {
    const target = comment({ startLine: 12, endLine: 12 });
    const entries = orderedComments(FILES, [target], false);
    expect(indexOfComment(entries, target.id)).toBe(0);
    expect(indexOfComment(entries, "nope")).toBe(-1);
  });
});

describe("commentCountsByFile", () => {
  it("counts comments per authored file, stranded ones included", () => {
    const counts = commentCountsByFile([
      comment({ file: "src/foo.ts" }),
      comment({ file: "src/foo.ts" }),
      comment({ file: "src/gone.ts" }),
    ]);
    expect(counts.get("src/foo.ts")).toBe(2);
    expect(counts.get("src/gone.ts")).toBe(1);
    expect(counts.get("src/bar.ts")).toBeUndefined();
  });
});
