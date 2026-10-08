import {
  walkLayerInputs,
  type AnchorSpan,
  type LineSpan,
  type ReviewLayerInput,
  type ReviewLayerRange,
  type ReviewSide,
} from "../shared/review";
import {
  ANALYSIS_CACHE_KEY,
  parsePatch,
  type FileChangeStatus,
  type PatchFile,
} from "../shared/diff/patch";
import { hunkSpan, walkFileLines } from "../shared/diff/walk";
import { rangeSpans } from "../shared/layers";

// Do the ordered layers cover the whole diff? The universe is every *changed* line of the
// range's diff — additions in new-file coordinates, deletions in old-file coordinates, context
// excluded (a walkthrough explains what changed, not the untouched lines a range incidentally
// spans). A changed line is covered iff some layer `range` on its side spans it, or a
// whole-file range (`{ file }`) names its file. Pure and
// I/O-free, over the *same* `parsePatch` the app renders with, against whatever diff the caller
// resolved: the range captured live for a `--draft` audit, re-derived from the artifact's own
// repo/refs for a finished artifact, or a rare embedded frozen patch. The CLI shell owns the
// patch bytes, the exit code, and the report formatting.
//
// This is the one module under `src/tools/` the renderer imports (`lib/coverage.ts` takes
// `coverageOfFiles`, `lib/overview.ts` takes `changedLines`) — a deliberate `renderer → tools`
// edge, declared by `src/tools/**/*` in `tsconfig.web.json`'s `include`. It stays here rather
// than moving to `src/shared/` because the coverage *verdict* is the CLI gate's domain and the
// app is the second reader: sharing the implementation is precisely what guarantees the number
// on screen equals the one `rvw check --coverage` exits on. The edge is one-way — nothing under
// `src/tools/` imports from `src/renderer/`.

/** Why a changed file cannot be covered — it carries no changed line to anchor into.
 * Reported honestly, never as a gap the authoring agent is told to close: a binary has no
 * line-level diff, a pure rename moved bytes without touching content, and a file changed
 * only in its mode (or created empty) has nothing between its `@@` markers. A file that
 * cannot be anchored into is never called `covered` either — nothing covers it. */
export type NonCoverableReason = "binary" | "pureRename" | "noChangedLines";

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
  /** Each a contiguous run of uncovered changed lines within one file+side — the compact
   * "skipped this hunk" locator, in the same anchor shape a layer range is authored in, so
   * closing a gap is a copy of the span that named it. Line numbers are file coordinates on
   * `side` (new-file for additions, old-file for deletions). */
  uncoveredSpans: AnchorSpan[];
};

/** Coverage needs a diff to compute against; a patch that carries no diff has no universe, so
 * it is a typed failure the shell maps to exit 2 — never a silent 100% (the validator's
 * missing-patch posture). "Carries no diff" is a property of the *content*: a string that
 * parses to zero files states nothing about a change, whether it is absent, empty, blank, or
 * prose. Length alone would let `"not a diff"` through as 0-of-0 covered. */
export type CoverageResult =
  | { ok: true; report: CoverageReport }
  | { ok: false; error: "missingPatch" };

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
export type LayerExtent = { readonly ranges: readonly ReviewLayerRange[] };

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

/** Coverage of a raw diff against a set of layer ranges — the one core every caller shares.
 * The finished-artifact command feeds it the diff re-derived from the artifact's own repo/refs
 * (or a rare embedded frozen patch); the live-range command feeds it the freshly-captured
 * patch and a draft's layers, so a mid-draft check and a post-emit audit describe the same
 * universe. An absent patch takes the same route as an unparseable one: both carry no diff.
 * Pure: no I/O, no clock. */
