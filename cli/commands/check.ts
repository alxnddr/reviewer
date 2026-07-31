import { readFileSync } from "node:fs";
import { buildCommand } from "@stricli/core";
import {
  describeProblem,
  parseReviewArtifact,
  validatePlacement,
  type ValidationProblem,
} from "../../src/tools/review-validator";
import {
  coverageOfPatch,
  isFullyCovered,
  layerExtentsOf,
  type CoverageReport,
} from "../../src/tools/review-coverage";
import { errorMessage } from "../../src/shared/errors";
import { coverageSummaryLines } from "../coverage-report";
import { artifactDiff } from "../git";
import { EXIT_PROBLEMS, EXIT_READY, type LocalContext } from "../context";
import { writeCannotRun, writeJson } from "../errors";

// `rvw check <artifact>` — the one question an agent asks about a review it already has: does
// this open clean? It is the whole of the old `validate` (parse + placement, hard-fail) with
// the old `coverage` folded in behind `--coverage`, over one diff re-derived from the
// artifact's own repo/refs — a rare embedded/frozen artifact supplies it directly.
//
// Two severities, kept distinct. A mis-anchor is a hard failure: an artifact whose anchors do
// not place cannot open clean. An uncovered changed line is at most a warning, because a strong
// review may deliberately skip trivia, and only `--require-complete` promotes it.
//
// Coverage is opt-in rather than default, and the warning is conditional, for the same reason:
// `layers` is optional now, so telling a comments-only review that "a coverable changed line is
// in no layer" is telling it off for a walkthrough it never claimed to write. A review with no
// layers has no coverage story to be incomplete about, so it is not given one.
//
// Validation runs first and short-circuits: an artifact that does not parse, or whose anchors
// do not place, has nothing sound to measure, so it reports validation problems and no coverage
// — the shape `CheckReport` makes explicit. A diff that will not re-derive is a
// shell-cannot-run (exit 2). Placement's `missingPatch` already caught a diff-less range as a
// validation problem, so by the time coverage runs the universe is guaranteed present: the
// coverage guard below can only fire if the cores contradict each other, which is a bug, not a
// review outcome.

type CheckFlags = {
  readonly json?: boolean;
  readonly coverage?: boolean;
  readonly requireComplete?: boolean;
};

/** The composite outcome. Modelled as a union on which stage decided it, so "refused by
 * validation" can never carry a coverage report it never computed, and a coverage verdict
 * always carries the report it was read from. The plain `stage: "validate"` pass is the
 * default run's answer: valid, and coverage was never asked for. `ok` is the exit-0 predicate
 * in every arm. */
export type CheckReport =
  | { readonly ok: false; readonly stage: "validate"; readonly problems: ValidationProblem[] }
  | { readonly ok: true; readonly stage: "validate" }
  | {
      readonly ok: boolean;
      readonly stage: "coverage";
      readonly complete: boolean;
      readonly requireComplete: boolean;
      readonly coverage: CoverageReport;
    };

