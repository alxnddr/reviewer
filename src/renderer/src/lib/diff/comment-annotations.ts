import type {
  CodeViewDiffItem,
  CodeViewLineSelection,
  DiffLineAnnotation,
  Hunk,
} from "@pierre/diffs";
import type { Comment, ReviewAnchor, ReviewSide } from "../../../../shared/review";
import { filesByAnchorPath, type PatchFile } from "./patch";
import { hunkSpan, resolveAnchor } from "./anchor";

// Comments as Pierre line annotations: each comment is our React subtree slotted
// beneath its anchored diff line, never a restyle of Pierre's shadow DOM. The
// placement is the anchoring resolver run against the *loaded* diff. When the
// review pinned a frozen embedded patch the diff cannot have drifted, so every
// anchor places on its authored line; otherwise the diff was re-derived from git
// and anchors resolve positionally. A comment whose range drifted keeps its
// authored anchor and pins to the file header (`lineNumber: 0`); a comment whose
// file has vanished from the diff has no host item and is left in session state
// (never dropped), re-anchoring if its file returns. A rename is not a vanishing —
// the file answers to both its names (`filesByAnchorPath`), so a comment authored
// before it hosts on the renamed file. Curation UI state (which comment is being
// edited, an in-flight draft) rides in the annotation metadata so
// the item `version` fingerprint below sees it: CodeView reuses an item record and
// re-renders its slots only when the version changes (`syncItemRecord`), so every
// rendered change must bump it.

/** What one annotation carries into `renderAnnotation`. A `comment` slot is a
 * placed or outdated authored/manual comment; a `draft` slot is the not-yet-saved
 * new comment whose editor occupies the picked line. */
export type CommentSlot =
  | {
      kind: "comment";
      comment: Comment;
      outdated: boolean;
      editing: boolean;
      active: boolean;
      twoColumn: boolean;
    }
  | { kind: "draft"; anchor: ReviewAnchor; twoColumn: boolean };

/** Whether this file is actually painting two columns right now — which is not the
 * same question as "is split mode on". Pierre's own rule (`FileDiff`,
 * `applyPreNodeAttributes`) is
 *
 *     split: diffStyle === "unified" ? false : additions != null && deletions != null
 *
 * so a file with only one side — a new file, a deleted one — stays single-column
 * even in split mode, and a pure rename renders no code at all. The comment frame
 * sizes itself against the lane it sits beside, so it has to ask the same question
 * per file rather than reading the view's mode and getting it wrong on exactly the
 * files where the mode does not apply. */
function rendersTwoColumns(file: PatchFile, diffStyle: "split" | "unified"): boolean {
  if (diffStyle === "unified") {
    return false;
  }
  const type = file.fileDiff.type;
  return type === "change" || type === "rename-changed";
}

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
    // oxlint-disable-next-line unicorn/prefer-code-point -- FNV-1a folds fixed-width units and this loop is indexed by `input.length` (UTF-16 units); `codePointAt` would change every hash
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  // oxlint-disable-next-line unicorn/prefer-math-trunc -- `>>> 0` is the uint32 coercion FNV-1a ends on; `Math.trunc` would leave the sign bit and return a negative
  return hash >>> 0;
}

/** Fold everything the item renders into one number. Body is included so an edit
 * bumps the version; `editing`/draft are included so opening an editor does too.
 * `twoColumn` is in here because the comment frame sizes itself against the lane it
 * sits beside — it changes what the slot renders without changing a single comment,
 * and CodeView re-renders a reused item's slots only on a version change, so leaving
 * it out would strand every mounted card at its old width across a style switch.
 * Folding in the resolved per-file answer rather than the raw `diffStyle` also means
 * a file the switch cannot affect (a new or deleted one, always single-column) keeps
 * its version and is never needlessly re-rendered. */
