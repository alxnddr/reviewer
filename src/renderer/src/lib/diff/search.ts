import type { PatchFile } from "../../../../shared/diff/patch";
import { walkFileLines } from "../../../../shared/diff/walk";

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

/** An index entry: a line ref plus the text to match against (newline stripped), and its
 * lowercase form precomputed at build time. `lowerText` exists purely so the
 * case-insensitive path of `findMatches` — the default, run on every keystroke — never
 * allocates a fresh lowercased string per line per character typed; it costs one
 * `toLowerCase()` per line, done once when the index is built. */
export type SearchIndexLine = DiffLineRef & { text: string; lowerText: string };

/** A query as the UI holds it. Empty text matches nothing. */
export type SearchQuery = { text: string; caseSensitive: boolean };

/** Strip a single trailing EOL — the parser keeps the `\n` (and CRLF's `\r`) on
 * every line but the last, so matching would otherwise anchor `$`-like queries
 * inconsistently and a highlight would read past the visible glyphs. */
function stripEol(line: string): string {
  return line.replace(/\r?\n$/u, "");
}

/** Append a file's hunk lines to `index` in rendered order — the shared hunk walk
 * (`shared/diff/walk.ts`) supplies the coordinates, in the unified reading order the
 * index wants (a change block's deletions before its additions). All this adds is what
 * to keep and what to store: a context line renders once and is filed under `additions`
 * — its new-file number resolves the same row in unified and split — so the walk's
 * deletions-side copy of it is dropped here. An out-of-range text read (a malformed
 * patch) degrades to an empty string rather than throwing. */
function appendFileLines(
  index: SearchIndexLine[],
  fileId: string,
  fileDiff: PatchFile["fileDiff"],
): void {
  const { additionLines, deletionLines } = fileDiff;
  walkFileLines(fileDiff, (line) => {
    if (line.kind === "context" && line.side === "deletions") {
      return;
    }
    const lines = line.side === "additions" ? additionLines : deletionLines;
    const text = stripEol(lines[line.index] ?? "");
    index.push({
      fileId,
      side: line.side,
      lineNumber: line.lineNumber,
      text,
      lowerText: text.toLowerCase(),
    });
  });
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

/** One character per file, `"1"` where `fileDiff.isPartial` is set — a cache key for
 * "does the index need to see this file's lines again". `files` keeps its own identity
 * across a context expansion: Pierre hydrates the affected `fileDiff` *in place*
 * (`isPartial` flips to `false`, `additionLines` grows to the full file) rather than
 * handing back a new array, so a memo keyed on `files` alone never rebuilds and the
 * newly-revealed lines stay unfound. This string changes exactly when that hydration
 * lands, so a consumer can add it to its own memo key without re-walking every hunk line
 * itself just to notice. */
export function partialSignature(files: readonly PatchFile[]): string {
  return files.map((file) => (file.fileDiff.isPartial ? "1" : "0")).join("");
}

/** The lines that contain the query, in index order — one ref per matching line.
 * Match granularity is the line, not the occurrence: the highlight is a whole
 * selected line (the only per-line paint the virtualized surface can carry), so a
 * line with two hits is one result, and "next" never lands on the row it left. An
 * empty query matches nothing. The case-insensitive path (the default) reads each
 * line's precomputed `lowerText` rather than lowercasing `text` per line per call, so
 * this runs allocation-free on every keystroke; only the needle is lowercased here,
 * once per call. */
export function findMatches(index: readonly SearchIndexLine[], query: SearchQuery): DiffLineRef[] {
  const needle = query.caseSensitive ? query.text : query.text.toLowerCase();
  if (needle.length === 0) {
    return [];
  }
  const matches: DiffLineRef[] = [];
  for (const line of index) {
    const haystack = query.caseSensitive ? line.text : line.lowerText;
    if (haystack.includes(needle)) {
      matches.push({ fileId: line.fileId, side: line.side, lineNumber: line.lineNumber });
    }
  }
  return matches;
}
