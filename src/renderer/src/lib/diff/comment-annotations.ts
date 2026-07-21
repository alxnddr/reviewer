import type { CodeViewDiffItem, CodeViewLineSelection, DiffLineAnnotation } from "@pierre/diffs";
import type { Comment, ReviewAnchor, ReviewSide } from "../../../../shared/review";
import type { PatchFile } from "./patch";
import { resolveAnchor } from "./anchor";

// Comments as Pierre line annotations: each comment is our React subtree slotted
// beneath its anchored diff line, never a restyle of Pierre's shadow DOM. The
// placement is the anchoring resolver run against the *loaded* diff. When the
// review pinned a frozen embedded patch the diff cannot have drifted, so every
// anchor places on its authored line; otherwise the diff was re-derived from git
// and anchors resolve positionally. A comment whose range drifted keeps its
// authored anchor and pins to the file header (`lineNumber: 0`); a comment whose
// file has vanished from the diff has no host item and is left in session state
// (never dropped), re-anchoring if its file returns. Curation UI state (which
// comment is being edited, an in-flight draft) rides in the annotation metadata so
// the item `version` fingerprint below sees it: CodeView reuses an item record and
// re-renders its slots only when the version changes (`syncItemRecord`), so every
// rendered change must bump it.

/** What one annotation carries into `renderAnnotation`. A `comment` slot is a
 * placed or outdated authored/manual comment; a `draft` slot is the not-yet-saved
 * new comment whose editor occupies the picked line. */
export type CommentSlot =
  | { kind: "comment"; comment: Comment; outdated: boolean; editing: boolean; active: boolean }
  | { kind: "draft"; anchor: ReviewAnchor };

/** An in-flight new comment: the file it was opened on and the picked range. */
export type CommentDraft = { fileId: string; anchor: ReviewAnchor };

/** The curation UI state DiffView folds into the items so a version bump follows
 * every visible change (open editor, discard, start a draft). */
export type CommentUiState = { editingId: string | null; draft: CommentDraft | null };

/** 32-bit FNV-1a over a content string. A pure per-item `version`: any change to
 * the rendered annotation set (a placed line, an outdated flag, an edited body,
 * an opened editor, a draft) changes the string and therefore the number, which
 * is the signal CodeView reconciles on. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Fold everything the item renders into one number. Body is included so an edit
 * bumps the version; `editing`/draft are included so opening an editor does too. */
function annotationsVersion(annotations: readonly DiffLineAnnotation<CommentSlot>[]): number {
  const parts = annotations.map((annotation) => {
    const slot = annotation.metadata;
    return slot.kind === "comment"
      ? `c|${annotation.side}|${annotation.lineNumber}|${slot.comment.id}|${slot.outdated ? 1 : 0}|${slot.editing ? 1 : 0}|${slot.active ? 1 : 0}|${slot.comment.body}`
      : `d|${annotation.side}|${annotation.lineNumber}|${slot.anchor.startLine}-${slot.anchor.endLine}`;
  });
  return fnv1a(parts.join("\n"));
}

export function groupByFile(comments: readonly Comment[]): Map<string, Comment[]> {
  const byFile = new Map<string, Comment[]>();
  for (const comment of comments) {
    const list = byFile.get(comment.file);
    if (list === undefined) {
      byFile.set(comment.file, [comment]);
    } else {
      list.push(comment);
    }
  }
  return byFile;
}

/** The diff items CodeView renders, each carrying its comments as annotations
 * placed by the resolver and a `version` that changes whenever its annotations
 * do. A comment whose file is not among `files` produces no annotation — it is
 * absent from the surface, not from the review (kept in session state). */
export function buildCommentItems(
  files: readonly PatchFile[],
  comments: readonly Comment[],
  ui: CommentUiState,
  frozen: boolean,
  activeCommentId: string | null = null,
): CodeViewDiffItem<CommentSlot>[] {
  const byFile = groupByFile(comments);
  return files.map((file) => {
    const annotations: DiffLineAnnotation<CommentSlot>[] = [];
    for (const comment of byFile.get(file.path) ?? []) {
      const resolution = resolveAnchor(
        comment,
        frozen ? { kind: "frozen" } : { kind: "derived", file: file.fileDiff },
      );
      annotations.push({
        side: comment.side,
        lineNumber: resolution.status === "placed" ? resolution.line : 0,
        metadata: {
          kind: "comment",
          comment,
          outdated: resolution.status === "outdated",
          editing: ui.editingId === comment.id,
          active: activeCommentId === comment.id,
        },
      });
    }
    if (ui.draft !== null && ui.draft.fileId === file.path) {
      annotations.push({
        side: ui.draft.anchor.side,
        lineNumber: ui.draft.anchor.startLine,
        metadata: { kind: "draft", anchor: ui.draft.anchor },
      });
    }
    return {
      id: file.path,
      type: "diff",
      fileDiff: file.fileDiff,
      annotations,
      version: annotationsVersion(annotations),
    };
  });
}

