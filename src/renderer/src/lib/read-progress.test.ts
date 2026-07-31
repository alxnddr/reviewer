import { describe, expect, it } from "vitest";
import type { ReviewLayer } from "../../../shared/review";
import { parsePatch, type PatchFile } from "../../../shared/diff/patch";
import {
  fileSignature,
  fileSignatures,
  isFileRead,
  isFullyRead,
  layerTally,
  markFilesRead,
  nextUnreadLayer,
  NO_COLLAPSED_FILES,
  NO_READ_FILES,
  readPaths,
  tallyRead,
  withCollapsed,
  type ReadFiles,
} from "./read-progress";

// Two files, parsed by the real parser so the signatures below are the ones git's own
// `index` lines produce rather than a hand-made stand-in.
const PATCH = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "index 1111111..2222222 100644",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -10,2 +10,3 @@",
  " context",
  "+added one",
  "+added two",
  "diff --git a/src/bar.ts b/src/bar.ts",
  "index 3333333..4444444 100644",
  "--- a/src/bar.ts",
  "+++ b/src/bar.ts",
  "@@ -1,1 +1,2 @@",
  " keep",
  "+new line",
  "",
].join("\n");

/** The same two files with foo.ts rewritten — a new blob on one side, which is exactly
 * what a re-derived diff hands the app after the branch moved. */
const PATCH_FOO_CHANGED = PATCH.replace("index 1111111..2222222", "index 1111111..5555555");

function parse(patch: string): PatchFile[] {
  return parsePatch(patch, "read-progress-test");
}

function fileAt(files: PatchFile[], path: string): PatchFile {
  const file = files.find((candidate) => candidate.path === path);
  if (file === undefined) {
    throw new Error(`fixture is missing ${path}`);
  }
  return file;
}

function layer(id: string, ranges: ReviewLayer["ranges"], parent?: string): ReviewLayer {
  return {
    id,
    label: id,
    summary: id,
    ranges,
    ...(parent === undefined ? {} : { parent }),
  };
}

const FOO_RANGE = { file: "src/foo.ts", side: "additions", startLine: 11, endLine: 12 } as const;
const BAR_RANGE = { file: "src/bar.ts", side: "additions", startLine: 2, endLine: 2 } as const;

describe("fileSignature", () => {
  it("is the git blob pair, so it moves exactly when the file's content does", () => {
    const before = fileAt(parse(PATCH), "src/foo.ts");
    const after = fileAt(parse(PATCH_FOO_CHANGED), "src/foo.ts");
    expect(fileSignature(before)).not.toBe(fileSignature(after));
    expect(fileSignature(before)).toBe(fileSignature(fileAt(parse(PATCH), "src/foo.ts")));
  });

  it("still separates two files when the patch carries no index lines to key on", () => {
    const bare = parse(
      [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1,1 +1,2 @@",
        " keep",
        "+one",
        "diff --git a/b.ts b/b.ts",
        "--- a/b.ts",
        "+++ b/b.ts",
        "@@ -40,1 +40,3 @@",
        " keep",
        "+one",
        "+two",
        "",
      ].join("\n"),
    );
    expect(fileSignature(fileAt(bare, "a.ts"))).not.toBe(fileSignature(fileAt(bare, "b.ts")));
  });
});

describe("fileSignatures", () => {
  it("carries every file's own fileSignature, keyed by path", () => {
    const files = parse(PATCH);
    const signatures = fileSignatures(files);
    expect(signatures.get("src/foo.ts")).toBe(fileSignature(fileAt(files, "src/foo.ts")));
    expect(signatures.get("src/bar.ts")).toBe(fileSignature(fileAt(files, "src/bar.ts")));
    expect(signatures.get("src/nowhere.ts")).toBeUndefined();
  });

  it("caches on the files array's identity, so a per-header lookup never rescans it", () => {
    const files = parse(PATCH);
    // Same array, called from two "selectors": the same Map instance comes back, which is
    // what lets a consumer that runs on every store write skip recomputing the join.
    expect(fileSignatures(files)).toBe(fileSignatures(files));
  });

  it("recomputes for a genuinely new files array, the same identity rule soloed-diff.ts uses", () => {
    const first = parse(PATCH);
    const second = parse(PATCH);
    expect(fileSignatures(first)).not.toBe(fileSignatures(second));
    // Different Map instances, same content — the cache key is identity, not equality.
    expect(fileSignatures(first).get("src/foo.ts")).toBe(fileSignatures(second).get("src/foo.ts"));
  });
});

