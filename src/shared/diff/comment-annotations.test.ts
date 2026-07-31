import { describe, expect, it } from "vitest";
import type { CodeViewLineSelection, DiffLineAnnotation } from "@pierre/diffs";
import type { Comment, ReviewAnchor } from "../review";
import { resolveAnchor } from "./anchor";
import {
  anchorFromLine,
  anchorFromRange,
  buildCommentItems,
  pickAddAnchor,
  selectionRange,
  unplaceableComments,
  type CommentSlot,
  type CommentUiState,
} from "./comment-annotations";
import { RENAMES_PATCH, TWO_HUNKS_PATCH } from "./fixtures";
import { parsePatch } from "./patch";

// One modification hunk over new-file lines 10..14 (additions) and old-file
// lines 10..12 (deletions), so a comment can be placed on a covered line or
// drifted off the end of it.
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
  "",
].join("\n");

const FILES = parsePatch(PATCH, "test");

// `src/old-edit.txt` → `src/edit.txt` (one hunk over old/new lines 1..5) and
// `src/old-pure.txt` → `src/pure.txt` (no hunks at all).
const RENAMED = parsePatch(RENAMES_PATCH, "test");

const NO_UI: CommentUiState = { editingId: null, draft: null };

function comment(overrides: Partial<Comment> = {}): Comment {
  return {
    file: "src/foo.ts",
    side: "additions",
    startLine: 11,
    endLine: 13,
    body: "look here",
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ...overrides,
  };
}

/** The single diff item and its annotation list, for a one-file diff. */
function annotationsOf(comments: Comment[], ui: CommentUiState = NO_UI) {
  const [item] = buildCommentItems(FILES, comments, ui, false);
  return { item, annotations: item?.annotations ?? [] };
}

/** One named file's annotation list, for a diff with more than one file. */
function annotationsOfFile(
  items: ReturnType<typeof buildCommentItems>,
  path: string,
): DiffLineAnnotation<CommentSlot>[] {
  return items.find((item) => item.id === path)?.annotations ?? [];
}