/** Comments whose file is absent from the loaded diff: with no host file item to
 * anchor to they never reach `buildCommentItems`' annotation list, so they stay
 * in session state (never dropped) but show nothing. Derived here so a surface
 * can list them. Resolved against the *full* loaded diff, never a soloed
 * subset — soloing a layer hides a file's comments from the surface but does not
 * make them unplaceable; they re-anchor the moment their file is back on screen. */
export function unplaceableComments(
  files: readonly PatchFile[],
  comments: readonly Comment[],
): Comment[] {
  const present = new Set(files.map((file) => file.path));
  return comments.filter((comment) => !present.has(comment.file));
}

/** A hovered gutter line (the add affordance's target) → a single-line authored
 * anchor. Returns null for a non-positive line — never a real gutter row — so a
 * bad line can't become an anchor the `Comment` schema would reject. */
export function anchorFromLine(
  fileId: string,
  lineNumber: number,
  side: ReviewSide,
): ReviewAnchor | null {
  if (lineNumber < 1) {
    return null;
  }
  return { file: fileId, side, startLine: lineNumber, endLine: lineNumber };
}

/** A selected line range (the deliberate range-add gesture's target) → a
 * multi-line authored anchor on one side — `anchorFromLine`'s sibling. Orders the
 * endpoints so a bottom-up drag still yields `startLine ≤ endLine`, and rejects a
 * non-positive endpoint the same way, so a bad range can't become an anchor the
 * `Comment` schema would reject. */
export function anchorFromRange(
  fileId: string,
  startLine: number,
  endLine: number,
  side: ReviewSide,
): ReviewAnchor | null {
  if (startLine < 1 || endLine < 1) {
    return null;
  }
  return {
    file: fileId,
    side,
    startLine: Math.min(startLine, endLine),
    endLine: Math.max(startLine, endLine),
  };
}

/** The picked line range on one file: what the gutter `+` reads from Pierre's
 * active selection to commit a range add. */
export type SelectedRange = { startLine: number; endLine: number; side: ReviewSide };

/** Pierre's active line selection normalized to a single-side range on `fileId`,
 * or null when it is not one to add a range on. Null cases: a selection on a
 * different file; a collapsed single-line selection — what a plain click leaves
 * behind — so the deliberate drag gesture stays distinct from an ordinary click
 * (the hovered-line path owns single lines); and a sideless or cross-column
 * selection, which has no one side an anchor can live on. */
export function selectionRange(
  selection: CodeViewLineSelection | null,
  fileId: string,
): SelectedRange | null {
  if (selection === null || selection.id !== fileId) {
    return null;
  }
  const { start, end, side, endSide } = selection.range;
  if (start === end) {
    return null;
  }
  if (side !== "additions" && side !== "deletions") {
    return null;
  }
  if (endSide !== undefined && endSide !== side) {
    return null;
  }
  return { startLine: start, endLine: end, side };
}

/** A hovered gutter line normalized to the anchor's side vocabulary. */
export type HoveredLine = { lineNumber: number; side: ReviewSide };

/** The anchor a gutter `+` click commits: the active drag range when the click
 * belongs to it — a `+` placed from the selection reports no hovered line, or the
 * hovered line falls inside the range on the same side — else the single hovered
 * line. A stale selection under an unrelated line is ignored, so that `+` adds on
 * its own line rather than a range the reader is no longer pointing at. Null when
 * neither yields a valid anchor. */
export function pickAddAnchor(
  fileId: string,
  hovered: HoveredLine | null,
  selection: CodeViewLineSelection | null,
): ReviewAnchor | null {
  const range = selectionRange(selection, fileId);
  const clickBelongsToRange =
    range !== null &&
    (hovered === null ||
      (hovered.side === range.side &&
        hovered.lineNumber >= range.startLine &&
        hovered.lineNumber <= range.endLine));
  if (range !== null && clickBelongsToRange) {
    return anchorFromRange(fileId, range.startLine, range.endLine, range.side);
  }
  if (hovered === null) {
    return null;
  }
  return anchorFromLine(fileId, hovered.lineNumber, hovered.side);
}
