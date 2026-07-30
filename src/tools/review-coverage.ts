import { assertNever } from "../shared/assert";
import {
  walkLayerInputs,
  type ReviewAnchor,
  type ReviewLayerInput,
  type ReviewSide,
} from "../shared/review";
import { parsePatch, type FileChangeStatus, type PatchFile } from "../renderer/src/lib/diff/patch";

// Do the ordered layers cover the whole diff? The universe is every *changed* line of the
// range's diff — additions in new-file coordinates, deletions in old-file coordinates, context
// excluded (a walkthrough explains what changed, not the untouched lines a range incidentally
// spans). A changed line is covered iff some layer `range` on its side spans it. Pure and
// I/O-free, over the *same* `parsePatch` the app renders with, against whatever diff the caller
// resolved: the range captured live for a `--draft` audit, re-derived from the artifact's own
// repo/refs for a finished artifact, or a rare embedded frozen patch. The CLI shell owns the
// patch bytes, the exit code, and the report formatting.

/** Why a changed file cannot be covered — it carries no changed line to anchor into.
 * Reported honestly, never as a gap the authoring agent is told to close: a binary has no
 * line-level diff, a pure rename moved bytes without touching content, and a file changed
 * only in its mode (or created empty) has nothing between its `@@` markers. A file that
 * cannot be anchored into is never called `covered` either — nothing covers it. */
export type NonCoverableReason = "binary" | "pureRename" | "noChangedLines";

/** A contiguous run of uncovered changed lines within one file+side — the compact
 * "skipped this hunk" locator. Line numbers are file coordinates on `side` (new-file for
 * additions, old-file for deletions). */
export type UncoveredSpan = {
  file: string;
  side: ReviewSide;
  startLine: number;
  endLine: number;
};

/** One changed file's coverage. A coverable file reports how
 * many of its changed lines a layer spans; `uncovered` is the "forgot a whole file"
 * signal, `partiallyCovered` the "skipped a hunk" one. A non-coverable file carries a
 * reason instead of counts — it is excluded from the headline, never a gap. */
export type FileCoverage =
  | { file: string; status: "nonCoverable"; reason: NonCoverableReason }
  | {
      file: string;
      status: "covered" | "partiallyCovered" | "uncovered";
      coverableChangedLines: number;
      coveredChangedLines: number;
    };

/** The headline every report leads with: the coverable changed-line universe and how
 * much of it a layer covers. Non-coverable files contribute to neither count, so 100%
 * is honestly reachable in a diff that is all binaries. */
export type CoverageHeadline = {
  coverableChangedLines: number;
  coveredChangedLines: number;
};

/** The coverage answer at both file and line granularities: the headline totals, the
 * per-file breakdown (including honestly-excluded non-coverable files), and the flattened
 * contiguous uncovered spans across every coverable file. */
export type CoverageReport = {
  headline: CoverageHeadline;
  files: FileCoverage[];
  uncoveredSpans: UncoveredSpan[];
};

/** Coverage needs a diff to compute against; a patch that carries no diff has no universe, so
 * it is a typed failure the shell maps to exit 2 — never a silent 100% (the validator's
 * missing-patch posture). "Carries no diff" is a property of the *content*: a string that
 * parses to zero files states nothing about a change, whether it is absent, empty, blank, or
 * prose. Length alone would let `"not a diff"` through as 0-of-0 covered. */
export type CoverageResult =
  | { ok: true; report: CoverageReport }
  | { ok: false; error: "missingPatch" };

// `parsePatch` keys its highlight cache by this prefix; coverage never renders, so any
// stable non-empty value serves — it just must not be omitted (an absent key collides
// equally-named files, per patch.ts).
const CACHE_KEY = "coverage";

// The two sides in a fixed order, so the report (and every test asserting on it) is
// deterministic regardless of which side a range happened to touch first.
const SIDES: readonly ReviewSide[] = ["deletions", "additions"];

/** The per-side changed-line universe of one file: the set of file line numbers a
 * walkthrough must explain, keyed by side. */
export type ChangedLines = Record<ReviewSide, ReadonlySet<number>>;

/** All coverage asks of a layer: the ranges it claims. Structural rather than
 * `ReviewLayer`, because both shapes of layer answer it — the app's flat, stamped one, and
 * an artifact's nested one walked flat by the CLI. Nesting is irrelevant here: a layer's
 * extent is its own ranges plus its descendants', so a walk that visits every node covers
 * exactly the same lines whichever way they were grouped. */
export type LayerExtent = { readonly ranges: readonly ReviewAnchor[] };

/** An authored outline flattened to the extents coverage measures — every node of the tree,
 * so a nested layer's ranges count exactly as a top-level one's do. Lives here, beside the
 * core, because every artifact-shaped caller needs it and a caller that forgot to descend
 * would silently under-report coverage and send an agent to re-explain code it already had. */
