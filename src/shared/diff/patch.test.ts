import { describe, expect, it, vi } from "vitest";
import type { FileDiffMetadata } from "@pierre/diffs";
import {
  buildHugeAdditionPatch,
  MULTI_STATUS_PATCH,
  QUOTED_BINARY_RENAME_PATCH,
  RENAME_WITH_EDIT_PATCH,
  RENAMES_PATCH,
  SPACED_NAME_PATCH,
} from "./fixtures";
import { fileChangeStatus, filesByAnchorPath, parsePatch } from "./patch";

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

  it("keeps binary detection when a stray file break desyncs the parsed file count", () => {
    // Synthesized: the parser breaks files at every line starting `diff --git`, with or
    // without the trailing space a real header carries, so the message line below parses as
    // one more (nameless) file than a `diff --git ` header scan finds. Detection reads each
    // marker against the header above it *by name*, so a header nobody can read costs its
    // own file the flag and no one else's — the whole patch used to lose it.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const strayBreak = ["diff --gitignore rules moved too", "---", MULTI_STATUS_PATCH].join("\n");
    const files = parsePatch(strayBreak, "test");
    expect(files.find((file) => file.path === "img.png")?.isBinary).toBe(true);
    expect(files.filter((file) => file.isBinary).map((file) => file.path)).toEqual(["img.png"]);
    errorSpy.mockRestore();
  });

  it("flags a renamed binary under the name the parser gives it, quoted path and all", () => {
    // A quoted path is spelled one way in the `diff --git` header and another on the
    // `rename to` line the parser prefers, so reading only the header would key the flag
    // under a name no parsed file answers to.
    const files = parsePatch(QUOTED_BINARY_RENAME_PATCH, "test");
    expect(files.filter((file) => file.isBinary).map((file) => file.path)).toEqual([
      "big-new.bin",
      String.raw`"caf\303\251-new.bin"`,
    ]);
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

describe("filesByAnchorPath", () => {
  it("maps a renamed file under both of its names", () => {
    const files = parsePatch(RENAMES_PATCH, "test");
    const byPath = filesByAnchorPath(files);
    expect(byPath.get("src/edit.txt")?.path).toBe("src/edit.txt");
    expect(byPath.get("src/old-edit.txt")?.path).toBe("src/edit.txt");
    expect(byPath.get("src/pure.txt")?.path).toBe("src/pure.txt");
    expect(byPath.get("src/old-pure.txt")?.path).toBe("src/pure.txt");
    expect(byPath.has("src/nowhere.txt")).toBe(false);
  });

  it("maps an unrenamed file under its one name only", () => {
    const byPath = filesByAnchorPath(parsePatch(MULTI_STATUS_PATCH, "test"));
    expect(byPath.get("greet.ts")?.path).toBe("greet.ts");
    expect([...byPath.keys()]).toHaveLength(7); // six files, one of them renamed
  });

  it("gives a contested name to the file that carries it now, not the one that left it", () => {
    // Synthesized: git pairs a rename by content, so it will not itself emit a diff
    // where a renamed-away path is also a new file. The lookup still has to answer,
    // because the name means the *current* file to everyone reading it.
    const collision = [
      "diff --git a/src/shared.txt b/src/moved.txt",
      "similarity index 100%",
      "rename from src/shared.txt",
      "rename to src/moved.txt",
      "diff --git a/src/shared.txt b/src/shared.txt",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/src/shared.txt",
      "@@ -0,0 +1,2 @@",
      "+fresh line1",
      "+fresh line2",
      "",
    ].join("\n");
    const files = parsePatch(collision, "test");
    expect(files.map((file) => file.path)).toEqual(["src/moved.txt", "src/shared.txt"]);
    expect(filesByAnchorPath(files).get("src/shared.txt")?.path).toBe("src/shared.txt");
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
      /Unhandled variant/u,
    );
  });
});
