// A comment body is a human sentence (Geist sans) that may name machine tokens
// inline — `a symbol`, a `path/to/file`, a SHA — which the per-element type rule
// renders in Geist Mono. This is the minimal inline-code split that rule needs:
// backtick-delimited spans become mono, everything else stays sans — deliberately
// just the inline-code tier, not full Markdown, so a comment reads correctly the
// moment it renders.

import type { Comment } from "../../../shared/review";

export type BodySegment = { code: boolean; text: string };

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

const INLINE_CODE = /`([^`]+)`/g;

/** Split a body into alternating sans / mono runs on backtick pairs. An unpaired
 * trailing backtick is left as literal text (it opens no span), matching how an
 * unterminated inline span reads. */
export function segmentInlineCode(body: string): BodySegment[] {
  const segments: BodySegment[] = [];
  let cursor = 0;
  for (const match of body.matchAll(INLINE_CODE)) {
    const start = match.index;
    if (start > cursor) {
      segments.push({ code: false, text: body.slice(cursor, start) });
    }
    segments.push({ code: true, text: match[1] ?? "" });
    cursor = start + match[0].length;
  }
  if (cursor < body.length) {
    segments.push({ code: false, text: body.slice(cursor) });
  }
  return segments;
}
