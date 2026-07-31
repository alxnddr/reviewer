import type { FileDiffMetadata } from "@pierre/diffs";
import type { ReviewAnchor } from "../../../../shared/review";
import { walkFileLines } from "../../../../shared/diff/walk";

// The few lines of real code an anchor points at, lifted straight out of the parsed
// diff — the taste of a layer the overview embeds beside its file list, so a reader
// can judge a chapter without opening it. Pure and render-free: it reads the same
// `FileDiffMetadata` the diff surface renders (never a re-parse of patch bytes), and
// returns plain text rows the caller styles. Deliberately not a diff view: no syntax
// highlighting, no hunk chrome, no expansion — those belong to the code view the card
// navigates to.

export type SnippetLineKind = "addition" | "deletion" | "context";

/** One row: its file line number on the anchor's side, its change kind, and its text. */
export type SnippetLine = {
  kind: SnippetLineKind;
  line: number;
  text: string;
};

/** The rows an anchor resolves to, plus however many its range covers that the cap cut
 * — surfaced so the card can say "+12 more lines" rather than silently truncating. */
export type DiffSnippet = {
  lines: SnippetLine[];
  hidden: number;
};

/** Pierre's line arrays keep each line's own terminator; a preview row renders one line,
 * so the terminator is stripped here rather than leaked into every consumer's markup. */
function lineText(raw: string | undefined): string {
  return (raw ?? "").replace(/\r?\n$/u, "");
}

/** One side of the shared hunk walk (`shared/diff/walk.ts`): `visit` sees each of this
 * side's lines with its number and text, in file order. The other side's change lines live
 * at their own numbers and are not part of these coordinates, so they are filtered out;
 * a context line the walk emits on both sides arrives here in this side's own numbering.
 * `additionLines`/`deletionLines` hold the raw text at the index the walk carries.
 *
 * `visit` returns false to stop the walk — the caller stops once it is past the range it
 * wants, so a snippet of a 3-line anchor never walks a 4000-line file to its end. */
function walkSide(
  file: FileDiffMetadata,
  side: ReviewAnchor["side"],
  visit: (line: SnippetLine) => boolean,
): void {
  const texts = side === "additions" ? file.additionLines : file.deletionLines;
  walkFileLines(file, (line) => {
    if (line.side !== side) {
      return true;
    }
    return visit({ kind: line.kind, line: line.lineNumber, text: lineText(texts[line.index]) });
  });
}

/** The anchor's own lines, capped at `maxLines`. Null when the range resolves to nothing
 * in this diff — a drifted anchor, or a file the loaded diff no longer carries — so the
 * caller renders no preview rather than an empty frame. */
export function snippetForAnchor(
  file: FileDiffMetadata,
  anchor: ReviewAnchor,
  maxLines: number,
): DiffSnippet | null {
  const lines: SnippetLine[] = [];
  let matched = 0;
  walkSide(file, anchor.side, (line) => {
    if (line.line > anchor.endLine) {
      return false;
    }
    if (line.line >= anchor.startLine) {
      matched += 1;
      if (lines.length < maxLines) {
        lines.push(line);
      }
    }
    return true;
  });
  return lines.length === 0 ? null : { lines, hidden: matched - lines.length };
}