describe("buildCommentItems", () => {
  it("places a covered comment on its resolved {side, lineNumber}", () => {
    const { annotations } = annotationsOf([comment()]);
    expect(annotations).toHaveLength(1);
    expect(annotations[0]?.side).toBe("additions");
    expect(annotations[0]?.lineNumber).toBe(11);
    const slot = annotations[0]?.metadata as Extract<CommentSlot, { kind: "comment" }>;
    expect(slot.kind).toBe("comment");
    expect(slot.outdated).toBe(false);
  });

  it("pins a comment whose range no longer matches the diff to the file header (lineNumber 0), not dropped or misplaced", () => {
    const drifted = comment({ startLine: 90, endLine: 90 });
    const { annotations } = annotationsOf([drifted]);
    expect(annotations).toHaveLength(1);
    expect(annotations[0]?.lineNumber).toBe(0);
    const slot = annotations[0]?.metadata as Extract<CommentSlot, { kind: "comment" }>;
    expect(slot.outdated).toBe(true);
    expect(slot.comment.startLine).toBe(90);
  });

  it("places every anchor on its authored line against a frozen embedded patch, never outdated", () => {
    // A frozen review embeds the exact diff its anchors were authored on, so a range
    // no re-derived hunk would cover still lands — the diff cannot have drifted. Same
    // comment that pins to the header under `derived`, placed here.
    const wouldDrift = comment({ startLine: 90, endLine: 90 });
    const [item] = buildCommentItems(FILES, [wouldDrift], NO_UI, true);
    const annotations = item?.annotations ?? [];
    expect(annotations[0]?.lineNumber).toBe(90);
    const slot = annotations[0]?.metadata as Extract<CommentSlot, { kind: "comment" }>;
    expect(slot.outdated).toBe(false);
  });

  it("keeps the authored side when pinning an outdated deletion-side comment", () => {
    const drifted = comment({ side: "deletions", startLine: 90, endLine: 90 });
    const { annotations } = annotationsOf([drifted]);
    expect(annotations[0]?.side).toBe("deletions");
    expect(annotations[0]?.lineNumber).toBe(0);
    const slot = annotations[0]?.metadata as Extract<CommentSlot, { kind: "comment" }>;
    expect(slot.outdated).toBe(true);
  });

  it("emits no annotation for a comment whose file is absent from the diff", () => {
    const items = buildCommentItems(FILES, [comment({ file: "src/gone.ts" })], NO_UI, false);
    expect(items).toHaveLength(1);
    expect(items[0]?.annotations).toHaveLength(0);
  });

  it("hosts a comment authored before a rename on the renamed file, on its old-file line", () => {
    // The deletions side is old-file coordinates, which is exactly what an anchor
    // written against `src/old-edit.txt` carries — so the rename costs it nothing.
    const authored = comment({
      file: "src/old-edit.txt",
      side: "deletions",
      startLine: 2,
      endLine: 2,
    });
    const items = buildCommentItems(RENAMED, [authored], NO_UI, false);
    const edited = annotationsOfFile(items, "src/edit.txt");
    expect(edited).toHaveLength(1);
    expect(edited[0]?.lineNumber).toBe(2);
    const slot = edited[0]?.metadata as Extract<CommentSlot, { kind: "comment" }>;
    expect(slot.outdated).toBe(false);
    // And on no other file: the old path is not a second home for it.
    expect(annotationsOfFile(items, "src/pure.txt")).toHaveLength(0);
  });

  it("hosts a comment authored before a pure rename at the renamed file's header", () => {
    // A pure rename carries no hunks, so nothing can cover the range — but the file is
    // right there, so the comment pins to its header rather than vanishing.
    const authored = comment({ file: "src/old-pure.txt", startLine: 2, endLine: 2 });
    const items = buildCommentItems(RENAMED, [authored], NO_UI, false);
    const renamed = annotationsOfFile(items, "src/pure.txt");
    expect(renamed).toHaveLength(1);
    expect(renamed[0]?.lineNumber).toBe(0);
    const slot = renamed[0]?.metadata as Extract<CommentSlot, { kind: "comment" }>;
    expect(slot.outdated).toBe(true);
  });

  it("still marks a comment outdated when its content moved within the renamed file", () => {
    const moved = comment({
      file: "src/old-edit.txt",
      side: "additions",
      startLine: 90,
      endLine: 90,
    });
    const items = buildCommentItems(RENAMED, [moved], NO_UI, false);
    const edited = annotationsOfFile(items, "src/edit.txt");
    expect(edited).toHaveLength(1);
    const slot = edited[0]?.metadata as Extract<CommentSlot, { kind: "comment" }>;
    expect(slot.outdated).toBe(true);
  });

  it("gives a contested path to the file that carries it now, not the one renamed away from it", () => {
    // `src/shared.txt` was renamed to `src/moved.txt` while a new file took the name:
    // the comment belongs to the file that *is* `src/shared.txt` today.
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
    const authored = comment({ file: "src/shared.txt", startLine: 1, endLine: 1 });
    const items = buildCommentItems(parsePatch(collision, "test"), [authored], NO_UI, false);
    expect(annotationsOfFile(items, "src/moved.txt")).toHaveLength(0);
    expect(annotationsOfFile(items, "src/shared.txt")).toHaveLength(1);
  });

  it("stacks multiple comments anchored to the same line", () => {
    const first = comment({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    const second = comment({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", body: "and here" });
    const { annotations } = annotationsOf([first, second]);
    expect(annotations).toHaveLength(2);
  });

  it("bumps the item version when a comment body is edited", () => {
    const before = annotationsOf([comment()]).item?.version;
    const after = annotationsOf([comment({ body: "revised" })]).item?.version;
    expect(after).not.toBe(before);
  });

  it("bumps the item version when a comment opens for editing", () => {
    const target = comment();
    const idle = annotationsOf([target]).item?.version;
    const editing = annotationsOf([target], { editingId: target.id, draft: null }).item?.version;
    expect(editing).not.toBe(idle);
    const slot = annotationsOf([target], { editingId: target.id, draft: null }).annotations[0]
      ?.metadata as Extract<CommentSlot, { kind: "comment" }>;
    expect(slot.editing).toBe(true);
  });

  it("adds a draft annotation on its file at the picked line and bumps the version", () => {
    const idle = annotationsOf([]).item?.version;
    const ui: CommentUiState = {
      editingId: null,
      draft: {
        fileId: "src/foo.ts",
        anchor: { file: "src/foo.ts", side: "additions", startLine: 12, endLine: 12 },
      },
    };
    const { item, annotations } = annotationsOf([], ui);
    expect(annotations).toHaveLength(1);
    expect(annotations[0]?.lineNumber).toBe(12);
    expect(annotations[0]?.metadata.kind).toBe("draft");
    expect(item?.version).not.toBe(idle);
  });

  it("keeps a draft off files other than the one it was opened on", () => {
    const ui: CommentUiState = {
      editingId: null,
      draft: {
        fileId: "src/other.ts",
        anchor: { file: "src/other.ts", side: "additions", startLine: 3, endLine: 3 },
      },
    };
    const { annotations } = annotationsOf([], ui);
    expect(annotations).toHaveLength(0);
  });
});

describe("anchorFromLine", () => {
  it("makes a single-line anchor on the hovered side", () => {
    expect(anchorFromLine("src/foo.ts", 12, "deletions")).toEqual({
      file: "src/foo.ts",
      side: "deletions",
      startLine: 12,
      endLine: 12,
    });
  });

  it("rejects a non-positive line that could never be a real gutter row", () => {
    expect(anchorFromLine("src/foo.ts", 0, "additions")).toBeNull();
  });
});

describe("anchorFromRange", () => {
  it("spans startLine..endLine on the given side", () => {
    expect(anchorFromRange("src/foo.ts", 11, 13, "additions")).toEqual({
      file: "src/foo.ts",
      side: "additions",
      startLine: 11,
      endLine: 13,
    });
  });

  it("orders a bottom-up drag so startLine is always the lower line", () => {
    expect(anchorFromRange("src/foo.ts", 13, 11, "additions")).toEqual({
      file: "src/foo.ts",
      side: "additions",
      startLine: 11,
      endLine: 13,
    });
  });

  it("rejects a non-positive endpoint", () => {
    expect(anchorFromRange("src/foo.ts", 0, 13, "additions")).toBeNull();
  });
});

describe("selectionRange", () => {
  function selection(range: CodeViewLineSelection["range"]): CodeViewLineSelection {
    return { id: "src/foo.ts", range };
  }

  it("normalizes a multi-line single-side selection to a range on its file", () => {
    expect(
      selectionRange(selection({ start: 11, end: 13, side: "additions" }), "src/foo.ts"),
    ).toEqual({ startLine: 11, endLine: 13, side: "additions" });
  });

  it("orders a bottom-up drag, which Pierre reports as anchor → current", () => {
    expect(
      selectionRange(selection({ start: 13, end: 11, side: "additions" }), "src/foo.ts"),
    ).toEqual({ startLine: 11, endLine: 13, side: "additions" });
  });

  it("returns null for a selection on a different file", () => {
    expect(
      selectionRange(selection({ start: 11, end: 13, side: "additions" }), "src/other.ts"),
    ).toBeNull();
  });

  it("returns null for a collapsed single-line selection so a plain click keeps the hover path", () => {
    expect(
      selectionRange(selection({ start: 11, end: 11, side: "additions" }), "src/foo.ts"),
    ).toBeNull();
  });

  it("returns null for a cross-column selection with no single side to anchor on", () => {
    expect(
      selectionRange(
        selection({ start: 11, end: 13, side: "additions", endSide: "deletions" }),
        "src/foo.ts",
      ),
    ).toBeNull();
  });

  it("returns null for a sideless selection", () => {
    expect(selectionRange(selection({ start: 11, end: 13 }), "src/foo.ts")).toBeNull();
  });

  it("returns null when nothing is selected", () => {
    expect(selectionRange(null, "src/foo.ts")).toBeNull();
  });
});

describe("pickAddAnchor", () => {
  function selection(range: CodeViewLineSelection["range"]): CodeViewLineSelection {
    return { id: "src/foo.ts", range };
  }
  const dragged = selection({ start: 11, end: 13, side: "additions" });
  // The one hunk of `src/foo.ts`, covering additions 10..14 / deletions 10..12.
  const hunks = FILES[0]?.fileDiff.hunks ?? [];

  it("commits the drag range when the clicked + sits inside it", () => {
    const anchor = pickAddAnchor(
      "src/foo.ts",
      { lineNumber: 13, side: "additions" },
      dragged,
      hunks,
    );
    expect(anchor).toEqual({ file: "src/foo.ts", side: "additions", startLine: 11, endLine: 13 });
  });

  it("commits the drag range for a + placed from the selection (no hovered line)", () => {
    const anchor = pickAddAnchor("src/foo.ts", null, dragged, hunks);
    expect(anchor).toEqual({ file: "src/foo.ts", side: "additions", startLine: 11, endLine: 13 });
  });

  it("adds on the hovered line, not a stale selection, when the + is outside the range", () => {
    const anchor = pickAddAnchor(
      "src/foo.ts",
      { lineNumber: 30, side: "additions" },
      dragged,
      hunks,
    );
    expect(anchor).toEqual({ file: "src/foo.ts", side: "additions", startLine: 30, endLine: 30 });
  });

  it("ignores a selection on the opposite side of the hovered +", () => {
    const anchor = pickAddAnchor(
      "src/foo.ts",
      { lineNumber: 12, side: "deletions" },
      dragged,
      hunks,
    );
    expect(anchor).toEqual({ file: "src/foo.ts", side: "deletions", startLine: 12, endLine: 12 });
  });

  it("adds a single line when nothing is selected", () => {
    const anchor = pickAddAnchor("src/foo.ts", { lineNumber: 12, side: "additions" }, null, hunks);
    expect(anchor).toEqual({ file: "src/foo.ts", side: "additions", startLine: 12, endLine: 12 });
  });

  it("is null with neither a hovered line nor a usable selection", () => {
    expect(pickAddAnchor("src/foo.ts", null, null, hunks)).toBeNull();
  });

  it("commits the whole range when one hunk already covers it", () => {
    // The clamp is a ceiling, not a rewrite: a range wholly inside its hunk is
    // committed exactly as dragged, endpoints included.
    const wholeHunk = selection({ start: 10, end: 14, side: "additions" });
    const anchor = pickAddAnchor(
      "src/foo.ts",
      { lineNumber: 12, side: "additions" },
      wholeHunk,
      hunks,
    );
    expect(anchor).toEqual({ file: "src/foo.ts", side: "additions", startLine: 10, endLine: 14 });
  });
});

// A drag can cross a hunk boundary — hunks render contiguously, separated only by a
// visual row — and the range it yields spans collapsed context no single hunk covers,
// so `resolveAnchor` would call the new comment outdated the instant it was made. The
// committed anchor is clamped to the hunk the `+` was clicked in instead, and every
// case below is asserted to place against the very diff it was authored on.
describe("pickAddAnchor across a hunk boundary", () => {
  // Two hunks over additions 1..6 and 27..33, with 7..26 collapsed between them.
  const [twoHunks] = parsePatch(TWO_HUNKS_PATCH, "test");
  const path = "src/two-hunks.txt";
  const hunks = twoHunks?.fileDiff.hunks ?? [];
  // Dragged from the tail of the first hunk into the head of the second.
  const across: CodeViewLineSelection = {
    id: path,
    range: { start: 5, end: 28, side: "additions" },
  };

  /** Whether the anchor places on the diff it was just authored against. */
  function places(anchor: ReviewAnchor | null): boolean {
    return (
      anchor !== null &&
      resolveAnchor(anchor, { kind: "derived", file: twoHunks?.fileDiff ?? null }).status ===
        "placed"
    );
  }

  it("clamps to the first hunk when the + is clicked in it", () => {
    const anchor = pickAddAnchor(path, { lineNumber: 5, side: "additions" }, across, hunks);
    expect(anchor).toEqual({ file: path, side: "additions", startLine: 5, endLine: 6 });
    expect(places(anchor)).toBe(true);
  });

  it("clamps to the second hunk when the + is clicked in it", () => {
    const anchor = pickAddAnchor(path, { lineNumber: 28, side: "additions" }, across, hunks);
    expect(anchor).toEqual({ file: path, side: "additions", startLine: 27, endLine: 28 });
    expect(places(anchor)).toBe(true);
  });

  it("clamps to the hunk the range starts in for a + placed from the selection", () => {
    const anchor = pickAddAnchor(path, null, across, hunks);
    expect(anchor).toEqual({ file: path, side: "additions", startLine: 5, endLine: 6 });
    expect(places(anchor)).toBe(true);
  });

  it("clamps a deletions-side drag against the old-file hunk lines", () => {
    const onDeletions: CodeViewLineSelection = {
      id: path,
      range: { start: 4, end: 30, side: "deletions" },
    };
    const anchor = pickAddAnchor(path, { lineNumber: 29, side: "deletions" }, onDeletions, hunks);
    expect(anchor).toEqual({ file: path, side: "deletions", startLine: 27, endLine: 30 });
    expect(places(anchor)).toBe(true);
  });

  it("clamps a bottom-up drag, whose endpoints Pierre reports reversed", () => {
    // The same gesture run upwards: Pierre reports `anchor → current`, so the range
    // arrives as {start: 28, end: 5}. Ordered on the way in (`selectionRange`), it
    // clamps like any other — unordered, its bounds would compare backwards and the
    // whole cross-hunk range would sail through.
    const upwards: CodeViewLineSelection = {
      id: path,
      range: { start: 28, end: 5, side: "additions" },
    };
    expect(pickAddAnchor(path, { lineNumber: 28, side: "additions" }, upwards, hunks)).toEqual({
      file: path,
      side: "additions",
      startLine: 27,
      endLine: 28,
    });
    expect(pickAddAnchor(path, null, upwards, hunks)).toEqual({
      file: path,
      side: "additions",
      startLine: 5,
      endLine: 6,
    });
  });

  it("leaves the range as picked when the clicked line belongs to no hunk", () => {
    // Expanded context: Pierre reveals the collapsed lines but widens no hunk span, so
    // there is nothing to clamp to. The range stays as dragged rather than being moved
    // to a hunk the reader never pointed at — it does not place, but neither would a
    // single-line add on that same expanded line.
    const anchor = pickAddAnchor(path, { lineNumber: 15, side: "additions" }, across, hunks);
    expect(anchor).toEqual({ file: path, side: "additions", startLine: 5, endLine: 28 });
    expect(places(anchor)).toBe(false);
  });

  it("commits the range as picked for a file with no hunks at all", () => {
    expect(pickAddAnchor(path, { lineNumber: 5, side: "additions" }, across, [])).toEqual({
      file: path,
      side: "additions",
      startLine: 5,
      endLine: 28,
    });
  });

  it("clamps a drag that swallows a whole hunk down to the one it was committed from", () => {
    const wide: CodeViewLineSelection = {
      id: path,
      range: { start: 2, end: 33, side: "additions" },
    };
    const anchor = pickAddAnchor(path, { lineNumber: 30, side: "additions" }, wide, hunks);
    expect(anchor).toEqual({ file: path, side: "additions", startLine: 27, endLine: 33 });
    expect(places(anchor)).toBe(true);
  });
});

describe("unplaceableComments", () => {
  it("derives the comments whose file is absent from the diff, keeping present ones off the list", () => {
    const placed = comment({ file: "src/foo.ts" });
    const stranded = comment({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", file: "src/gone.ts" });
    expect(unplaceableComments(FILES, [placed, stranded])).toEqual([stranded]);
  });

  it("is empty when every comment's file is in the diff", () => {
    expect(unplaceableComments(FILES, [comment()])).toEqual([]);
  });

  it("does not strand a comment whose file was renamed out from under it", () => {
    const beforeRename = comment({ file: "src/old-edit.txt" });
    const beforePureRename = comment({
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      file: "src/old-pure.txt",
    });
    const stranded = comment({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", file: "src/gone.ts" });
    expect(unplaceableComments(RENAMED, [beforeRename, beforePureRename, stranded])).toEqual([
      stranded,
    ]);
  });
});