function annotationsVersion(
  annotations: readonly DiffLineAnnotation<CommentSlot>[],
  /** Folding changes what the item renders more than any annotation can — the whole body
   * appears or goes away — and CodeView reconciles a reused item on this number alone, so
   * it has to be in here or a folded file would keep painting its code until something
   * else happened to bump the version. */
  collapsed: boolean,
): number {
  const parts = annotations.map((annotation) => {
    const slot = annotation.metadata;
    const wide = slot.twoColumn ? 1 : 0;
    return slot.kind === "comment"
      ? `c|${annotation.side}|${annotation.lineNumber}|${slot.comment.id}|${slot.outdated ? 1 : 0}|${slot.editing ? 1 : 0}|${slot.active ? 1 : 0}|${wide}|${slot.comment.body}`
      : `d|${annotation.side}|${annotation.lineNumber}|${slot.anchor.startLine}-${slot.anchor.endLine}|${wide}`;
  });
  return fnv1a(`${collapsed ? "1" : "0"}\n${parts.join("\n")}`);
}

/** Comments keyed by the *current* path of the file that carries them, so a caller
 * walking `files` finds each file's list under `file.path`. The authored
 * `comment.file` is resolved through `filesByAnchorPath`, so a comment written
 * before a rename groups onto the renamed file rather than a key nothing matches.
 * A comment whose path is in neither `path` nor `previousPath` has no file to group
 * under and is left out entirely — those are `unplaceableComments`. */
export function groupByFile(
  files: readonly PatchFile[],
  comments: readonly Comment[],
): Map<string, Comment[]> {
  const fileByPath = filesByAnchorPath(files);
  const byFile = new Map<string, Comment[]>();
  for (const comment of comments) {
    const file = fileByPath.get(comment.file);
    if (file === undefined) {
      continue;
    }
    const list = byFile.get(file.path);
    if (list === undefined) {
      byFile.set(file.path, [comment]);
    } else {
      list.push(comment);
    }
  }
  return byFile;
}

/** The diff items CodeView renders, each carrying its comments as annotations
 * placed by the resolver and a `version` that changes whenever its annotations
 * do. A comment whose file is not among `files` — under either of a renamed
 * file's names — produces no annotation: it is absent from the surface, not from
 * the review (kept in session state). */
export function buildCommentItems(
  files: readonly PatchFile[],
  comments: readonly Comment[],
  ui: CommentUiState,
  frozen: boolean,
  activeCommentId: string | null = null,
  /** Resolved per file into each slot's `twoColumn`, which is what the frame reads
   * for its measure. Typed as the bare union rather than the store's `DiffStyle` so
   * this stays a leaf of the lib layer; the store imports from here, not the reverse. */
  diffStyle: "split" | "unified" = "unified",
  /** Files whose body is folded away, leaving the header band alone. Owned by the session
   * (the reader's disclosures, plus the fold that rides on marking a file read), applied
   * here because the fold is a property of the rendered item. */
  collapsedPaths: ReadonlySet<string> = new Set(),
): CodeViewDiffItem<CommentSlot>[] {
  const byFile = groupByFile(files, comments);
  return files.map((file) => {
    const twoColumn = rendersTwoColumns(file, diffStyle);
    const collapsed = collapsedPaths.has(file.path);
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
          twoColumn,
        },
      });
    }
    if (ui.draft !== null && ui.draft.fileId === file.path) {
      annotations.push({
        side: ui.draft.anchor.side,
        lineNumber: ui.draft.anchor.startLine,
        metadata: { kind: "draft", anchor: ui.draft.anchor, twoColumn },
      });
    }
    return {
      id: file.path,
      type: "diff",
      fileDiff: file.fileDiff,
      annotations,
      collapsed,
      version: annotationsVersion(annotations, collapsed),
    };
  });
}

/** Comments whose file is absent from the loaded diff: with no host file item to
 * anchor to they never reach `buildCommentItems`' annotation list, so they stay
 * in session state (never dropped) but show nothing. Derived here so a surface
 * can list them. Resolved against the *full* loaded diff, never a soloed
 * subset — soloing a layer hides a file's comments from the surface but does not
 * make them unplaceable; they re-anchor the moment their file is back on screen.
 * A renamed file's old path counts as present (same `filesByAnchorPath` the
 * grouping uses), so a rename does not read as a vanished file. */
