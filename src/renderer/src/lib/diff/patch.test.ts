import { describe, expect, it } from "vitest";
import type { FileDiffMetadata } from "@pierre/diffs";
import {
  buildHugeAdditionPatch,
  MULTI_STATUS_PATCH,
  RENAME_WITH_EDIT_PATCH,
  SPACED_NAME_PATCH,
} from "./fixtures";
import { fileChangeStatus, parsePatch } from "./patch";

describe("parsePatch", () => {
  it("maps every file of a multi-status patch", () => {
    const files = parsePatch(MULTI_STATUS_PATCH, "test");
    expect(
      files.map(({ path, previousPath, status, isBinary }) => ({
        path,
        previousPath,
        status,
        isBinary,
      })),
    ).toEqual([
      { path: "added.txt", previousPath: null, status: "added", isBinary: false },
      { path: "doomed.txt", previousPath: null, status: "deleted", isBinary: false },
      { path: "greet.ts", previousPath: null, status: "modified", isBinary: false },
      { path: "img.png", previousPath: null, status: "modified", isBinary: true },
      { path: "newname.txt", previousPath: "oldname.txt", status: "renamed", isBinary: false },
      { path: "notes.txt", previousPath: null, status: "modified", isBinary: false },
    ]);
  });

  it("keeps the parsed hunks for rendering", () => {
    const files = parsePatch(MULTI_STATUS_PATCH, "test");
    const modified = files.find((file) => file.path === "greet.ts");
    expect(modified?.fileDiff.hunks).toHaveLength(1);
    expect(modified?.fileDiff.unifiedLineCount).toBe(8);
  });

  it("does not confuse a pure rename (also hunk-less) with a binary change", () => {
    const files = parsePatch(MULTI_STATUS_PATCH, "test");
    const rename = files.find((file) => file.path === "newname.txt");
    expect(rename?.isBinary).toBe(false);
    expect(rename?.fileDiff.hunks).toHaveLength(0);
  });

  it("maps a rename with edits to renamed and keeps its hunks", () => {
    const files = parsePatch(RENAME_WITH_EDIT_PATCH, "test");
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      path: "final.txt",
      previousPath: "newname.txt",
      status: "renamed",
      isBinary: false,
    });
    expect(files[0]?.fileDiff.hunks).toHaveLength(1);
  });

  it("parses a path containing a space", () => {
    const files = parsePatch(SPACED_NAME_PATCH, "test");
    expect(files.map((file) => file.path)).toEqual(["sp ace.txt"]);
    expect(files[0]?.status).toBe("added");
  });

  it("yields an empty list for an empty patch", () => {
    expect(parsePatch("", "test")).toEqual([]);
  });

  it("yields an empty list for non-patch input", () => {
    expect(parsePatch("not a patch at all", "test")).toEqual([]);
  });

  it("parses a 100k-line file addition", () => {
    const files = parsePatch(buildHugeAdditionPatch(100_000), "test");
    expect(files).toHaveLength(1);
    expect(files[0]?.status).toBe("added");
    expect(files[0]?.fileDiff.unifiedLineCount).toBe(100_000);
  });

  it("derives collision-free highlight cache keys from the prefix", () => {
    // The shared worker pool caches highlights by fileDiff.cacheKey, and Pierre
    // falls back to the file NAME when the key is absent — two sessions holding
    // an equally-named file would render each other's cached rows. The keys
    // must exist and differ whenever the prefix differs.
    const first = parsePatch(MULTI_STATUS_PATCH, "session-a:1");
    const second = parsePatch(MULTI_STATUS_PATCH, "session-b:1");
    for (const [index, file] of first.entries()) {
      expect(file.fileDiff.cacheKey).toBeDefined();
      expect(file.fileDiff.cacheKey).toContain("session-a:1");
      expect(file.fileDiff.cacheKey).not.toBe(second[index]?.fileDiff.cacheKey);
    }
  });
});

describe("fileChangeStatus", () => {
  it("covers every parser change type", () => {
    const cases: Record<FileDiffMetadata["type"], ReturnType<typeof fileChangeStatus>> = {
      new: "added",
      change: "modified",
      deleted: "deleted",
      "rename-pure": "renamed",
      "rename-changed": "renamed",
    };
    for (const [type, expected] of Object.entries(cases)) {
      expect(fileChangeStatus(type as FileDiffMetadata["type"])).toBe(expected);
    }
  });

  it("throws on a change type the mapping does not know", () => {
    expect(() => fileChangeStatus("copied" as FileDiffMetadata["type"])).toThrow(
      /Unhandled variant/,
    );
  });
});
