import { type ReactElement } from "react";
import { segmentInlineCode } from "@/lib/comment-body";

type CommentBodyProps = { body: string };

/** A comment body: a human sentence in Geist sans at the app's reading register,
 * whose inline `code`/path/SHA runs stay mono per the per-element type rule.
 * Shared by every comment surface so the split renders identically. */
export function CommentBody({ body }: CommentBodyProps): ReactElement {
  return (
    <p className="text-base break-words whitespace-pre-wrap text-foreground select-text">
      {segmentInlineCode(body).map((segment, index) =>
        segment.code ? (
          <code key={index} className="font-mono">
            {segment.text}
          </code>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </p>
  );
}
