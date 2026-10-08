import { assertNever } from "../src/shared/assert";
import type { AnchorSpan, ReviewSide } from "../src/shared/review";
import {
  isFullyCovered,
  type CoverageHeadline,
  type CoverageReport,
  type FileCoverage,
  type NonCoverableReason,
} from "../src/tools/review-coverage";

// The human rendering of a `CoverageReport`: a headline percentage and a per-file rollup, and
// deliberately nothing more. It used to also flatten every uncovered span, which on a real
// range meant ~200 lines of output for a caller who asked one yes/no question — pure context
// burn for an agent and a wall for a human. The spans are still computed and still shipped
// under `--json`, where a consumer that wants them can read them; the text channel is a
// summary, so it is written like one, capped so that a diff touching eighty files cannot
// swamp the answer it is attached to.
//
// Pure: it returns lines, so the command owns the stream and the exit code.
//
// `rvw emit` has a second, smaller rendering of the same report (`emitCoverageLines`,
// `emitCoverageSummary`). Emit never used to say anything about coverage, so an author whose
// layers missed every removed line — coverage counts the two sides separately, and an
// additions-only range leaves the deletions beside it uncovered — heard nothing until a reader
// saw "Not covered by layers" in the app. Emit is the moment the author can still fix it, so it
// says so there; it does not change the exit code, for the reason `rvw check` gives (a strong
// review may skip trivia on purpose). What it prints is the fix rather than the score: the
// uncovered spans per file and side, since those are what a range is written from — or, for a
// file no layer touches, the whole-file range that covers it in one line.

/** How many files the rollup names before it starts counting instead. Small on purpose: past a
 * handful, a file list stops being something a reader scans and becomes something they scroll,
 * and `--json` is right there for the caller that actually wants all of them. */
const MAX_ROLLUP_FILES = 10;

/** The report as display lines (no trailing newlines): the headline, then one line per changed
 * file, then — when the diff has more files than the cap — the count that was left out, so a
 * truncated list never reads like a complete one. */
export function coverageSummaryLines(report: CoverageReport): string[] {
  const { coverableChangedLines, coveredChangedLines } = report.headline;
  const lines = [
    `coverage ${percent(coveredChangedLines, coverableChangedLines)} (${coveredChangedLines}/${coverableChangedLines} changed lines)`,
  ];

  for (const file of report.files.slice(0, MAX_ROLLUP_FILES)) {
    lines.push(`  ${describeFile(file)}`);
  }
  const hidden = report.files.length - MAX_ROLLUP_FILES;
  if (hidden > 0) {
    lines.push(`  … and ${hidden} more file(s) — \`--json\` lists every one`);
  }
  return lines;
}

/** Whole-number percentage of covered over coverable; a diff with nothing coverable is
 * complete by definition, so it reads 100%. */
function percent(covered: number, coverable: number): string {
  if (coverable === 0) {
    return "100%";
  }
  return `${Math.round((covered / coverable) * 100)}%`;
}

function describeFile(file: FileCoverage): string {
  if (file.status === "nonCoverable") {
    return `non-coverable  ${file.file} (${describeReason(file.reason)})`;
  }
  const counts = `${file.coveredChangedLines}/${file.coverableChangedLines}`;
  const status = file.status;
  switch (status) {
    case "covered":
      return `covered        ${file.file} (${counts})`;
    case "partiallyCovered":
      return `partial        ${file.file} (${counts})`;
    case "uncovered":
      return `uncovered      ${file.file} (${counts})`;
    default:
      return assertNever(status);
  }
}

/** A non-coverable reason as the rollup's parenthetical. Private to this module, and only the
 * *text* channel has one: `rvw check --coverage --json` and `rvw diff --json` both ship the
 * reason code itself, which is the form an agent branches on — translating it there would put a
 * sentence in a wire format. Exhaustive: a new reason is a compile error, not a file quietly
 * mislabelled as the last arm. */
function describeReason(reason: NonCoverableReason): string {
  switch (reason) {
    case "binary":
      return "binary";
    case "pureRename":
      return "pure rename";
    case "noChangedLines":
      return "no changed lines";
    default:
      return assertNever(reason);
  }
}

/** How many uncovered spans emit names per file before it counts the rest. A file with dozens
 * of gaps is a file the layers missed wholesale, and the first few spans say that as well as
 * all of them would. */