export function layerExtentsOf(layers: readonly ReviewLayerInput[]): LayerExtent[] {
  return walkLayerInputs(layers).map((entry) => entry.layer);
}

/** The layer ranges that land on one file, grouped by side — a parent rollup's empty
 * `ranges` simply add nothing here, so it can never be a failure. */
type FileRanges = Record<ReviewSide, LineSpan[]>;

type LineSpan = { startLine: number; endLine: number };

/** Coverage of a raw diff against a set of layer ranges — the one core every caller shares.
 * The finished-artifact command feeds it the diff re-derived from the artifact's own repo/refs
 * (or a rare embedded frozen patch); the live-range command feeds it the freshly-captured
 * patch and a draft's layers, so a mid-draft check and a post-emit audit describe the same
 * universe. An absent patch takes the same route as an unparseable one: both carry no diff.
 * Pure: no I/O, no clock. */
export function coverageOfPatch(patch: string, layers: readonly LayerExtent[]): CoverageResult {
  const files = parsePatch(patch, CACHE_KEY);
  if (files.length === 0) {
    return { ok: false, error: "missingPatch" };
  }
  return { ok: true, report: coverageOfFiles(files, layers) };
}

/** Coverage of an already-parsed diff — the entry the renderer shares with
 * `coverageOfPatch`. The CLI parses patch bytes into files then measures; the app already
 * holds the parsed files it rendered (`slice.diff.files`), so it measures those directly,
 * re-parse-free and against the exact diff on screen. Same core either way, so the app's
 * number always matches `rvw check --coverage`. */
export function coverageOfFiles(
  files: readonly PatchFile[],
  layers: readonly LayerExtent[],
): CoverageReport {
  const rangesByFile = groupRanges(layers);

  const fileCoverages: FileCoverage[] = [];
  const uncoveredSpans: UncoveredSpan[] = [];
  let coverableTotal = 0;
  let coveredTotal = 0;

  for (const file of files) {
    const changed = changedLines(file);
    const reason = nonCoverableReason(file, changed);
    if (reason !== null) {
      fileCoverages.push({ file: file.path, status: "nonCoverable", reason });
      continue;
    }

    const ranges = rangesByFile.get(file.path) ?? emptyRanges();
    let coverable = 0;
    let covered = 0;

    for (const side of SIDES) {
      const uncoveredOnSide: number[] = [];
      for (const line of changed[side]) {
        coverable += 1;
        if (spansCover(ranges[side], line)) {
          covered += 1;
        } else {
          uncoveredOnSide.push(line);
        }
      }
      for (const span of contiguousSpans(uncoveredOnSide)) {
        uncoveredSpans.push({ file: file.path, side, ...span });
      }
    }

    coverableTotal += coverable;
    coveredTotal += covered;
    fileCoverages.push({
      file: file.path,
      status: fileStatus(coverable, covered),
      coverableChangedLines: coverable,
      coveredChangedLines: covered,
    });
  }

  return {
    headline: { coverableChangedLines: coverableTotal, coveredChangedLines: coveredTotal },
    files: fileCoverages,
    uncoveredSpans,
  };
}

/** A contiguous run of changed lines on one side of one file — the shape an anchor may
 * span. The atom of the changed-line universe `rvw diff --json` lists and coverage measures
 * against, so an authored anchor targets a real span, not a guessed line number. */
export type ChangedSpan = {
  side: ReviewSide;
  startLine: number;
  endLine: number;
};

/** One file's place in the changed-line universe: either the contiguous changed spans an
 * anchor may fall in, or an honest non-coverable reason (a binary/pure-rename carries no
 * lines to anchor). `status` is the file's A/M/D/R change so the listing reads like the
 * diff tree. */
export type FileUniverse =
  | { file: string; status: FileChangeStatus; coverable: false; reason: NonCoverableReason }
  | { file: string; status: FileChangeStatus; coverable: true; spans: ChangedSpan[] };

/** The changed-line universe of a captured patch: per file, the per-side contiguous
 * changed spans (`rvw diff --json`). Derived from the *same* `parsePatch` + `changedLines` +
 * `contiguousSpans` that `coverageOfPatch` measures against, so the spans a listing shows
 * are exactly the universe coverage scores — one derivation, never a parallel parse (the
 * drift `changedLineUniverse` and `coverageOfPatch` sharing these helpers rules out). */
export function changedLineUniverse(patch: string): FileUniverse[] {
  return parsePatch(patch, CACHE_KEY).map((file) => {
    const changed = changedLines(file);
    const reason = nonCoverableReason(file, changed);
    if (reason !== null) {
      return { file: file.path, status: file.status, coverable: false, reason };
    }
    const spans: ChangedSpan[] = [];
    for (const side of SIDES) {
      for (const span of contiguousSpans([...changed[side]])) {
        spans.push({ side, ...span });
      }
    }
    return { file: file.path, status: file.status, coverable: true, spans };
  });
}

