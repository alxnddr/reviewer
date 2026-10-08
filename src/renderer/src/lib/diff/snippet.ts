import type { FileDiffMetadata, Hunk } from "@pierre/diffs";
import type { AnchorSpan, ReviewAnchor } from "../../../../shared/review";
import { hunkSpan, walkFileLines, walkHunkLines } from "../../../../shared/diff/walk";
import {
  MAX_READ_LINE_LENGTH,
  outlineFile,
  outlineLanguage,
} from "../../../../shared/diff/outline";
import type { PatchFile } from "../../../../shared/diff/patch";
import { changedLines, spansCover } from "../../../../tools/review-coverage";

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

// ── The hunk card ────────────────────────────────────────────────────────────────────────────
//
// `snippetForAnchor` is the anchor's own lines on the anchor's own side — right for a prompt
// that quotes what a comment is about, wrong for the guide's chapter card, which is read the way
// a diff is read: the deleted lines above the added ones that replaced them, a line or two of
// unchanged code either side so the change has somewhere to sit, and both numbers on every row.
// So the card gets its own lift rather than a flag on the first one: one function per question,
// and the prompt's output is pinned by `review-export`'s tests.
//
// The window is *the anchor's rows in unified order, the rest of the change block they sit in,
// and `context` unchanged rows either side, inside the one hunk that holds the anchor's first
// line* — never across a hunk boundary, because the rows
// between two hunks are not in the diff and a card that silently joined them would show two
// fragments as one block. A layer's `focus` is the author's pick of that anchor; a chapter with
// none previews the app's pick (`representativeAnchors`, below), through this same function, so
// the two cards cannot differ in shape.

/** One row of a hunk card, unified: a context row carries both numbers, a change row its own. */
export type HunkSnippetLine = {
  kind: SnippetLineKind;
  /** Old-file line number; null on an added line. */
  oldLine: number | null;
  /** New-file line number; null on a deleted line. */
  newLine: number | null;
  text: string;
  /** The anchor names this row — the card may set the anchor's rows apart from the context. */
  focused: boolean;
};

export type HunkSnippet = {
  lines: HunkSnippetLine[];
  /** Rows of the window the cap cut, so the card says what it withheld. */
  hidden: number;
  /** The hunk header's function context (`@@ … @@ <context>`), or null — what the card can
   * name the place by when the window itself opens mid-body. */
  context: string | null;
};

/** Where the card's window starts relative to the anchor.
 *
 * - `block`: at the start of the change block the anchor sits in — every changed row on the way
 *   to it comes along. Right for an anchor someone *authored* (a `focus`, a range): they named
 *   lines inside a change, and the change is what the card shows.
 * - `anchor`: at the anchor itself, keeping only the rows of the *other* kind directly above it
 *   (the deletion an added declaration replaced) and then the unchanged air. Right for an
 *   anchor the app *picked* as the representative line (`representativeAnchor`): in an added
 *   file the whole file is one change block, so `block` would walk back to line 1 — the imports
 *   and the header comment the pick exists to skip. */
export type SnippetLead = "block" | "anchor";

export type HunkSnippetOptions = {
  /** Unchanged rows kept either side of the anchor's change block (fewer at a hunk's edge or
   * where the next change starts). */
  context: number;
  /** The most rows the card shows; the window's tail past it is counted in `hidden`. */
  maxLines: number;
  /** `block` when absent. */
  lead?: SnippetLead;
};

/** The hunk the anchor's first line falls in, on the anchor's side — or the first one its
 * range overlaps at all, so a range that starts in the gap before a hunk still finds it. */
function hunkHolding(file: FileDiffMetadata, anchor: AnchorSpan): Hunk | null {
  let overlapping: Hunk | null = null;
  for (const hunk of file.hunks) {
    const span = hunkSpan(hunk, anchor.side);
    if (span.start <= anchor.startLine && anchor.startLine <= span.end) {
      return hunk;
    }
    if (overlapping === null && span.start <= anchor.endLine && anchor.startLine <= span.end) {
      overlapping = hunk;
    }
  }
  return overlapping;
}

