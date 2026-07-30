import type { FileDiffMetadata } from "@pierre/diffs";
import { assertNever } from "../../../../shared/assert";
import type { ReviewAnchor } from "../../../../shared/review";

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

/** Walk one side of a file's hunks, calling `visit` with each line's number and text in
 * file order. `additionLines`/`deletionLines` hold the raw text; each hunk block carries
 * the index where its run starts in those arrays, and the line *numbers* advance from
 * the hunk header exactly as the coverage universe advances them. `visit` returns false
 * to stop the walk — the caller stops once it is past the range it wants, so a snippet
 * of a 3-line anchor never walks a 4000-line file to its end. */
function walkSide(
  file: FileDiffMetadata,
  side: ReviewAnchor["side"],
  visit: (line: SnippetLine) => boolean,
): void {
  const additions = side === "additions";
  const texts = additions ? file.additionLines : file.deletionLines;
  /** One block's run of lines, in file coordinates. False the moment `visit` asks to stop. */
  const emitRun = (
    kind: SnippetLine["kind"],
    from: number,
    start: number,
    count: number,
  ): boolean => {
    for (let i = 0; i < count; i += 1) {
      if (!visit({ kind, line: from + i, text: lineText(texts[start + i]) })) {
        return false;
      }
    }
    return true;
  };
  for (const hunk of file.hunks) {
    let line = additions ? hunk.additionStart : hunk.deletionStart;
    for (const block of hunk.hunkContent) {
      if (block.type === "context") {
        const start = additions ? block.additionLineIndex : block.deletionLineIndex;
        if (!emitRun("context", line, start, block.lines)) {
          return;
        }
        line += block.lines;
      } else if (block.type === "change") {
        // Only this side's run of the change block exists in these coordinates; the
        // other side's lines live at their own numbers and are not part of this walk.
        const count = additions ? block.additions : block.deletions;
        const start = additions ? block.additionLineIndex : block.deletionLineIndex;
        if (!emitRun(additions ? "addition" : "deletion", line, start, count)) {
          return;
        }
        line += count;
      } else {
        // `@pierre/diffs` is a moving beta: a block kind added upstream must break the
        // build here rather than silently drop lines out of a preview.
        assertNever(block);
      }
    }
  }
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