describe("marks against content", () => {
  it("a file read stays read across a reload that did not touch it", () => {
    const files = parse(PATCH);
    const marks = markFilesRead(NO_READ_FILES, [fileAt(files, "src/bar.ts")], true);
    expect(isFileRead(marks, fileAt(parse(PATCH_FOO_CHANGED), "src/bar.ts"))).toBe(true);
  });

  it("a file that changed underneath the mark reads unread again", () => {
    const marks = markFilesRead(NO_READ_FILES, [fileAt(parse(PATCH), "src/foo.ts")], true);
    expect(isFileRead(marks, fileAt(parse(PATCH_FOO_CHANGED), "src/foo.ts"))).toBe(false);
  });

  it("keeps a mark for a file the diff dropped, so widening back restores it", () => {
    const files = parse(PATCH);
    const marks = markFilesRead(NO_READ_FILES, files, true);
    // A narrowed diff carrying only bar.ts: foo.ts is not counted…
    expect(tallyRead([fileAt(files, "src/bar.ts")], marks)).toEqual({ read: 1, total: 1 });
    // …and is read again the moment it is back.
    expect(tallyRead(files, marks)).toEqual({ read: 2, total: 2 });
  });

  it("returns the same map when a gesture changes nothing", () => {
    const files = parse(PATCH);
    const marks = markFilesRead(NO_READ_FILES, files, true);
    expect(markFilesRead(marks, files, true)).toBe(marks);
    expect(markFilesRead(NO_READ_FILES, files, false)).toBe(NO_READ_FILES);
  });
});

describe("tallies", () => {
  it("counts only the files the loaded diff carries", () => {
    const files = parse(PATCH);
    const marks = markFilesRead(NO_READ_FILES, [fileAt(files, "src/foo.ts")], true);
    expect(tallyRead(files, marks)).toEqual({ read: 1, total: 2 });
    expect(isFullyRead({ read: 0, total: 0 })).toBe(false);
    expect(readPaths(files, marks)).toEqual(new Set(["src/foo.ts"]));
  });

  it("a layer's tally spans its extent, so a group finishes when its sections do", () => {
    const layers = [
      layer("group", []),
      layer("group-foo", [FOO_RANGE], "group"),
      layer("group-bar", [BAR_RANGE], "group"),
    ];
    const files = parse(PATCH);
    const half = markFilesRead(NO_READ_FILES, [fileAt(files, "src/foo.ts")], true);

    expect(layerTally(files, layers[0]!, layers, half)).toEqual({ read: 1, total: 2 });
    expect(layerTally(files, layers[1]!, layers, half)).toEqual({ read: 1, total: 1 });
    expect(layerTally(files, layers[2]!, layers, half)).toEqual({ read: 0, total: 1 });

    const all = markFilesRead(half, files, true);
    expect(isFullyRead(layerTally(files, layers[0]!, layers, all))).toBe(true);
  });

  it("a layer whose files left the diff has nothing to read, not zero read", () => {
    const gone = [layer("gone", [{ ...FOO_RANGE, file: "src/vanished.ts" }])];
    expect(layerTally(parse(PATCH), gone[0]!, gone, NO_READ_FILES)).toEqual({
      read: 0,
      total: 0,
    });
  });
});

describe("nextUnreadLayer", () => {
  const layers = [layer("first", [FOO_RANGE]), layer("second", [BAR_RANGE])];
  const files = parse(PATCH);

  it("offers the first layer of an untouched review", () => {
    expect(nextUnreadLayer(files, layers, NO_READ_FILES)).toBe("first");
  });

  it("walks in reading order, not by how much is left", () => {
    const marks = markFilesRead(NO_READ_FILES, [fileAt(files, "src/foo.ts")], true);
    expect(nextUnreadLayer(files, layers, marks)).toBe("second");
  });

  it("resolves to nothing once the review is read out", () => {
    expect(nextUnreadLayer(files, layers, markFilesRead(NO_READ_FILES, files, true))).toBeNull();
  });

  it("skips a drifted layer rather than resuming into a dead end", () => {
    const drifted = [
      layer("gone", [{ ...FOO_RANGE, file: "src/vanished.ts" }]),
      layer("real", [BAR_RANGE]),
    ];
    expect(nextUnreadLayer(files, drifted, NO_READ_FILES)).toBe("real");
  });

  it("resumes into a group before the section inside it, matching document order", () => {
    const nested = [layer("group", []), layer("group-bar", [BAR_RANGE], "group")];
    expect(nextUnreadLayer(files, nested, NO_READ_FILES)).toBe("group");
  });
});

describe("withCollapsed", () => {
  it("folds and unfolds, and returns the same set when nothing moved", () => {
    const folded = withCollapsed(NO_COLLAPSED_FILES, ["a.ts", "b.ts"], true);
    expect(folded).toEqual(new Set(["a.ts", "b.ts"]));
    expect(withCollapsed(folded, ["a.ts"], true)).toBe(folded);
    expect(withCollapsed(folded, ["a.ts"], false)).toEqual(new Set(["b.ts"]));
    expect(withCollapsed(NO_COLLAPSED_FILES, ["a.ts"], false)).toBe(NO_COLLAPSED_FILES);
  });
});

describe("the empty map is shared", () => {
  it("hands every session with no progress one reference", () => {
    const other: ReadFiles = NO_READ_FILES;
    expect(other).toBe(NO_READ_FILES);
    expect(NO_READ_FILES.size).toBe(0);
  });
});