/** One hunk's rows in unified reading order. The walk emits a context line twice — deletions
 * first, then additions (`walk.ts`) — so the old-side numbers of a context run are queued and
 * paired with the additions copy that follows, which is the row a unified diff draws. */
function unifiedRows(file: FileDiffMetadata, hunk: Hunk, anchor: AnchorSpan): HunkSnippetLine[] {
  const rows: HunkSnippetLine[] = [];
  const pendingOld: number[] = [];
  const inAnchor = (line: number | null): boolean =>
    line !== null && anchor.startLine <= line && line <= anchor.endLine;
  walkHunkLines(hunk, (line) => {
    if (line.kind === "context" && line.side === "deletions") {
      pendingOld.push(line.lineNumber);
      return true;
    }
    const texts = line.side === "additions" ? file.additionLines : file.deletionLines;
    const oldLine =
      line.kind === "context"
        ? (pendingOld.shift() ?? null)
        : line.kind === "deletion"
          ? line.lineNumber
          : null;
    const newLine = line.side === "additions" ? line.lineNumber : null;
    rows.push({
      kind: line.kind,
      oldLine,
      newLine,
      text: lineText(texts[line.index]),
      focused: inAnchor(anchor.side === "additions" ? newLine : oldLine),
    });
    return true;
  });
  return rows;
}

/** The chapter card for `anchor`: its rows in unified order with `context` unchanged rows either
 * side, inside the hunk that holds it, capped at `maxLines`. Null when the anchor names no line
 * this file's hunks carry — a drifted anchor renders no card rather than an empty frame. */
export function hunkSnippet(
  file: FileDiffMetadata,
  anchor: AnchorSpan,
  options: HunkSnippetOptions,
): HunkSnippet | null {
  const hunk = hunkHolding(file, anchor);
  if (hunk === null) {
    return null;
  }
  const rows = unifiedRows(file, hunk, anchor);
  const first = rows.findIndex((row) => row.focused);
  if (first === -1) {
    return null;
  }
  const last = rows.findLastIndex((row) => row.focused);
  // First the rest of the change block the anchor sits in — the deletion its first added line
  // replaced is part of the change being shown — then up to `context` unchanged rows of air,
  // stopping short of the next change block: a card that dragged in a neighbouring change
  // would show a hunk's worth of someone else's chapter above this one's.
  const isContext = (index: number): boolean => rows[index]?.kind === "context";
  // Under `anchor` lead only the rows of the other change kind come along — an added anchor's
  // replaced lines, never the earlier additions of its own block.
  const anchorKind = rows[first]?.kind;
  const leadsIn = (index: number): boolean =>
    !isContext(index) && (options.lead !== "anchor" || rows[index]?.kind !== anchorKind);
  let from = first;
  while (from > 0 && leadsIn(from - 1)) {
    from -= 1;
  }
  // Air only where the lead-in reached the block's edge: under `anchor` lead a window that
  // stopped mid-block has changed rows above it, not unchanged ones.
  for (let unchanged = 0; from > 0 && unchanged < options.context && isContext(from - 1); ) {
    from -= 1;
    unchanged += 1;
  }
  let to = last;
  while (to < rows.length - 1 && !isContext(to + 1)) {
    to += 1;
  }
  for (
    let unchanged = 0;
    to < rows.length - 1 && unchanged < options.context && isContext(to + 1);
  ) {
    to += 1;
    unchanged += 1;
  }
  const window = rows.slice(from, to + 1);
  const lines = window.slice(0, Math.max(0, options.maxLines));
  const context = hunk.hunkContext?.trim() ?? "";
  return {
    lines,
    hidden: window.length - lines.length,
    context: context === "" ? null : context,
  };
}