/** True once no changed line remains uncovered — the `--require-complete` gate. Vacuously
 * true when every changed file is non-coverable (a diff of nothing but binaries, pure
 * renames, and mode changes): there is no line a layer could have explained. A patch that
 * carries no diff at all never reaches here — it is a typed `missingPatch` failure. */
export function isComplete(report: CoverageReport): boolean {
  return report.headline.coveredChangedLines === report.headline.coverableChangedLines;
}

/** A binary carries no line diff and a pure rename moved bytes without touching content
 * (both are zero-hunk, patch.ts). `isBinary` is checked first: a binary change parses as
 * a `change` type, so the flag — not the type — is what distinguishes it. The residual
 * case is a file git reports as changed whose hunks hold no `+`/`-` line at all — a
 * mode-only change, or an empty file created. It carries no line an anchor could name, so
 * it is non-coverable for the same reason the other two are, and saying `covered` of it
 * would credit a walkthrough for explaining nothing. */
function nonCoverableReason(file: PatchFile, changed: ChangedLines): NonCoverableReason | null {
  if (file.isBinary) {
    return "binary";
  }
  if (file.fileDiff.type === "rename-pure") {
    return "pureRename";
  }
  if (changed.additions.size === 0 && changed.deletions.size === 0) {
    return "noChangedLines";
  }
  return null;
}

/** The per-side changed lines of a file: walk each hunk's content, advancing an
 * addition cursor (new-file coords) and a deletion cursor (old-file coords) from the
 * hunk header's `additionStart`/`deletionStart`. A context block advances both cursors
 * without emitting; a change block emits `deletions` old-file lines then `additions`
 * new-file lines and advances each cursor by its own count. This is the universe — it
 * must be exact, so it reads the `+`/`-` line coordinates directly rather than
 * subtracting context from the hunk span. Exported because it *is* the universe
 * definition: the overview's per-layer `+/−` counts measure against these same sets, so
 * the doc's numbers and the coverage report can never describe different diffs. */
export function changedLines(file: PatchFile): ChangedLines {
  const additions = new Set<number>();
  const deletions = new Set<number>();
  for (const hunk of file.fileDiff.hunks) {
    let additionLine = hunk.additionStart;
    let deletionLine = hunk.deletionStart;
    for (const block of hunk.hunkContent) {
      if (block.type === "context") {
        additionLine += block.lines;
        deletionLine += block.lines;
      } else if (block.type === "change") {
        for (let i = 0; i < block.deletions; i += 1) {
          deletions.add(deletionLine + i);
        }
        deletionLine += block.deletions;
        for (let i = 0; i < block.additions; i += 1) {
          additions.add(additionLine + i);
        }
        additionLine += block.additions;
      } else {
        // `@pierre/diffs` is a moving beta: a block kind added upstream must break the
        // build here, never slip through and silently shrink the universe.
        assertNever(block);
      }
    }
  }
  return { additions, deletions };
}

/** Layer ranges grouped by file then side. A range covers only its own side (mirroring
 * `coversRange`); empty `ranges` (a parent rollup) contribute nothing. */
function groupRanges(layers: readonly LayerExtent[]): Map<string, FileRanges> {
  const byFile = new Map<string, FileRanges>();
  for (const layer of layers) {
    for (const range of layer.ranges) {
      let fileRanges = byFile.get(range.file);
      if (fileRanges === undefined) {
        fileRanges = emptyRanges();
        byFile.set(range.file, fileRanges);
      }
      fileRanges[range.side].push({ startLine: range.startLine, endLine: range.endLine });
    }
  }
  return byFile;
}

function emptyRanges(): FileRanges {
  return { deletions: [], additions: [] };
}

/** Whether any range spans the line — the same inclusive `[startLine, endLine]` test the
 * anchor resolver uses, applied per side by the caller. */
function spansCover(ranges: readonly LineSpan[], line: number): boolean {
  return ranges.some((range) => range.startLine <= line && line <= range.endLine);
}

/** Group sorted line numbers into contiguous runs — consecutive integers merge into one
 * span. Input order is not assumed, so the lines are sorted first. */
function contiguousSpans(lines: readonly number[]): LineSpan[] {
  const sorted = [...lines].toSorted((a, b) => a - b);
  const spans: LineSpan[] = [];
  for (const line of sorted) {
    const last = spans.at(-1);
    if (last !== undefined && line === last.endLine + 1) {
      last.endLine = line;
    } else {
      spans.push({ startLine: line, endLine: line });
    }
  }
  return spans;
}

/** A coverable file's status from its counts. A coverable file always has at least one
 * changed line — a file with none is classified non-coverable before it reaches here — so
 * `covered` here means a layer genuinely spans every changed line, never that there was
 * nothing to span. */
function fileStatus(
  coverable: number,
  covered: number,
): "covered" | "partiallyCovered" | "uncovered" {
  if (covered === coverable) {
    return "covered";
  }
  return covered === 0 ? "uncovered" : "partiallyCovered";
}
