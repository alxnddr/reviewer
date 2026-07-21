import type { PatchFile } from "./patch";

/** The diff surface is virtualized: off-screen lines are not in the DOM, so the
 * browser's native find never sees them. Search therefore runs against the parsed
 * patch model — every hunk line, on-screen or not — and navigates by driving
 * CodeView's own scroll + selection API. This module is the pure half: it flattens
 * the loaded files into an addressable line index and matches a query against it.
 * The React wiring lives in `use-diff-search.ts`. */

/** Which side of the diff a line's number lives on — CodeView addresses lines per
 * side, so a ref must carry it. Context lines exist on both sides; the index files
 * them under `additions` (their new-file number), which resolves the same rendered
 * row in unified and split. */
export type DiffSide = "additions" | "deletions";

/** One rendered diff line, addressed exactly as CodeView's `scrollTo`/
 * `setSelectedLines` expect it: the file item id, the side its number lives on,
 * and its 1-based number on that side. */
export type DiffLineRef = {
  fileId: string;
  side: DiffSide;
  lineNumber: number;
};

/** An index entry: a line ref plus the text to match against (newline stripped). */
export type SearchIndexLine = DiffLineRef & { text: string };

/** A query as the UI holds it. Empty text matches nothing. */
export type SearchQuery = { text: string; caseSensitive: boolean };

/** Strip a single trailing EOL — the parser keeps the `\n` (and CRLF's `\r`) on
 * every line but the last, so matching would otherwise anchor `$`-like queries
 * inconsistently and a highlight would read past the visible glyphs. */
function stripEol(line: string): string {
  return line.replace(/\r?\n$/, "");
}

/** Append a file's hunk lines to `index` in rendered order. Line numbers are
 * walked from each hunk's `additionStart`/`deletionStart`: a context block
 * advances both sides in lockstep (it renders once, filed under `additions`); a
 * change block emits its deletions first, then its additions — the unified reading
 * order — advancing only the side it wrote. Indices into `additionLines`/
 * `deletionLines` come straight from each block, so an out-of-range read (a
 * malformed patch) degrades to an empty string rather than throwing. */
function appendFileLines(
  index: SearchIndexLine[],
  fileId: string,
  fileDiff: PatchFile["fileDiff"],
): void {
  const { additionLines, deletionLines } = fileDiff;
  for (const hunk of fileDiff.hunks) {
    let additionLine = hunk.additionStart;
    let deletionLine = hunk.deletionStart;
    for (const block of hunk.hunkContent) {
      if (block.type === "context") {
        for (let offset = 0; offset < block.lines; offset += 1) {
          index.push({
            fileId,
            side: "additions",
            lineNumber: additionLine,
            text: stripEol(additionLines[block.additionLineIndex + offset] ?? ""),
          });
          additionLine += 1;
          deletionLine += 1;
        }
      } else {
        for (let offset = 0; offset < block.deletions; offset += 1) {
          index.push({
            fileId,
            side: "deletions",
            lineNumber: deletionLine,
            text: stripEol(deletionLines[block.deletionLineIndex + offset] ?? ""),
          });
          deletionLine += 1;
        }
        for (let offset = 0; offset < block.additions; offset += 1) {
          index.push({
            fileId,
            side: "additions",
            lineNumber: additionLine,
            text: stripEol(additionLines[block.additionLineIndex + offset] ?? ""),
          });
          additionLine += 1;
        }
      }
    }
  }
}

/** The loaded diff → a flat, ordered index of every hunk line across all files.
 * Order is file order, then hunk order, then within a change block deletions
 * before additions — so match navigation reads top-to-bottom the way the unified
 * diff renders. Binary files and pure renames contribute no lines (zero hunks). */
export function buildSearchIndex(files: readonly PatchFile[]): SearchIndexLine[] {
  const index: SearchIndexLine[] = [];
  for (const file of files) {
    appendFileLines(index, file.path, file.fileDiff);
  }
  return index;
}

/** The lines that contain the query, in index order — one ref per matching line.
 * Match granularity is the line, not the occurrence: the highlight is a whole
 * selected line (the only per-line paint the virtualized surface can carry), so a
 * line with two hits is one result, and "next" never lands on the row it left. An
 * empty query matches nothing. */
export function findMatches(index: readonly SearchIndexLine[], query: SearchQuery): DiffLineRef[] {
  const needle = query.caseSensitive ? query.text : query.text.toLowerCase();
  if (needle.length === 0) {
    return [];
  }
  const matches: DiffLineRef[] = [];
  for (const line of index) {
    const haystack = query.caseSensitive ? line.text : line.text.toLowerCase();
    if (haystack.includes(needle)) {
      matches.push({ fileId: line.fileId, side: line.side, lineNumber: line.lineNumber });
    }
  }
  return matches;
}