// ── The representative hunk ──────────────────────────────────────────────────────────────────
//
// A chapter with no authored `focus` still gets a card, and which hunk it shows is the whole of
// its value: the card is the one piece of code beside the chapter's prose. The first shape was
// "the first range that places", and for a chapter that adds a file that is the top of the file
// — imports and a licence comment, the least telling lines in it. So the pick reads the change
// the way a reviewer skims it:
//
//   1. **Which file.** Hand-written before machine-written (`isMachineWritten`: a lockfile or a
//      generated client is never the point), source before tests (tests explain a change second),
//      then the file where the chapter covers the most changed lines, then authored order.
//   2. **Which line.** A declaration the outline (`shared/diff/outline.ts`) found among the
//      chapter's lines — its own line changed, first in reading order — else the first body edit
//      it attributed to a symbol, else, in an added file, the first line past its leading run of
//      imports, comments and blanks, else the chapter's first span in the file.
//
// A picked declaration starts the window at itself (`lead: "anchor"`), so an added file's card
// opens on the declaration rather than walking back to line 1; a body edit keeps `block`, since
// the change around it is the point. Pure: the outline and the changed lines are re-derived
// from the parsed diff, and the caller says which files are machine-written.
//
// **Cheap, because a PR's diff is someone else's.** Ranking needs every file's covered-line count,
// but the pick itself is lazy — `representativeAnchors` yields, and the caller stops at the first
// card — since every pick after the first was an outline of a file nobody would see. Every
// "does a span hold this line" goes through a `SpanIndex` (sorted, merged, binary-searched),
// because a whole-file range arrives as one span per hunk and a file can carry tens of thousands
// of hunks; `LEADING_NOISE` never sees a line past `MAX_READ_LINE_LENGTH` and has no two adjacent
// quantifiers that can trade a run of spaces between them.

/** One file a chapter covers, with the chapter's spans in it (`rangeSpans`, so a whole-file
 * range arrives as every hunk of the file). Listed in authored order. */
export type SnippetCandidate = { file: PatchFile; spans: readonly AnchorSpan[] };

export type RepresentativeAnchor = { file: PatchFile; anchor: AnchorSpan; lead: SnippetLead };

/** Path shapes that mark a test: a `test`/`tests`/`__tests__`/`spec` directory, or a
 * `.test.`/`.spec.`/`_test.` file name. A ranking hint, so a miss costs only the order. The file
 * name is tested on its own (`TEST_NAME`) rather than as `[._](?:test|spec)\.[^/]+$` over the
 * path, which re-scanned the rest of the path from every `.test.` in it. */
const TEST_DIRECTORY = /(?:^|\/)(?:__tests__|tests?|spec)\//u;
const TEST_NAME = /[._](?:test|spec)\../u;

function isTestPath(path: string): boolean {
  return TEST_DIRECTORY.test(path) || TEST_NAME.test(path.slice(path.lastIndexOf("/") + 1));
}

/** A line an added file leads with that says nothing about what the file is for: blank, a
 * comment, an import or package line, a directive, or a line of an import block (`"fmt"`, `)`).
 * Language-gated by the caller — prose and config have no such run, and `# Title` is content.
 * Each tail is `(?:\s*;)?\s*$`, never `\s*;?\s*$`, whose two blank runs split a line of spaces
 * every possible way before failing. Exported for the linearity test, which runs it far past the
 * line budget. */