export function coverageOfPatch(patch: string, layers: readonly LayerExtent[]): CoverageResult {
  const files = parsePatch(patch, ANALYSIS_CACHE_KEY);
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
  const rangesByFile = groupRanges(layers, files);

  const fileCoverages: FileCoverage[] = [];
  const uncoveredSpans: AnchorSpan[] = [];
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
      const covers = spansCover(ranges[side]);
      const uncoveredOnSide: number[] = [];
      for (const line of changed[side]) {
        coverable += 1;
        if (covers(line)) {
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
export type ChangedSpan = LineSpan & { side: ReviewSide };

/** One hunk's extent on one side — the span an anchor may sit anywhere inside, context lines
 * included. The other half of what an author needs from `rvw diff --json`: `spans` say where
 * the change is (what a layer must cover), `hunks` say where an anchor is *legal* (what a
 * comment, a range or a line reference must sit inside, and the only place a `pre-existing`
 * finding can be pinned). Without them the boundary was learned by failing — the refusal's
 * "nearest on that side" was the first place it was printed. */
export type HunkExtent = LineSpan & { side: ReviewSide };

/** One hunk with both of its sides together: the old-file extent and the new-file extent of
 * the same `@@` block, either null when the hunk has no line on that side (a pure insertion
 * has no deletions extent). `hunks` lists the same extents grouped by side, which is the order
 * coverage reads them in and the shape an older consumer already parses — but an author
 * writing a line range for *both* sides of one hunk had to pair the two lists back up by
 * position, and did, for 63 ranges. A pair is that matching done once, here. */
export type HunkPair = { deletions: LineSpan | null; additions: LineSpan | null };

/** One file's place in the changed-line universe: either the contiguous changed spans an
 * anchor may fall in, or an honest non-coverable reason (a binary/pure-rename carries no
 * lines to anchor). `status` is the file's A/M/D/R change so the listing reads like the
 * diff tree. `hunks` and `pairs` are on both arms so every entry has the same answer to
 * "where may I anchor": a non-coverable file's are simply empty. */
export type FileUniverse =
  | {
      file: string;
      status: FileChangeStatus;
      coverable: false;
      reason: NonCoverableReason;
      hunks: HunkExtent[];
      pairs: HunkPair[];
    }
  | {
      file: string;
      status: FileChangeStatus;
      coverable: true;
      spans: ChangedSpan[];
      hunks: HunkExtent[];
      pairs: HunkPair[];
    };

/** The changed-line universe of a captured patch: per file, the per-side contiguous
 * changed spans (`rvw diff --json`). Derived from the *same* `parsePatch` + `changedLines` +
 * `contiguousSpans` that `coverageOfPatch` measures against, so the spans a listing shows
 * are exactly the universe coverage scores — one derivation, never a parallel parse (the
 * drift `changedLineUniverse` and `coverageOfPatch` sharing these helpers rules out). */
export function changedLineUniverse(patch: string): FileUniverse[] {
  return parsePatch(patch, ANALYSIS_CACHE_KEY).map((file) => {
    const changed = changedLines(file);
    const reason = nonCoverableReason(file, changed);
    const hunks = hunkExtents(file);
    const pairs = hunkPairs(file);
    if (reason !== null) {
      return { file: file.path, status: file.status, coverable: false, reason, hunks, pairs };
    }
    const spans: ChangedSpan[] = [];
    for (const side of SIDES) {
      for (const span of contiguousSpans([...changed[side]])) {
        spans.push({ side, ...span });
      }
    }
    return { file: file.path, status: file.status, coverable: true, spans, hunks, pairs };
  });
}

/** Every hunk as one pair of side extents, in file order — `hunkExtents`' spans regrouped by
 * hunk, read through the same `hunkSpan`, so a pair's sides are exactly two entries of
 * `hunks`. */
function hunkPairs(file: PatchFile): HunkPair[] {
  const side = (hunk: (typeof file.fileDiff.hunks)[number], which: ReviewSide) => {
    const span = hunkSpan(hunk, which);
    return span.end >= span.start ? { startLine: span.start, endLine: span.end } : null;
  };
  return file.fileDiff.hunks.map((hunk) => ({
    deletions: side(hunk, "deletions"),
    additions: side(hunk, "additions"),
  }));
}

/** Every hunk's extent per side, deletions then additions like `spans`, in file order. Read
 * through `hunkSpan` — the header geometry `resolveAnchor` asks and the refusal's
 * `nearestHunks` lists — so an anchor inside one of these places, by construction rather than
 * by a second reading of the patch. A side a hunk has no lines on (additions on a pure
 * deletion) is left out, exactly as the refusal leaves it out. */
function hunkExtents(file: PatchFile): HunkExtent[] {
  const extents: HunkExtent[] = [];
  for (const side of SIDES) {
    for (const hunk of file.fileDiff.hunks) {
      const span = hunkSpan(hunk, side);
      if (span.end >= span.start) {
        extents.push({ side, startLine: span.start, endLine: span.end });
      }
    }
  }
  return extents;
}

/** True once no changed line remains uncovered — the `--require-complete` gate. Vacuously
 * true when every changed file is non-coverable (a diff of nothing but binaries, pure
 * renames, and mode changes): there is no line a layer could have explained. A patch that
 * carries no diff at all never reaches here — it is a typed `missingPatch` failure. */
export function isFullyCovered(report: CoverageReport): boolean {
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

/** The per-side changed lines of a file: the shared hunk walk (`shared/diff/walk.ts`)
 * over every line, keeping the `+` lines at their new-file numbers and the `-` lines at
 * their old-file ones and discarding the context the walk carries between them. This is
 * the universe — it must be exact, so it reads the `+`/`-` line coordinates directly
 * rather than subtracting context from the hunk span (the same walk the search index and
 * the snippet preview read, so a line that is searchable and previewable is the line
 * coverage scores). Exported because it *is* the universe definition: the overview's
 * per-layer `+/−` counts measure against these same sets, so the doc's numbers and the
 * coverage report can never describe different diffs. */
export function changedLines(file: PatchFile): ChangedLines {
  const additions = new Set<number>();
  const deletions = new Set<number>();
  walkFileLines(file.fileDiff, (line) => {
    if (line.kind === "addition") {
      additions.add(line.lineNumber);
    } else if (line.kind === "deletion") {
      deletions.add(line.lineNumber);
    }
  });
  return { additions, deletions };
}

/** Layer ranges grouped by file then side. A line range covers only its own side (mirroring
 * `coversRange`); a whole-file range is read through `rangeSpans`, the one expansion of it,
 * as every hunk of its file on both sides — which spans every changed line the file has, and
 * nothing on a file the diff does not carry. Empty `ranges` (a parent rollup) contribute
 * nothing. */
function groupRanges(
  layers: readonly LayerExtent[],
  files: readonly PatchFile[],
): Map<string, FileRanges> {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const byFile = new Map<string, FileRanges>();
  for (const layer of layers) {
    for (const range of layer.ranges) {
      for (const span of rangeSpans(range, byPath.get(range.file))) {
        let fileRanges = byFile.get(span.file);
        if (fileRanges === undefined) {
          fileRanges = emptyRanges();
          byFile.set(span.file, fileRanges);
        }
        fileRanges[span.side].push({ startLine: span.startLine, endLine: span.endLine });
      }
    }
  }
  return byFile;
}

function emptyRanges(): FileRanges {
  return { deletions: [], additions: [] };
}

/** "Does any range span this line?" — the same inclusive `[startLine, endLine]` test the anchor
 * resolver uses, applied per side by the caller — answered by binary search over the ranges
 * sorted and merged once. Not `ranges.some(…)` per line: a whole-file range arrives as one span
 * per hunk, a PR's file can carry tens of thousands of hunks, and lines × spans was 460 ms of
 * every `effectiveLayers` (so of every read mark in the guide) on a 20k-hunk file. Exported
 * because the renderer asks the same question of a chapter's spans (`lib/diff/snippet.ts`'s
 * `spanIndex`), and one answer cannot drift from the coverage it is counted beside. */
export function spansCover(ranges: readonly LineSpan[]): (line: number) => boolean {
  const merged: [number, number][] = [];
  for (const range of ranges
    .filter((current) => current.startLine <= current.endLine)
    .toSorted((a, b) => a.startLine - b.startLine)) {
    const last = merged.at(-1);
    if (last !== undefined && range.startLine <= last[1] + 1) {
      last[1] = Math.max(last[1], range.endLine);
    } else {
      merged.push([range.startLine, range.endLine]);
    }
  }
  return (line) => {
    // The last merged interval starting at or before `line`.
    let low = 0;
    let high = merged.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((merged[middle]?.[0] ?? 0) <= line) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    const interval = merged[low - 1];
    return interval !== undefined && line <= interval[1];
  };
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
