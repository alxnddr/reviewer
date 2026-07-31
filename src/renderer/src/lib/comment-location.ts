// How a comment names where it lives. The body itself is prose in the app's one
// markdown tier (`shared/markdown.ts`), rendered by `Markdown`; all that is left here is
// the mono anchor string a surface shows when the comment is off its line.

import type { Comment } from "../../../shared/review";

/** The fields a comment's location string reads — every comment and the wire
 * comment share this anchor shape, so the helper takes just what it uses. */
export type CommentLocation = Pick<Comment, "file" | "startLine" | "endLine">;

/** A comment's authored location as `path:Ln`, or `path:Ln-Lm` for a range — the
 * mono machine-text ref shown when a comment sits off its line: outdated (pinned
 * to the file header) or unplaceable (its file dropped out of the diff). */
export function commentLocation(comment: CommentLocation): string {
  return comment.startLine === comment.endLine
    ? `${comment.file}:${comment.startLine}`
    : `${comment.file}:${comment.startLine}-${comment.endLine}`;
}
