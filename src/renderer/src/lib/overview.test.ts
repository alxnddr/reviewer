import { describe, expect, it } from "vitest";
import type { Comment, ReviewLayer } from "../../../shared/review";
import { UNCOVERED_LAYER_ID } from "./coverage";
import { parsePatch, type PatchFile } from "./diff/patch";
import { snippetForAnchor } from "./diff/snippet";
import { NO_READ_FILES } from "./read-progress";
import { buildOverview } from "./overview";

// A three-file diff read by the real parser, so every count below is measured against a
// genuine changed-line universe rather than a hand-tallied one.
// foo.ts: additions {11,12,13}, deletion {11}. bar.ts: additions {2,3}. skipped.ts:
// additions {1}. Seven coverable changed lines in all.
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
  "@@ -1,1 +1,3 @@",
  " ctx1",
  "+new2",
  "+new3",
  "diff --git a/src/skipped.ts b/src/skipped.ts",
  "new file mode 100644",
  "index 0000000..5555555",
  "--- /dev/null",
  "+++ b/src/skipped.ts",
  "@@ -0,0 +1 @@",
  "+lonely",
  "",
].join("\n");

const FILES: PatchFile[] = parsePatch(PATCH, "test");

function layer(id: string, ranges: ReviewLayer["ranges"], extra: Partial<ReviewLayer> = {}) {
  return { id, label: id, summary: `${id} summary`, ranges, ...extra };
}

function comment(file: string, startLine: number, endLine: number, id: string): Comment {
  return { file, side: "additions", startLine, endLine, body: "why", id };
}

const FOO = layer("foo", [
  { file: "src/foo.ts", side: "additions", startLine: 11, endLine: 12 },
  { file: "src/foo.ts", side: "deletions", startLine: 11, endLine: 11 },
]);
const BAR = layer("bar", [{ file: "src/bar.ts", side: "additions", startLine: 2, endLine: 3 }]);