export function unplaceableComments(
  files: readonly PatchFile[],
  comments: readonly Comment[],
): Comment[] {
  const present = filesByAnchorPath(files);
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
 * active selection to commit a range add. Always ascending (`startLine ≤ endLine`),
 * which every consumer here relies on. */
export type SelectedRange = { startLine: number; endLine: number; side: ReviewSide };

/** Pierre's active line selection normalized to a single-side range on `fileId`,
 * or null when it is not one to add a range on. Null cases: a selection on a
 * different file; a collapsed single-line selection — what a plain click leaves
 * behind — so the deliberate drag gesture stays distinct from an ordinary click
 * (the hovered-line path owns single lines); and a sideless or cross-column
 * selection, which has no one side an anchor can live on.
 *
 * The endpoints are ordered here rather than downstream: Pierre reports the range as
 * `anchor → current` (`InteractionManager.buildSelectionRange`) and never sorts it, so
 * a bottom-up drag arrives with `start > end`. Left raw, that range is a line interval
 * nothing can test membership in — the `+` would read its own hovered line as outside
 * the drag, and the hunk clamp would compare against reversed bounds and pass a
 * cross-hunk range straight through. */
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
  return { startLine: Math.min(start, end), endLine: Math.max(start, end), side };
}

/** A hovered gutter line normalized to the anchor's side vocabulary. */
export type HoveredLine = { lineNumber: number; side: ReviewSide };

/** A picked range narrowed to the single hunk `line` sits in. Pierre's selection is
 * file line numbers over one continuously rendered file, and consecutive hunks are
 * separated by nothing but a visual separator row, so a drag from the tail of one hunk
 * into the head of the next yields a range that also swallows the collapsed context
 * between them — a range no single hunk covers, which `resolveAnchor` would call
 * outdated on the very diff it was just authored against. Clamping keeps the anchor on
 * what the reader actually dragged over: the selected lines of the hunk they committed
 * it from.
 *
 * `line` is always inside the range (the caller only clamps a range the click belongs
 * to), so once its hunk is found the clamp can only pull the endpoints inward past it —
 * the result still contains `line` and stays ascending and non-empty.
 *
 * A line no same-side hunk holds is expanded context (Pierre tracks an expansion apart
 * from the hunk metadata, so the extra rows widen no span): there is no hunk to clamp
 * to, and no anchor places on such a line anyway, so the range is left as picked rather
 * than moved somewhere the reader never pointed.
 *
 * NOTE (034): this walks the hunk list with a different question than `coversRange` —
 * "which hunk holds this line" rather than "does one hunk cover this range" — and shares
 * only `hunkSpan` with it. A unification has to keep both. */
function clampToHunk(range: SelectedRange, line: number, hunks: readonly Hunk[]): SelectedRange {
  const holder = hunks.find((hunk) => {
    const span = hunkSpan(hunk, range.side);
    return span.start <= line && line <= span.end;
  });
  if (holder === undefined) {
    return range;
  }
  const span = hunkSpan(holder, range.side);
  return {
    ...range,
    startLine: Math.max(range.startLine, span.start),
    endLine: Math.min(range.endLine, span.end),
  };
}

/** The anchor a gutter `+` click commits: the active drag range when the click
 * belongs to it — a `+` placed from the selection reports no hovered line, or the
 * hovered line falls inside the range on the same side — else the single hovered
 * line. A stale selection under an unrelated line is ignored, so that `+` adds on
 * its own line rather than a range the reader is no longer pointing at. A committed
 * range is clamped to the hunk it was committed from (`clampToHunk`), so a range picked
 * off hunk lines never reaches further than the one hunk that can carry it. Null when
 * neither yields a valid anchor. */
export function pickAddAnchor(
  fileId: string,
  hovered: HoveredLine | null,
  selection: CodeViewLineSelection | null,
  /** The file's hunks, which bound how far a committed range may reach (`clampToHunk`).
   * Empty for a file the caller has no hunks for, which commits the range as picked. */
  hunks: readonly Hunk[],
): ReviewAnchor | null {
  const range = selectionRange(selection, fileId);
  const clickBelongsToRange =
    range !== null &&
    (hovered === null ||
      (hovered.side === range.side &&
        hovered.lineNumber >= range.startLine &&
        hovered.lineNumber <= range.endLine));
  if (range !== null && clickBelongsToRange) {
    // The `+` clicked from the selection itself reports no hovered line; the hunk it
    // was committed from is then the one the range starts in.
    const clamped = clampToHunk(range, hovered?.lineNumber ?? range.startLine, hunks);
    return anchorFromRange(fileId, clamped.startLine, clamped.endLine, clamped.side);
  }
  if (hovered === null) {
    return null;
  }
  return anchorFromLine(fileId, hovered.lineNumber, hovered.side);
}
