import { readFileSync } from "node:fs";
import { buildCommand } from "@stricli/core";
import {
  describeProblem,
  parseReviewArtifact,
  validatePlacement,
  type ValidationProblem,
} from "../../src/tools/review-validator";
import { coverageOfPatch, isComplete, type CoverageReport } from "../../src/tools/review-coverage";
import { coverageReportLines } from "../coverage-report";
import { artifactDiff } from "../git";
import { EXIT_CANNOT_RUN, EXIT_PROBLEMS, EXIT_READY, type LocalContext } from "../context";
import { errorMessage } from "../errors";

// `rvw check <artifact>` — the one gate an agent runs before handing a review over. It
// composes the same parse + placement check `rvw validate` runs with the same
// `coverageOfPatch` `rvw coverage` runs, both over one diff re-derived from the artifact's
// `source` (a rare embedded/frozen artifact supplies it directly). The composition is where
// the two severities are kept distinct: a mis-anchor is a hard failure — an artifact whose
// anchors do not place cannot open clean — while an uncovered changed line is a warning,
// because a strong review may deliberately skip trivia. Only `--require-complete` promotes a
// coverage gap to a failure.
//
// Validation runs first and short-circuits: an artifact that does not parse, or whose anchors
// do not place, has nothing sound to measure, so it reports validation problems and no
// coverage — the shape `CheckReport` makes explicit. A diff that will not re-derive is a
// shell-cannot-run (exit 2). Placement's `missingPatch` already caught a diff-less range as a
// validation problem, so by the time coverage runs the universe is guaranteed present: the
// coverage guard below can only fire if the cores contradict each other, which is a bug, not a
// review outcome.

type CheckFlags = {
  readonly json?: boolean;
  readonly requireComplete?: boolean;
};

/** The composite outcome. Modelled as a union on which stage decided it, so "refused by
 * validation" can never carry a coverage report it never computed, and a coverage verdict
 * always carries the report it was read from. `ok` is the exit-0 predicate either way. */
export type CheckReport =
  | { readonly ok: false; readonly stage: "validate"; readonly problems: ValidationProblem[] }
  | {
      readonly ok: boolean;
      readonly stage: "coverage";
      readonly complete: boolean;
      readonly requireComplete: boolean;
      readonly coverage: CoverageReport;
    };

