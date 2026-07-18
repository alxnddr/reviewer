import { assertNever } from "../src/shared/assert";
import type {
  CoverageReport,
  FileCoverage,
  NonCoverableReason,
  UncoveredSpan,
} from "../src/tools/review-coverage";

// The human rendering of a `CoverageReport`: a headline percentage, the per-file breakdown,
// and the flattened uncovered spans. Lives apart from any one command because two verbs
// print it — `rvw coverage` as its whole output and `rvw check` as the second half of the
// composite gate — and a reviewer reading one must see the same numbers laid out the same
// way. Pure: it returns lines, so the command owns the stream and the exit code.

/** The report as display lines (no trailing newlines). `label` is whatever the caller
 * measured — an artifact path for the embedded form, a draft path for the live-range one. */
export function coverageReportLines(label: string, report: CoverageReport): string[] {
  const { coverableChangedLines, coveredChangedLines } = report.headline;
  const lines = [
    `${label}: coverage ${percent(coveredChangedLines, coverableChangedLines)} (${coveredChangedLines}/${coverableChangedLines} changed lines)`,
  ];

  for (const file of report.files) {
    lines.push(`  ${describeFile(file)}`);
  }

  if (report.uncoveredSpans.length > 0) {
    lines.push("  uncovered spans:");
    for (const span of report.uncoveredSpans) {
      lines.push(`    - ${describeSpan(span)}`);
    }
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

/** The one rendering of a non-coverable reason, shared by `rvw coverage` and `rvw anchors`
 * so the two verbs never describe the same file differently. Exhaustive: a new reason is a
 * compile error, not a file quietly mislabelled as the last arm. */
export function describeReason(reason: NonCoverableReason): string {
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

function describeSpan(span: UncoveredSpan): string {
  return `${span.file} ${span.side} ${span.startLine}-${span.endLine}`;
}
