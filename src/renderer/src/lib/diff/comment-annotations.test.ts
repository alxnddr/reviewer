import { describe, expect, it } from "vitest";
import type { CodeViewLineSelection } from "@pierre/diffs";
import type { Comment } from "../../../../shared/review";
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

  it("commits the drag range when the clicked + sits inside it", () => {
    const anchor = pickAddAnchor("src/foo.ts", { lineNumber: 13, side: "additions" }, dragged);
    expect(anchor).toEqual({ file: "src/foo.ts", side: "additions", startLine: 11, endLine: 13 });
  });

  it("commits the drag range for a + placed from the selection (no hovered line)", () => {
    const anchor = pickAddAnchor("src/foo.ts", null, dragged);
    expect(anchor).toEqual({ file: "src/foo.ts", side: "additions", startLine: 11, endLine: 13 });
  });

  it("adds on the hovered line, not a stale selection, when the + is outside the range", () => {
    const anchor = pickAddAnchor("src/foo.ts", { lineNumber: 30, side: "additions" }, dragged);
    expect(anchor).toEqual({ file: "src/foo.ts", side: "additions", startLine: 30, endLine: 30 });
  });

  it("ignores a selection on the opposite side of the hovered +", () => {
    const anchor = pickAddAnchor("src/foo.ts", { lineNumber: 12, side: "deletions" }, dragged);
    expect(anchor).toEqual({ file: "src/foo.ts", side: "deletions", startLine: 12, endLine: 12 });
  });

  it("adds a single line when nothing is selected", () => {
    const anchor = pickAddAnchor("src/foo.ts", { lineNumber: 12, side: "additions" }, null);
    expect(anchor).toEqual({ file: "src/foo.ts", side: "additions", startLine: 12, endLine: 12 });
  });

  it("is null with neither a hovered line nor a usable selection", () => {
    expect(pickAddAnchor("src/foo.ts", null, null)).toBeNull();
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
});
