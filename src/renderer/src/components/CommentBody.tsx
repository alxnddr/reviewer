import { type ReactElement } from "react";
import { Markdown } from "@/components/Markdown";

type CommentBodyProps = { body: string };

/** A comment body: prose in Geist sans at the app's reading register, in the same
 * markdown grammar the overview and a layer description take — `Markdown` renders it,
 * so a paragraph, a list, a bolded `**[BUG]**` and a fenced snippet look the same on a
 * comment card as they do in the tour doc, and a grammar added there arrives here for
 * free. Shared by every comment surface (the card in the diff, a stranded one) so the
 * split renders identically.
 *
 * No `links`: a comment is written against one line, not a navigable set — see
 * `Markdown`. Its inline `code`/path/SHA runs still take the chip (`InlineCode`), a
 * faint tint and a tight radius. On a card sitting *inside* a syntax-highlighted diff,
 * a font switch alone is far too quiet a signal: the eye is already saturated with
 * mono, so `resolveAnchor` set only in Geist Mono reads as prose that happens to look
 * odd. The chip makes the identifier a discrete object in the sentence, which is what
 * the reader is scanning for.
 *
 * `space-y-2` rather than the doc's `space-y-3`: a card is three lines in a diff, not a
 * page, so its blocks sit a step closer than the same blocks do at reading width. */
export function CommentBody({ body }: CommentBodyProps): ReactElement {
  return (
    <Markdown text={body} className="space-y-2 text-base break-words text-foreground select-text" />
  );
}
