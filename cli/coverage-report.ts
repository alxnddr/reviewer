import { assertNever } from "../src/shared/assert";
import type {
  CoverageReport,
  FileCoverage,
  NonCoverableReason,
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