export const checkCommand = buildCommand<CheckFlags, [string], LocalContext>({
  docs: {
    brief: "The pre-handoff gate: does this artifact open clean? (--coverage to also score it)",
    fullDescription: [
      "Runs the same parse and placement check the app anchors with, over one diff re-derived",
      "from the artifact's own branch (so the repo must be present; a rare embedded/frozen",
      "artifact supplies it directly). An anchor that does not place, a description link that",
      "does not resolve, or a range with no changes is a hard failure: exit 1, each problem with",
      "its exact locator. --coverage adds which changed lines sit in no layer — a headline and a",
      "per-file rollup in text, the whole report under --json. A gap warns and still exits 0",
      "(and does not even warn when the review has no layers), unless --require-complete",
      "promotes it to exit 1. Exit 2 when the artifact cannot be read or its diff cannot be",
      "re-derived.",
    ].join("\n"),
    customUsage: [
      "change.reviewer.json",
      "change.reviewer.json --coverage",
      "change.reviewer.json --require-complete",
      "change.reviewer.json --json",
    ],
  },
  parameters: {
    flags: {
      json: {
        kind: "boolean",
        brief: "Emit the structured CheckReport as JSON on stdout for an agent to parse",
        optional: true,
      },
      coverage: {
        kind: "boolean",
        brief: "Also report which changed lines sit in no layer",
        optional: true,
      },
      requireComplete: {
        kind: "boolean",
        brief: "Promote a coverage gap from a warning to exit 1 (implies --coverage)",
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
      writeCannotRun(this, flags.json, {
        code: "artifactUnreadable",
        message: `cannot read ${artifact}: ${errorMessage(error)}`,
      });
      return;
    }

    const parsed = parseReviewArtifact(bytes);
    if (!parsed.ok) {
      writeValidationFailure(this, flags, artifact, parsed.problems);
      this.process.exitCode = EXIT_PROBLEMS;
      return;
    }

    const capture = artifactDiff(this.env, parsed.artifact);
    if (!capture.ok) {
      // The diff could not be re-derived (repo/ref gone or oversized): neither stage ran, so
      // it is a shell-cannot-run (exit 2), not a review verdict.
      writeCannotRun(this, flags.json, { code: "gitFailed", message: capture.message });
      return;
    }

    const problems = validatePlacement(parsed.artifact, capture.patch);
    if (problems.length > 0) {
      writeValidationFailure(this, flags, artifact, problems);
      this.process.exitCode = EXIT_PROBLEMS;
      return;
    }

    // `--require-complete` is a stronger statement of the same request, so asking for the gate
    // implies asking for the report — a caller should never have to pass both.
    const requireComplete = flags.requireComplete === true;
    if (flags.coverage !== true && !requireComplete) {
      const report: CheckReport = { ok: true, stage: "validate" };
      if (flags.json === true) {
        writeJson(this, report);
      } else {
        this.process.stdout.write(
          `${artifact}: valid — every anchor places, every link resolves\n`,
        );
      }
      this.process.exitCode = EXIT_READY;
      return;
    }

    // Unreachable in practice: placement's `missingPatch` already caught a diff-less range as a
    // validation problem above, so coverage always has a universe here. Handled rather than
    // asserted away, because the alternative is a cast — and if the two cores ever disagree,
    // exit 2 says "could not run" instead of reporting a coverage number nobody computed.
    const coverage = coverageOfPatch(capture.patch, layerExtentsOf(parsed.artifact.layers));
    if (!coverage.ok) {
      writeCannotRun(this, flags.json, {
        code: "internal",
        message: `${artifact}: placed but has no diff to score — this is a bug`,
      });
      return;
    }

    const complete = isFullyCovered(coverage.report);
    const ok = complete || !requireComplete;
    const report: CheckReport = {
      ok,
      stage: "coverage",
      complete,
      requireComplete,
      coverage: coverage.report,
    };

    if (flags.json === true) {
      writeJson(this, report);
    } else {
      writeCoverageOutcome(this, artifact, report, parsed.artifact.layers.length > 0);
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
  if (flags.json === true) {
    const report: CheckReport = { ok: false, stage: "validate", problems };
    writeJson(context, report);
    return;
  }
  context.process.stderr.write(`${artifact}: ${problems.length} problem(s) — not ready\n`);
  for (const problem of problems) {
    context.process.stderr.write(`  - ${describeProblem(problem)}\n`);
  }
}

/** The coverage arm: the headline and the per-file rollup on stdout, then the one line that
 * says what the number means. `hasLayers` is why the last branch exists — a review that authored
 * no walkthrough is not incomplete, it is a different kind of review, and warning it about
 * uncovered lines would make the common case noisy for nothing. */
function writeCoverageOutcome(
  context: LocalContext,
  artifact: string,
  report: Extract<CheckReport, { stage: "coverage" }>,
  hasLayers: boolean,
): void {
  context.process.stdout.write(`${artifact}: valid — every anchor places, every link resolves\n`);
  for (const line of coverageSummaryLines(report.coverage)) {
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
  if (hasLayers) {
    context.process.stderr.write(
      "warning: a coverable changed line is in no layer — add a layer, or hand over deliberately\n",
    );
  }
}