export const LEADING_NOISE =
  /^\s*(?:$|\/\/|\/\*|\*|#|import\b|from\s+\S+\s+import\b|export\s+(?:\*|type\s+\{|\{)[^;]*\bfrom\b|package\b|use\s|extern\s+crate\b|mod\s+\w+;|require(?:_relative)?\b|["']use (?:strict|client|server)["'](?:\s*;)?\s*$|["'][^"']*["'](?:\s*;)?\s*$|\)(?:\s*;)?\s*$)/u;

/** A line past the read budget is content, not noise — it is never handed to the pattern. */
function isLeadingNoise(text: string): boolean {
  return text.length <= MAX_READ_LINE_LENGTH && LEADING_NOISE.test(text);
}

/** "Does any of these spans hold this line?", per side, through the coverage core's own
 * `spansCover` (binary search over merged spans — not every span per line, which is lines ×
 * hunks on a whole-file range over a file of many hunks). Exported for `lib/overview.ts`'s
 * covered-line counts. */
export type SpanIndex = { holds: (side: AnchorSpan["side"], line: number) => boolean };

export function spanIndex(spans: readonly AnchorSpan[]): SpanIndex {
  const bySide = {
    additions: spansCover(spans.filter((span) => span.side === "additions")),
    deletions: spansCover(spans.filter((span) => span.side === "deletions")),
  };
  return { holds: (side, line) => bySide[side](line) };
}

function coveredCount(file: PatchFile, index: SpanIndex): number {
  const changed = changedLines(file);
  let count = 0;
  for (const side of ["additions", "deletions"] as const) {
    for (const line of changed[side]) {
      if (index.holds(side, line)) {
        count += 1;
      }
    }
  }
  return count;
}

/** The anchor that best represents one file's part of a chapter, or null when the chapter's
 * spans hold no changed line of it. */
function anchorIn(
  candidate: SnippetCandidate,
  index: SpanIndex,
): Omit<RepresentativeAnchor, "file"> | null {
  const { file, spans } = candidate;
  const at = (side: AnchorSpan["side"], line: number): AnchorSpan => ({
    file: file.path,
    side,
    startLine: line,
    endLine: line,
  });
  const symbols = outlineFile(file).filter((symbol) => index.holds(symbol.side, symbol.line));
  const declared = symbols.find((symbol) => symbol.source === "declaration");
  if (declared !== undefined) {
    return { anchor: at(declared.side, declared.line), lead: "anchor" };
  }
  const edited = symbols[0];
  if (edited !== undefined) {
    return { anchor: at(edited.side, edited.line), lead: "block" };
  }
  if (file.status === "added" && outlineLanguage(file.path) !== null) {
    const found: number[] = [];
    walkSide(file.fileDiff, "additions", (line) => {
      if (
        line.kind === "addition" &&
        index.holds("additions", line.line) &&
        !isLeadingNoise(line.text)
      ) {
        found.push(line.line);
        return false;
      }
      return true;
    });
    const first = found[0];
    if (first !== undefined) {
      return { anchor: at("additions", first), lead: "anchor" };
    }
  }
  const span = spans[0];
  return span === undefined ? null : { anchor: span, lead: "block" };
}

/** The chapter's representative anchors, best first — the caller cards the first that yields a
 * card, so a pick whose window comes out empty falls through to the next file rather than
 * leaving the chapter bare. Lazy: a pick is made only when the caller asks for the next one, so
 * a chapter whose first pick cards outlines one file, not all of them. */
export function* representativeAnchors(
  candidates: readonly SnippetCandidate[],
  isMachineWritten: (file: PatchFile) => boolean,
): Generator<RepresentativeAnchor, void, undefined> {
  const ranked = candidates
    .map((candidate, order) => {
      const index = spanIndex(candidate.spans);
      return {
        candidate,
        index,
        order,
        machine: isMachineWritten(candidate.file) ? 1 : 0,
        test: isTestPath(candidate.file.path) ? 1 : 0,
        size: coveredCount(candidate.file, index),
      };
    })
    .filter((entry) => entry.size > 0)
    .toSorted(
      (a, b) => a.machine - b.machine || a.test - b.test || b.size - a.size || a.order - b.order,
    );
  for (const { candidate, index } of ranked) {
    const pick = anchorIn(candidate, index);
    if (pick !== null) {
      yield { file: candidate.file, ...pick };
    }
  }
}
