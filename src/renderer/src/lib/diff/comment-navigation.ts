import type { Comment } from "../../../../shared/review";
import { filesByAnchorPath, type PatchFile } from "../../../../shared/diff/patch";
import { resolveAnchor } from "../../../../shared/diff/anchor";

// The navigation view over a session's comments: every comment resolved to where
// it sits on the *loaded* diff and ordered exactly as the reader meets it scrolling
// top-to-bottom. The one source the sidebar list, the floating counter, and the
// store's `stepComment` all read, so the panel's order, the `i/N` position, and the
// `n`/`p` walk can never disagree. Placement reuses `resolveAnchor` — the same
// resolver `buildCommentItems` renders through — so a comment's nav status matches
// what it looks like on the surface: placed on its line, outdated at the file
// header, or unplaceable (its file is absent from the diff, so it has no host line).

/** A comment resolved for navigation. `line` is the placed line for a `placed`
 * entry; null for `outdated` (renders at the file header) and `unplaceable` (no
 * host line at all). `path` is the file it actually hosts on, under the name the
 * loaded diff carries — the diff item's id, which is what a scroll target and a
 * group heading need. It differs from `comment.file` only for a comment authored
 * before its file was renamed; an unplaceable comment hosts nowhere, so it keeps
 * its authored path. */
export type CommentNavEntry = {
  comment: Comment;
  path: string;
  status: "placed" | "outdated" | "unplaceable";
  line: number | null;
};

/** Every comment placed against the loaded diff, in reading order. Placeable
 * comments (file present) come first, grouped by the file's diff order; within a
 * file the header-pinned outdated ones lead, then placed ones by resolved line —
 * matching the top-to-bottom order a reader scrolls past. Comments whose file is
 * absent from the diff are unplaceable: they have no line to scroll to, so they
 * trail the list (grouped by path) for the panel to show and the keyboard walk to
 * skip — a renamed file is not absent, since it answers to its old path too, so its
 * comments stay in the walk. A frozen review places every anchor on its authored
 * line (the diff cannot have drifted); otherwise placement is positional against the
 * re-derived diff. */
export function orderedComments(
  files: readonly PatchFile[],
  comments: readonly Comment[],
  frozen: boolean,
): CommentNavEntry[] {
  const fileByPath = filesByAnchorPath(files);
  const fileIndex = new Map<string, number>();
  files.forEach((file, index) => {
    fileIndex.set(file.path, index);
  });

  const placeable: CommentNavEntry[] = [];
  const unplaceable: CommentNavEntry[] = [];
  for (const comment of comments) {
    const file = fileByPath.get(comment.file);
    if (file === undefined) {
      unplaceable.push({ comment, path: comment.file, status: "unplaceable", line: null });
      continue;
    }
    const resolution = resolveAnchor(
      comment,
      frozen ? { kind: "frozen" } : { kind: "derived", file: file.fileDiff },
    );
    placeable.push(
      resolution.status === "placed"
        ? { comment, path: file.path, status: "placed", line: resolution.line }
        : { comment, path: file.path, status: "outdated", line: null },
    );
  }

  // By the *host* file's diff position, not the authored path's — a comment written
  // before a rename names a path the diff no longer lists, and taking its order from
  // that path would sort it as though it led the diff. Within a file the header-pinned
  // outdated comments lead (rank 0), then placed by resolved line; startLine tie-breaks
  // a stack sharing one line so the order is stable across renders.
  placeable.sort((a, b) => {
    const fileDelta = (fileIndex.get(a.path) ?? 0) - (fileIndex.get(b.path) ?? 0);
    if (fileDelta !== 0) return fileDelta;
    const rankDelta = (a.status === "outdated" ? 0 : 1) - (b.status === "outdated" ? 0 : 1);
    if (rankDelta !== 0) return rankDelta;
    const lineDelta = (a.line ?? 0) - (b.line ?? 0);
    if (lineDelta !== 0) return lineDelta;
    return a.comment.startLine - b.comment.startLine;
  });
  // Stranded comments have no diff order to inherit; group them by path so the same
  // file's strays stay together, ordered by line within it.
  unplaceable.sort((a, b) => {
    if (a.comment.file !== b.comment.file) {
      return a.comment.file < b.comment.file ? -1 : 1;
    }
    return a.comment.startLine - b.comment.startLine;
  });

  return [...placeable, ...unplaceable];
}

/** The entries `n`/`p` can reach: everything with a host line on the surface
 * (placed on its line, outdated at its file header). Unplaceable comments have no
 * line to scroll to, so keyboard stepping skips them — the panel still lists them. */
export function navigableEntries(entries: readonly CommentNavEntry[]): CommentNavEntry[] {
  return entries.filter((entry) => entry.status !== "unplaceable");
}

/** The index of a comment id within an ordered list, or -1. A dropped/renamed
 * target (stale `activeCommentId`) resolves to -1, which the counter reads as
 * "nothing to show" rather than a wrong position. */
export function indexOfComment(entries: readonly CommentNavEntry[], commentId: string): number {
  return entries.findIndex((entry) => entry.comment.id === commentId);
}

/** How many comments each file carries, for the tree's per-file count badges — keyed
 * the way the tree keys its rows, by the path the loaded diff carries the file under.
 * A comment authored before a rename counts against the renamed file, which is the row
 * its card is on; one whose file is in the diff under neither name falls back to its
 * authored path, so a stranded comment still counts against the file it belonged to. */
export function commentCountsByFile(
  files: readonly PatchFile[],
  comments: readonly Comment[],
): Map<string, number> {
  const fileByPath = filesByAnchorPath(files);
  const counts = new Map<string, number>();
  for (const comment of comments) {
    const path = fileByPath.get(comment.file)?.path ?? comment.file;
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  return counts;
}