export const checkCommand = buildCommand<CheckFlags, [string], LocalContext>({
  docs: {
    brief: "The pre-handoff gate: validate (hard-fail) then coverage (warn, or fail on request)",
    fullDescription: [
      "Runs the same validator `rvw validate` runs and the same coverage `rvw coverage` runs,",
      "as one gate with one exit code, over one diff re-derived from the artifact's own branch",
      "(so the repo must be present; a rare embedded/frozen artifact supplies it directly).",
      "Validation is a hard failure: an anchor that does not place, a description link that does",
      "not resolve, or a range with no changes exits 1 and coverage is not reported (there is",
      "nothing sound to measure). Coverage is advisory: a gap prints a warning and still exits 0,",
      "unless --require-complete promotes it to exit 1. Exit 2 when the artifact cannot be read or",
      "its diff cannot be re-derived.",
    ].join("\n"),
    customUsage: [
      "draft.reviewer.json",
      "draft.reviewer.json --require-complete",
      "draft.reviewer.json --json",
    ],
  },
  parameters: {
    flags: {
      json: {
        kind: "boolean",
        brief: "Emit the structured CheckReport as JSON on stdout for an agent to parse",
        optional: true,
      },
      requireComplete: {
        kind: "boolean",
        brief: "Promote a coverage gap from a warning to exit 1 (opt-in completeness gate)",
        optional: true,
      },
    },
    positional: {
      kind: "tuple",
      parameters: [{ brief: "Path to the .reviewer.json artifact", parse: String }],
    },
  },
  func(this: LocalContext, flags: CheckFlags, artifact: string): void {
    let bytes: string;
    try {
      bytes = readFileSync(artifact, "utf8");
    } catch (error) {
      this.process.stderr.write(`cannot read ${artifact}: ${errorMessage(error)}\n`);
      this.process.exitCode = EXIT_CANNOT_RUN;
      return;
    }

    const parsed = parseReviewArtifact(bytes);
    if (!parsed.ok) {
      writeValidationFailure(this, flags, artifact, parsed.problems);
      this.process.exitCode = EXIT_PROBLEMS;
      return;
    }

    const capture = artifactDiff(parsed.artifact);
    if (!capture.ok) {
      // The diff could not be re-derived (repo/ref gone or oversized): neither stage ran, so
      // it is a shell-cannot-run (exit 2), not a review verdict.
      this.process.stderr.write(`${capture.message}\n`);
      this.process.exitCode = EXIT_CANNOT_RUN;
      return;
    }

    const problems = validatePlacement(parsed.artifact, capture.patch);
    if (problems.length > 0) {
      writeValidationFailure(this, flags, artifact, problems);
      this.process.exitCode = EXIT_PROBLEMS;
      return;
    }

    // Unreachable in practice: placement's `missingPatch` already caught a diff-less range as a
    // validation problem above, so coverage always has a universe here. Handled rather than
    // asserted away, because the alternative is a cast — and if the two cores ever disagree,
    // exit 2 says "could not run" instead of reporting a coverage number nobody computed.
    const coverage = coverageOfPatch(capture.patch, parsed.artifact.layers);
    if (!coverage.ok) {
      this.process.stderr.write(`${artifact}: placed but has no diff to score — this is a bug\n`);
      this.process.exitCode = EXIT_CANNOT_RUN;
      return;
    }

    const complete = isComplete(coverage.report);
    const requireComplete = flags.requireComplete === true;
    const ok = complete || !requireComplete;
    const report: CheckReport = {
      ok,
      stage: "coverage",
      complete,
      requireComplete,
      coverage: coverage.report,
    };

    if (flags.json) {
      this.process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      writeCoverageOutcome(this, artifact, report);
    }
    this.process.exitCode = ok ? EXIT_READY : EXIT_PROBLEMS;
  },
});

/** The hard-fail arm: each problem with its exact locator, so the agent edits the draft
 * rather than guessing. Structured on `--json` under the same `CheckReport` union. */
function writeValidationFailure(
  context: LocalContext,
  flags: CheckFlags,
  artifact: string,
  problems: ValidationProblem[],
): void {
  if (flags.json) {
    const report: CheckReport = { ok: false, stage: "validate", problems };
    context.process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  context.process.stderr.write(`${artifact}: ${problems.length} problem(s) — not ready\n`);
  for (const problem of problems) {
    context.process.stderr.write(`  - ${describeProblem(problem)}\n`);
  }
}

/** The coverage arm, reusing `rvw coverage`'s own rendering so the numbers read identically
 * whichever verb produced them. The trailing line is where the advisory/gated distinction
 * becomes visible: a gap warns on stderr but leaves stdout's report intact. */
function writeCoverageOutcome(
  context: LocalContext,
  artifact: string,
  report: Extract<CheckReport, { stage: "coverage" }>,
): void {
  context.process.stdout.write(`${artifact}: valid — every anchor places, every link resolves\n`);
  for (const line of coverageReportLines(artifact, report.coverage)) {
    context.process.stdout.write(`${line}\n`);
  }

  if (report.complete) {
    context.process.stdout.write("ready to hand over — valid and every changed line covered\n");
    return;
  }
  if (report.requireComplete) {
    context.process.stderr.write(
      "incomplete: a coverable changed line is in no layer (--require-complete)\n",
    );
    return;
  }
  context.process.stderr.write(
    "warning: a coverable changed line is in no layer — add a layer, or hand over deliberately\n",
  );
}
