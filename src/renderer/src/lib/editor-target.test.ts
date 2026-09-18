import { describe, expect, it } from "vitest";
import { MULTI_STATUS_PATCH, ONE_HUNK_PATCH, RENAMES_PATCH } from "../../../shared/diff/fixtures";
import { parsePatch, type PatchFile } from "../../../shared/diff/patch";
import type { Comment } from "../../../shared/review";
import {
  editorAvailability,
  editorRequestFor,
  editorTargetFor,
  fileOpenLine,
  newFileLine,
} from "./editor-target";

// The deletions-side translation is the part worth pinning: it is the one place a line number
// the reader sees (old-file) becomes a line number the editor is sent (new-file), and getting it
// wrong lands them in the wrong function with no sign anything is off.

const ONE_HUNK = parsePatch(ONE_HUNK_PATCH, "editor-target");
const MULTI = parsePatch(MULTI_STATUS_PATCH, "editor-target-multi");

function named(files: readonly PatchFile[], path: string): PatchFile {
  const file = files.find((candidate) => candidate.path === path);
  if (file === undefined) {
    throw new Error(`fixture has no ${path}`);
  }
  return file;
}

// src/foo.ts: old 8..14 → new 8..16; context 8-10, `-old11` → `+new11 +new12 +new13`,
// context old 12-14 → new 14-16.
const FOO = named(ONE_HUNK, "src/foo.ts").fileDiff;

describe("newFileLine", () => {
  it("answers an additions-side line as itself", () => {
    expect(newFileLine(FOO, "additions", 12)).toBe(12);
  });

  it("puts a deleted line where its run sits in the new file", () => {
    expect(newFileLine(FOO, "deletions", 11)).toBe(11);
  });

  it("carries a context line across by its row, before and after a change", () => {
    expect(newFileLine(FOO, "deletions", 9)).toBe(9);
    expect(newFileLine(FOO, "deletions", 13)).toBe(15);
    expect(newFileLine(FOO, "deletions", 14)).toBe(16);
  });

  it("is null off every hunk", () => {
    expect(newFileLine(FOO, "deletions", 7)).toBeNull();
    expect(newFileLine(FOO, "deletions", 99)).toBeNull();
  });

  it("lands a deletion with no additions after it one past the last new-file line", () => {
    // notes.txt: ` a / -b / +B / c d e / +f` — old 2 sits at new 2; a deletion at the very
    // end of a hunk has nothing after it.
    const notes = named(MULTI, "notes.txt").fileDiff;
    expect(newFileLine(notes, "deletions", 2)).toBe(2);
    expect(newFileLine(notes, "deletions", 5)).toBe(5);
    const doomed = named(MULTI, "doomed.txt").fileDiff;
    expect(newFileLine(doomed, "deletions", 2)).toBe(1);
  });
});

describe("fileOpenLine and editorTargetFor", () => {
  it("opens a file on its first line in the diff", () => {
    expect(fileOpenLine(named(ONE_HUNK, "src/foo.ts"))).toBe(8);
    expect(editorTargetFor(named(ONE_HUNK, "src/foo.ts"), null)).toEqual({
      path: "src/foo.ts",
      line: 8,
    });
  });

  it("opens a file with no lines without one", () => {
    expect(fileOpenLine(named(MULTI, "img.png"))).toBeNull();
    expect(editorTargetFor(named(MULTI, "img.png"), null)).toEqual({ path: "img.png" });
  });

  it("names a renamed file by its new path even from its old one", () => {
    const files = parsePatch(RENAMES_PATCH, "editor-target-renames");
    const renamed = files.find((file) => file.previousPath !== null);
    expect(renamed).toBeDefined();
    if (renamed !== undefined) {
      expect(editorTargetFor(renamed, null).path).toBe(renamed.path);
    }
  });
});

describe("editorAvailability", () => {
  const file = named(MULTI, "greet.ts");
  it("refuses in order: frozen, no editor, deleted", () => {
    expect(editorAvailability({ editor: "none", frozen: true, file })).toBe("frozen");
    expect(editorAvailability({ editor: "none", frozen: false, file })).toBe("noEditor");
    expect(
      editorAvailability({ editor: "zed", frozen: false, file: named(MULTI, "doomed.txt") }),
    ).toBe("deleted");
    expect(editorAvailability({ editor: "zed", frozen: false, file })).toBe("ready");
    expect(editorAvailability({ editor: "zed", frozen: false, file: null })).toBe("ready");
  });
});

describe("editorRequestFor", () => {
  const comment: Comment = {
    id: "c1",
    file: "src/foo.ts",
    side: "deletions",
    startLine: 13,
    endLine: 13,
    body: "here",
  };

  it("prefers the focused comment's line, translated to the new file", () => {
    expect(
      editorRequestFor({
        files: ONE_HUNK,
        selectedFilePath: "src/foo.ts",
        activeCommentId: "c1",
        comments: [comment],
      }),
    ).toEqual({ path: "src/foo.ts", line: 15 });
  });

  it("falls back to the focused file's opening line", () => {
    expect(
      editorRequestFor({
        files: ONE_HUNK,
        selectedFilePath: "src/foo.ts",
        activeCommentId: null,
        comments: [comment],
      }),
    ).toEqual({ path: "src/foo.ts", line: 8 });
  });

  it("is null with no diff, no focus, or a focus the diff does not carry", () => {
    expect(
      editorRequestFor({
        files: null,
        selectedFilePath: "src/foo.ts",
        activeCommentId: null,
        comments: [],
      }),
    ).toBeNull();
    expect(
      editorRequestFor({
        files: ONE_HUNK,
        selectedFilePath: null,
        activeCommentId: null,
        comments: [],
      }),
    ).toBeNull();
    expect(
      editorRequestFor({
        files: ONE_HUNK,
        selectedFilePath: "src/gone.ts",
        activeCommentId: "c9",
        comments: [comment],
      }),
    ).toBeNull();
  });
});
