import { type ReactElement } from "react";
import { segmentInlineCode } from "@/lib/comment-body";
import { InlineCode } from "@/components/InlineCode";

type CommentBodyProps = { body: string };

/** A comment body: a human sentence in Geist sans at the app's reading register,
 * whose inline `code`/path/SHA runs stay mono per the per-element type rule.
 * Shared by every comment surface so the split renders identically.
 *
 * A mono run also takes a chip (`InlineCode`) — a faint tint and a tight radius. On a
 * card sitting *inside* a syntax-highlighted diff, a font switch alone is far too quiet
 * a signal: the eye is already saturated with mono, so `resolveAnchor` set only in
 * Geist Mono reads as prose that happens to look odd. The chip makes the identifier a
 * discrete object in the sentence, which is what the reader is scanning for. */
export function CommentBody({ body }: CommentBodyProps): ReactElement {
  return (
    <p className="text-base break-words whitespace-pre-wrap text-foreground select-text">
      {segmentInlineCode(body).map((segment, index) =>
        segment.code ? (
          <InlineCode key={index}>{segment.text}</InlineCode>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </p>
  );
}
