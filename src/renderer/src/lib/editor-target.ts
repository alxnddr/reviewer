import type { FileDiffMetadata } from "@pierre/diffs";
import type { EditorChoice } from "../../../shared/contracts";
import { hunkSpan, walkFileLines } from "../../../shared/diff/walk";
import { filesByAnchorPath, type PatchFile } from "../../../shared/diff/patch";
import type { Comment, ReviewSide } from "../../../shared/review";

// What Open in Editor opens, decided without a DOM: which file, and which line of the file *on
// disk* — the new side of the diff, because that is the file the checkout has. Both hosts of the
// control (the file header, the E key) read their answer from here, so the two cannot disagree
// about where a deletions-side anchor lands. The third door, the title bar's repository button,
// names no file at all and takes only `repoEditorAvailability` below.
//
// The deletions-side translation rides the one walk (`shared/diff/walk.ts`) rather than
// re-deriving hunk arithmetic: the walk emits a context row once per side, deletions first, and a
// change block's deletions before its additions, so the additions-side row that follows a
// deletions-side line is where that line sits in the new file. A deleted run has no row of its
// own there; it sits where the next new-file line begins, which is the additions line the walk
// emits next — or one past the last it emitted, when the hunk ends on the deletion.

/** The new-file line for a line on either side of the diff, or null when no hunk of `file`
 * covers it (an outdated anchor, a line past the diff). Additions-side lines are their own
 * answer; a deletions-side line is translated by the walk as described above. */
export function newFileLine(file: FileDiffMetadata, side: ReviewSide, line: number): number | null {
  if (side === "additions") {
    return line;
  }
  const hunk = file.hunks.find((candidate) => {
    const span = hunkSpan(candidate, "deletions");
    return span.start <= line && line <= span.end;
  });
  if (hunk === undefined) {
    return null;
  }
  // The offset of the target inside its deletions-side run, once seen: 0 for a deleted line
  // (the whole run sits at one new-file line), its position for a context line (the additions
  // run that follows is the same rows, in order).
  let offset: number | null = null;
  let run = 0;
  let lastAddition = hunk.additionStart - 1;
  let answer: number | null = null;
  walkFileLines({ ...file, hunks: [hunk] }, (walked) => {
    if (walked.side === "deletions") {
      if (offset === null && walked.lineNumber === line) {
        offset = walked.kind === "context" ? run : 0;
      }
      run += 1;
      return true;
    }
    run = 0;
    if (offset !== null) {
      answer = walked.lineNumber + offset;
      return false;
    }
    lastAddition = walked.lineNumber;
    return true;
  });
  if (answer !== null) {
    return answer;
  }
  // A hunk that deletes a whole file starts its new side at 0 (`+0,0`); line 1 is the floor
  // the request schema accepts and the only line such a file could have.
  return offset === null ? null : Math.max(1, lastAddition + 1);
}

/** Where opening a whole file lands: its first changed or context line, in new-file terms, or
 * null for a file with nothing to land on (a binary change, a pure rename) — the file then
 * opens without a line. */
export function fileOpenLine(file: PatchFile): number | null {
  let first: number | null = null;
  walkFileLines(file.fileDiff, (walked) => {
    first = newFileLine(file.fileDiff, walked.side, walked.lineNumber);
    return false;
  });
  return first;
}

/** The file a path names in the loaded diff — under its new name or, for an anchor authored
 * before a rename, its old one — or null when the diff has no such file. */
export function fileForPath(files: readonly PatchFile[], path: string): PatchFile | null {
  return filesByAnchorPath(files).get(path) ?? null;
}

/** Why a control cannot open right now, or `ready`. Decided here so the header button, the
 * repository button and the key all read one rule; the sentence for each is the control's. */
export type EditorAvailability = "ready" | "frozen" | "noEditor" | "deleted";

/** The two reasons that are about the *session* rather than about a file: no checkout behind
 * this review, or no editor chosen. Split out because the repository control can only ever be
 * refused for one of these — there is no fourth answer to invent a sentence for — and because
 * it is main's own order (`open-in-editor.ts` asks live? then editor?), which the two halves
 * must not come to disagree about. */
export function repoEditorAvailability(input: {
  editor: EditorChoice;
  frozen: boolean;
}): Exclude<EditorAvailability, "deleted"> {
  if (input.frozen) {
    return "frozen";
  }
  return input.editor === "none" ? "noEditor" : "ready";
}

export function editorAvailability(input: {
  editor: EditorChoice;
  frozen: boolean;
  file: PatchFile | null;
}): EditorAvailability {
  const session = repoEditorAvailability(input);
  if (session !== "ready") {
    return session;
  }
  return input.file?.status === "deleted" ? "deleted" : "ready";
}

/** A repo-relative file and the new-file line to open it at. `line` is absent, never
 * undefined, so it spreads straight into an `EditorOpenRequest`. */
export type EditorTarget = { path: string; line?: number };

/** A target from a file and a place in it: the anchor's new-file line, or the file's opening
 * line when no anchor is given, and the file alone when neither resolves. The path is the
 * file's current name — the one the checkout has — even for an anchor that named the old one. */
export function editorTargetFor(
  file: PatchFile,
  anchor: { side: ReviewSide; line: number } | null,
): EditorTarget {
  const line =
    anchor === null ? fileOpenLine(file) : newFileLine(file.fileDiff, anchor.side, anchor.line);
  return line === null ? { path: file.path } : { path: file.path, line };
}

/** What the E key needs from the session: the focus it acts on and the diff it reads. */
export type EditorTargetView = {
  files: readonly PatchFile[] | null;
  selectedFilePath: string | null;
  activeCommentId: string | null;
  comments: readonly Comment[];
};

/** What the E key opens: the focused comment's line while one is focused, else the focused
 * file's opening line; null when there is nothing focused or no diff loaded. The key does not
 * check availability — main answers a frozen session or a missing editor with the same typed
 * refusal the buttons pre-empt, and the banner explains it. */
export function editorRequestFor(view: EditorTargetView): EditorTarget | null {
  if (view.files === null) {
    return null;
  }
  const comment =
    view.activeCommentId === null
      ? undefined
      : view.comments.find((candidate) => candidate.id === view.activeCommentId);
  if (comment !== undefined) {
    const file = fileForPath(view.files, comment.file);
    return file === null
      ? null
      : editorTargetFor(file, { side: comment.side, line: comment.startLine });
  }
  if (view.selectedFilePath === null) {
    return null;
  }
  const file = fileForPath(view.files, view.selectedFilePath);
  return file === null ? null : editorTargetFor(file, null);
}
