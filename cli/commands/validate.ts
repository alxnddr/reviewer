import { readFileSync } from "node:fs";
import { buildCommand } from "@stricli/core";
import {
  describeProblem,
  parseReviewArtifact,
  validatePlacement,
  type ValidationReport,
} from "../../src/tools/review-validator";
import { artifactDiff } from "../git";
import { EXIT_CANNOT_RUN, EXIT_PROBLEMS, EXIT_READY, type LocalContext } from "../context";
import { errorMessage } from "../errors";

// `rvw validate <artifact>` — reuses the same pure parse + placement core the app anchors
// with: a second validation path would drift from what actually opens in Reviewer. For a
// refs-only artifact (the CLI's default) it re-derives the diff from the artifact's own
// `source` — so validation measures against the exact `base...head` the app renders — falling
// back to a rare embedded frozen patch. The command owns only the shell effects — reading the
// untrusted bytes, running git, and declaring an exit code — and formats the pure report two
// ways: a per-problem text report for a human, the structured report as JSON for an agent.

type ValidateFlags = {
  readonly json?: boolean;
};

export const validateCommand = buildCommand<ValidateFlags, [string], LocalContext>({
  docs: {
    brief: "Check a .reviewer.json — every anchor places, every description link resolves",
    fullDescription: [
      "Reads the artifact as untrusted bytes and runs the same pure placement check the app",
      "anchors with. A refs-only artifact (the CLI default) re-derives its diff from the",
      "artifact's own branch — so the repo must be present; a rare embedded/frozen artifact",
      "validates offline. Exit 0 when it is ready to hand over, 1 when it ran and found problems",
      "(each printed with its exact locator), 2 when the file cannot be read or the diff cannot",
      "be re-derived (repo or ref gone, or the diff is oversized).",
    ].join("\n"),
    customUsage: ["draft.reviewer.json", "draft.reviewer.json --json"],
  },
  parameters: {
    flags: {
      json: {
        kind: "boolean",
        brief: "Emit the structured ValidationReport as JSON on stdout for an agent to parse",
        optional: true,
      },
    },
    positional: {
      kind: "tuple",
      parameters: [{ brief: "Path to the .reviewer.json artifact", parse: String }],
    },
  },
  func(this: LocalContext, flags: ValidateFlags, artifact: string): void {
    let bytes: string;
    try {
      bytes = readFileSync(artifact, "utf8");
    } catch (error) {
      // Unreadable input is a shell failure (exit 2), not a validation problem (exit 1):
      // the check never ran, so a caller must tell "could not run" from "ran, not ready".
      this.process.stderr.write(`cannot read ${artifact}: ${errorMessage(error)}\n`);
      this.process.exitCode = EXIT_CANNOT_RUN;
      return;
    }

    const parsed = parseReviewArtifact(bytes);
    let report: ValidationReport;
    if (!parsed.ok) {
      report = { ok: false, problems: parsed.problems };
    } else {
      const capture = artifactDiff(parsed.artifact);
      if (!capture.ok) {
        // The diff could not be re-derived (repo/ref gone or oversized) — the check never
        // ran against a diff, so it is a shell-cannot-run (exit 2), not a validation problem.
        this.process.stderr.write(`${capture.message}\n`);
        this.process.exitCode = EXIT_CANNOT_RUN;
        return;
      }
      const problems = validatePlacement(parsed.artifact, capture.patch);
      report = problems.length === 0 ? { ok: true } : { ok: false, problems };
    }

    if (flags.json) {
      this.process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      this.process.exitCode = report.ok ? EXIT_READY : EXIT_PROBLEMS;
      return;
    }

    if (report.ok) {
      this.process.stdout.write(`${artifact}: valid — every anchor places, every link resolves\n`);
      this.process.exitCode = EXIT_READY;
      return;
    }

    this.process.stderr.write(`${artifact}: ${report.problems.length} problem(s)\n`);
    for (const problem of report.problems) {
      this.process.stderr.write(`  - ${describeProblem(problem)}\n`);
    }
    this.process.exitCode = EXIT_PROBLEMS;
  },
});