describe("buildOverview", () => {
  it("counts each chapter's own footprint, not the whole file's", () => {
    const model = buildOverview({
      layers: [FOO],
      files: FILES,
      comments: [],
      frozen: false,
      readFiles: NO_READ_FILES,
    });
    const [chapter] = model.chapters;

    // FOO walks two of foo.ts's three additions plus its one deletion — the file's third
    // addition belongs to no layer and must not be credited to this chapter.
    expect(chapter?.additions).toBe(2);
    expect(chapter?.deletions).toBe(1);
    expect(chapter?.files).toEqual([
      { path: "src/foo.ts", status: "modified", additions: 2, deletions: 1, read: false },
    ]);
    // The headline still describes the whole diff.
    expect(model.files).toBe(3);
    expect(model.additions).toBe(6);
    expect(model.deletions).toBe(1);
  });

  it("appends the inferred not-covered chapter, ordinal-less, after the authored ones", () => {
    const model = buildOverview({
      layers: [FOO, BAR],
      files: FILES,
      comments: [],
      frozen: false,
      readFiles: NO_READ_FILES,
    });

    expect(model.chapters.map((chapter) => chapter.layer.id)).toEqual([
      "foo",
      "bar",
      UNCOVERED_LAYER_ID,
    ]);
    expect(model.chapters.map((chapter) => chapter.ordinal)).toEqual(["1", "2", null]);
    // skipped.ts is the only file no layer references at all.
    expect(model.chapters[2]?.files.map((file) => file.path)).toEqual(["src/skipped.ts"]);
  });

  it("gives a comment to the first chapter that covers it, and only that one", () => {
    const overlapping = layer("also-foo", [
      { file: "src/foo.ts", side: "additions", startLine: 11, endLine: 13 },
    ]);
    const model = buildOverview({
      layers: [FOO, overlapping],
      files: FILES,
      comments: [comment("src/foo.ts", 11, 11, "c1"), comment("src/bar.ts", 2, 2, "c2")],
      frozen: false,
      readFiles: NO_READ_FILES,
    });

    expect(model.chapters[0]?.comments).toBe(1);
    expect(model.chapters[0]?.firstCommentId).toBe("c1");
    expect(model.chapters[1]?.comments).toBe(0);
    // bar.ts sits in no authored layer, so its comment lands on the inferred chapter.
    expect(model.chapters[2]?.comments).toBe(1);
    expect(model.comments).toBe(2);
  });

  it("previews the first range that still places, and flags a chapter whose ranges drifted", () => {
    const drifted = layer("gone", [
      { file: "src/vanished.ts", side: "additions", startLine: 1, endLine: 2 },
    ]);
    const model = buildOverview({
      layers: [FOO, drifted],
      files: FILES,
      comments: [],
      frozen: false,
      readFiles: NO_READ_FILES,
    });

    expect(model.chapters[0]?.snippet?.file).toBe("src/foo.ts");
    expect(model.chapters[0]?.snippet?.snippet.lines.map((line) => line.text)).toEqual([
      "new11",
      "new12",
    ]);
    expect(model.chapters[0]?.outdated).toBe(false);

    expect(model.chapters[1]?.outdated).toBe(true);
    expect(model.chapters[1]?.snippet).toBeNull();
    // The layer still claims the file; it is listed, marked absent from this diff.
    expect(model.chapters[1]?.files).toEqual([
      { path: "src/vanished.ts", status: null, additions: 0, deletions: 0, read: false },
    ]);
  });

  it("gives a parent the totals of everything under it, and each child its own", () => {
    const parent = layer("parent", []);
    const child = layer(
      "child",
      [{ file: "src/bar.ts", side: "additions", startLine: 2, endLine: 3 }],
      { parent: "parent" },
    );
    const model = buildOverview({
      layers: [parent, child],
      files: FILES,
      comments: [comment("src/bar.ts", 2, 2, "c1")],
      frozen: false,
      readFiles: NO_READ_FILES,
    });

    // The parent has no ranges of its own; its extent is the child's, so its figures are
    // the group's totals — by the same rule that gives a leaf its own.
    expect(model.chapters[0]?.hasChildren).toBe(true);
    expect(model.chapters[0]?.files.map((file) => file.path)).toEqual(["src/bar.ts"]);
    expect(model.chapters[0]?.additions).toBe(2);
    // A comment inside the group is *owned* by the child that anchors it and *counted* by
    // the parent that contains it: aggregation up, ownership down.
    expect(model.chapters[0]?.comments).toBe(1);
    expect(model.chapters[0]?.firstCommentId).toBe("c1");
    expect(model.chapters[1]?.comments).toBe(1);
    expect(model.chapters[1]?.hasChildren).toBe(false);
    expect(model.chapters[1]?.files.map((file) => file.path)).toEqual(["src/bar.ts"]);
  });

  it("numbers chapters by section, at any depth", () => {
    const parent = layer("parent", []);
    const child = layer("child", [], { parent: "parent" });
    const grandchild = layer(
      "grandchild",
      [{ file: "src/bar.ts", side: "additions", startLine: 2, endLine: 3 }],
      { parent: "child" },
    );
    const model = buildOverview({
      layers: [FOO, parent, child, grandchild, BAR],
      files: FILES,
      comments: [],
      frozen: false,
      readFiles: NO_READ_FILES,
    });

    // The inferred chapter is no authored step, so it wears no number at all.
    expect(model.chapters.map((chapter) => chapter.ordinal)).toEqual([
      "1",
      "2",
      "2.1",
      "2.1.1",
      "3",
      null,
    ]);
    expect(model.chapters.map((chapter) => chapter.depth)).toEqual([0, 0, 1, 2, 0, 0]);
  });

  it("reads without a diff: the chapters and their files survive, the counts stand down", () => {
    const model = buildOverview({
      layers: [FOO],
      files: [],
      comments: [],
      frozen: false,
      readFiles: NO_READ_FILES,
    });

    expect(model.chapters[0]?.files.map((file) => file.path)).toEqual(["src/foo.ts"]);
    expect(model.chapters[0]?.additions).toBe(0);
    expect(model.chapters[0]?.snippet).toBeNull();
    expect(model.files).toBe(0);
  });

  it("never flags a frozen review's chapter as outdated", () => {
    const drifted = layer("gone", [
      { file: "src/vanished.ts", side: "additions", startLine: 1, endLine: 2 },
    ]);
    const model = buildOverview({
      layers: [drifted],
      files: FILES,
      comments: [],
      frozen: true,
      readFiles: NO_READ_FILES,
    });

    // The frozen rule still needs the file to be in the diff (lib/layers.ts), so this one
    // is honestly outdated; a frozen chapter over a present file is not.
    expect(model.chapters[0]?.outdated).toBe(true);
    const present = buildOverview({
      layers: [FOO],
      files: FILES,
      comments: [],
      frozen: true,
      readFiles: NO_READ_FILES,
    });
    expect(present.chapters[0]?.outdated).toBe(false);
  });
});

describe("snippetForAnchor", () => {
  const foo = FILES.find((file) => file.path === "src/foo.ts");

  it("lifts the anchor's own lines with their file line numbers and change kinds", () => {
    const snippet = snippetForAnchor(
      foo!.fileDiff,
      { file: "src/foo.ts", side: "additions", startLine: 10, endLine: 12 },
      6,
    );

    expect(snippet).toEqual({
      lines: [
        { kind: "context", line: 10, text: "ctx10" },
        { kind: "addition", line: 11, text: "new11" },
        { kind: "addition", line: 12, text: "new12" },
      ],
      hidden: 0,
    });
  });

  it("reads the deletions side in old-file coordinates", () => {
    const snippet = snippetForAnchor(
      foo!.fileDiff,
      { file: "src/foo.ts", side: "deletions", startLine: 11, endLine: 11 },
      6,
    );

    expect(snippet?.lines).toEqual([{ kind: "deletion", line: 11, text: "old11" }]);
  });

  it("caps at the limit and reports what it withheld", () => {
    const snippet = snippetForAnchor(
      foo!.fileDiff,
      { file: "src/foo.ts", side: "additions", startLine: 11, endLine: 13 },
      2,
    );

    expect(snippet?.lines.map((line) => line.text)).toEqual(["new11", "new12"]);
    expect(snippet?.hidden).toBe(1);
  });

  it("is null when the range covers no line of this diff", () => {
    expect(
      snippetForAnchor(
        foo!.fileDiff,
        { file: "src/foo.ts", side: "additions", startLine: 400, endLine: 402 },
        6,
      ),
    ).toBeNull();
  });
});