const MAX_SPANS_PER_FILE = 4;

/** The lines `rvw emit` prints after a clean write of a review with layers: one line when every
 * changed line is in a layer, else the headline and, per file with a gap, its uncovered spans by
 * side — the spans a missing range would be written from. Capped like the rollup above. */
export function emitCoverageLines(report: CoverageReport): string[] {
  const { coverableChangedLines, coveredChangedLines } = report.headline;
  if (isFullyCovered(report)) {
    return [`layers cover every changed line (${coverableChangedLines})`];
  }
  const bySide = uncoveredBySide(report.uncoveredSpans);
  const lines = [
    `layers cover ${percent(coveredChangedLines, coverableChangedLines)} of changed lines — ${bySide.additions} added and ${bySide.deletions} removed line(s) are in no layer (shown as "Not covered by layers"):`,
  ];
  const gaps = filesWithGaps(report);
  // A file no layer touches at all is fixed by one whole-file range, not by copying its spans
  // out one hunk side at a time — which is how an author once wrote 63 ranges for 14 files.
  const untouched = new Set(
    report.files.filter((file) => file.status === "uncovered").map((file) => file.file),
  );
  for (const [file, spans] of gaps.slice(0, MAX_ROLLUP_FILES)) {
    lines.push(
      untouched.has(file)
        ? // `JSON.stringify`, not quotes around the path: this is a range the author pastes into
          // the draft, and a path holding `"` or `\` would otherwise print JSON that does not
          // parse — or, worse, parses as a different path.
          `  ${file}: in no layer — { "file": ${JSON.stringify(file)} } covers all of it`
        : `  ${file}: ${describeSpans(spans)}`,
    );
  }
  const hidden = gaps.length - MAX_ROLLUP_FILES;
  if (hidden > 0) {
    lines.push(
      `  … and ${hidden} more file(s) — \`rvw check <artifact> --coverage --json\` lists every span`,
    );
  }
  return lines;
}

/** The same answer for `rvw emit --json`: the headline, whether it is complete, the uncovered
 * line counts per side, and the files with a gap. Counts and files, not the spans themselves —
 * a diff a layer barely touched has one span per changed hunk, and an emit's success document
 * is read into an agent's context whole. `rvw check --coverage --json` carries every span. */
export type EmitCoverageSummary = {
  readonly complete: boolean;
  readonly headline: CoverageHeadline;
  readonly uncovered: Record<ReviewSide, number>;
  readonly files: readonly string[];
};

export function emitCoverageSummary(report: CoverageReport): EmitCoverageSummary {
  return {
    complete: isFullyCovered(report),
    headline: report.headline,
    uncovered: uncoveredBySide(report.uncoveredSpans),
    files: filesWithGaps(report).map(([file]) => file),
  };
}

function uncoveredBySide(spans: readonly AnchorSpan[]): Record<ReviewSide, number> {
  const counts: Record<ReviewSide, number> = { additions: 0, deletions: 0 };
  for (const span of spans) {
    counts[span.side] += span.endLine - span.startLine + 1;
  }
  return counts;
}

/** Each file with an uncovered span, in the report's file order, with its spans. */
function filesWithGaps(report: CoverageReport): [string, AnchorSpan[]][] {
  const byFile = new Map<string, AnchorSpan[]>();
  for (const span of report.uncoveredSpans) {
    const spans = byFile.get(span.file);
    if (spans === undefined) {
      byFile.set(span.file, [span]);
    } else {
      spans.push(span);
    }
  }
  return [...byFile.entries()];
}

/** `deletions 3-5, 9; additions 40-41`, the shown spans capped per file. */
function describeSpans(spans: readonly AnchorSpan[]): string {
  const shown = spans.slice(0, MAX_SPANS_PER_FILE);
  const sides = (["deletions", "additions"] as const).flatMap((side) => {
    const onSide = shown.filter((span) => span.side === side);
    if (onSide.length === 0) {
      return [];
    }
    const ranges = onSide.map((span) =>
      span.startLine === span.endLine ? `${span.startLine}` : `${span.startLine}-${span.endLine}`,
    );
    return [`${side} ${ranges.join(", ")}`];
  });
  const hidden = spans.length - shown.length;
  return hidden > 0 ? `${sides.join("; ")} (+${hidden} more)` : sides.join("; ");
}
