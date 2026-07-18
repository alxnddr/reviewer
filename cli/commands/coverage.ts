import { readFileSync } from "node:fs";
import { buildCommand } from "@stricli/core";
import * as z from "zod";
import { ReviewLayer } from "../../src/shared/review";
import { coverageOfPatch, isComplete, type CoverageReport } from "../../src/tools/review-coverage";
import { parseReviewArtifact } from "../../src/tools/review-validator";
import { coverageReportLines } from "../coverage-report";
import { artifactDiff, capturePatch } from "../git";
import { EXIT_CANNOT_RUN, EXIT_PROBLEMS, EXIT_READY, type LocalContext } from "../context";
import { errorMessage } from "../errors";

// `rvw coverage` — which changed lines sit in no layer, so an authoring agent learns to add
// another layer. Two ways in, one core (`coverageOfPatch`): a finished artifact
// (`rvw coverage <artifact>`) or a range + in-progress draft
// (`rvw coverage --repo/--base/--head/--draft`) so the agent checks completeness mid-draft,
// before any artifact is emitted. Coverage is advisory by default (exit 0 even with a gap);
// `--require-complete` is the opt-in gate a review uses when it means to cover everything,
// never a blanket rule.

type CoverageFlags = {
  readonly json?: boolean;
  readonly requireComplete?: boolean;
  readonly repo?: string;
  readonly base?: string;
  readonly head?: string;
  readonly draft?: string;
};

/** The two knobs that shape a report's output — `--json` picks the machine form,
 * `--require-complete` turns a remaining gap into exit 1. Named so `finish` takes only
 * what it uses, not the whole flag bag (no god props). */
type ReportOptions = {
  readonly json?: boolean;
  readonly requireComplete?: boolean;
};

/** The draft a `--draft` run measures — untrusted hand-authored content, so it is parsed,
 * not trusted. Only `layers` bears on coverage; any `comments` are ignored
 * (stripped by the object parse). Absent `layers` is a legitimate early-draft state — the
 * whole diff is then a gap, which is exactly the signal that drives the author to add a
 * layer — so it defaults to none rather than being rejected. */
const CoverageDraft = z.object({ layers: z.array(ReviewLayer).optional() });

export const coverageCommand = buildCommand<CoverageFlags, [string | undefined], LocalContext>({
  docs: {
    brief: "Report which changed lines are covered by a layer and which sit in no layer",
    fullDescription: [
      "Reports, at file and line-span granularity, which changed lines a layer covers, over",
      "either a finished artifact (positional) — whose diff is re-derived from its own branch, so",
      "the repo must be present — or a live range measured against an in-progress draft",
      "(--repo/--base/--head/--draft). A file with no line to anchor into — a binary, a pure",
      "rename, a mode-only change — is listed non-coverable, never as a gap. Exit 0 always (the",
      "report is advisory) except: 1 under --require-complete when a coverable gap remains; 2 when",
      "the input cannot be read or parsed, its diff cannot be re-derived, or the range has no diff",
      "to compute against.",
    ].join("\n"),
    customUsage: [
      "draft.reviewer.json",
      "draft.reviewer.json --require-complete",
      "--repo . --base main --head feature --draft draft.json",
      "--repo . --base main --head feature --draft draft.json --require-complete",
    ],
  },
  parameters: {
    flags: {
      json: {
        kind: "boolean",
        brief: "Emit the structured CoverageReport as JSON on stdout for an agent to parse",
        optional: true,
      },
      requireComplete: {
        kind: "boolean",
        brief: "Exit 1 when any coverable changed line is in no layer (opt-in completeness gate)",
        optional: true,
      },
      repo: {
        kind: "parsed",
        parse: String,
        brief: "Live range: path to the target git repo (with --base/--head/--draft)",
        optional: true,
      },
      base: {
        kind: "parsed",
        parse: String,
        brief: "Live range base — a branch name or full sha",
        optional: true,
      },
      head: {
        kind: "parsed",
        parse: String,
        brief: "Live range head — a branch name or full sha",
        optional: true,
      },
      draft: {
        kind: "parsed",
        parse: String,
        brief: "Live range: path to the in-progress draft JSON to measure ({ layers: [...] })",
        optional: true,
      },
    },
    positional: {
      kind: "tuple",
      parameters: [
        { brief: "Path to a finished .reviewer.json artifact", parse: String, optional: true },
      ],
    },
  },
  func(this: LocalContext, flags: CoverageFlags, artifact: string | undefined): void {
    if (flags.draft !== undefined) {
      runDraft(this, flags, flags.draft);
      return;
    }
    if (artifact !== undefined) {
      runEmbedded(this, flags, artifact);
      return;
    }
    this.process.stderr.write(
      "usage: rvw coverage <artifact> | rvw coverage --repo <path> --base <ref> --head <ref> --draft <draft.json>\n",
    );
    this.process.exitCode = EXIT_CANNOT_RUN;
  },
});

/** Coverage of a finished artifact, over the diff re-derived from its own `source` (a rare
 * embedded/frozen artifact supplies it directly). Unlike `validate`, coverage cannot
 * report on an artifact it cannot parse: an unparseable or schema-invalid file has no universe
 * to compute, so it is a shell-cannot-run (exit 2), not a coverage problem — `validate` is the
 * command that turns a malformed artifact into an exit-1 finding. A diff that will not
 * re-derive (repo/ref gone or oversized) is the same exit 2, for the same "nothing to compute"
 * reason. */
function runEmbedded(context: LocalContext, flags: CoverageFlags, artifact: string): void {
  let bytes: string;
  try {
    bytes = readFileSync(artifact, "utf8");
  } catch (error) {
    context.process.stderr.write(`cannot read ${artifact}: ${errorMessage(error)}\n`);
    context.process.exitCode = EXIT_CANNOT_RUN;
    return;
  }

  const parsed = parseReviewArtifact(bytes);
  if (!parsed.ok) {
    context.process.stderr.write(
      `cannot compute coverage: ${artifact} is not a valid review artifact (run \`rvw validate\`)\n`,
    );
    context.process.exitCode = EXIT_CANNOT_RUN;
    return;
  }

  const capture = artifactDiff(parsed.artifact);
  if (!capture.ok) {
    context.process.stderr.write(`${capture.message}\n`);
    context.process.exitCode = EXIT_CANNOT_RUN;
    return;
  }

  const result = coverageOfPatch(capture.patch, parsed.artifact.layers);
  if (!result.ok) {
    context.process.stderr.write(
      `cannot compute coverage: ${artifact} has no diff to compute against\n`,
    );
    context.process.exitCode = EXIT_CANNOT_RUN;
    return;
  }

  finish(context, flags, artifact, result.report);
}

/** Coverage of a live range against an in-progress draft: capture the range's patch and
 * measure the draft's layers against it *before* any artifact is emitted,
 * so completeness is an authoring aid, not a post-hoc audit. A git failure / bad ref /
 * oversized diff, or an unreadable/non-object draft, is a shell-cannot-run (exit 2). */
function runDraft(context: LocalContext, flags: CoverageFlags, draftPath: string): void {
  if (flags.repo === undefined || flags.base === undefined || flags.head === undefined) {
    context.process.stderr.write(
      "usage: rvw coverage --repo <path> --base <ref> --head <ref> --draft <draft.json>\n",
    );
    context.process.exitCode = EXIT_CANNOT_RUN;
    return;
  }

  const capture = capturePatch(flags.repo, flags.base, flags.head);
  if (!capture.ok) {
    context.process.stderr.write(`${capture.message}\n`);
    context.process.exitCode = EXIT_CANNOT_RUN;
    return;
  }

  let bytes: string;
  try {
    bytes = readFileSync(draftPath, "utf8");
  } catch (error) {
    context.process.stderr.write(`cannot read draft ${draftPath}: ${errorMessage(error)}\n`);
    context.process.exitCode = EXIT_CANNOT_RUN;
    return;
  }

  let json: unknown;
  try {
    json = JSON.parse(bytes);
  } catch (error) {
    context.process.stderr.write(
      `cannot compute coverage: draft ${draftPath} is not valid JSON: ${errorMessage(error)}\n`,
    );
    context.process.exitCode = EXIT_CANNOT_RUN;
    return;
  }
  const parsed = CoverageDraft.safeParse(json);
  if (!parsed.success) {
    context.process.stderr.write(
      `cannot compute coverage: draft ${draftPath} has no valid \`layers\` (see \`rvw schema\`)\n`,
    );
    context.process.exitCode = EXIT_CANNOT_RUN;
    return;
  }

  const result = coverageOfPatch(capture.patch, parsed.data.layers ?? []);
  if (!result.ok) {
    context.process.stderr.write(
      `cannot compute coverage: ${flags.base}...${flags.head} has no diff to compute against\n`,
    );
    context.process.exitCode = EXIT_CANNOT_RUN;
    return;
  }

  finish(context, flags, draftPath, result.report);
}

/** Emit the report (JSON or text) and set the exit code — the one place the `--json` /
 * `--require-complete` contract lives, shared by both input modes. Typed to `ReportOptions`
 * so it declares the only two flags it reads, not the whole flag bag. */
function finish(
  context: LocalContext,
  options: ReportOptions,
  label: string,
  report: CoverageReport,
): void {
  if (options.json) {
    context.process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const line of coverageReportLines(label, report)) {
      context.process.stdout.write(`${line}\n`);
    }
  }
  context.process.exitCode =
    options.requireComplete && !isComplete(report) ? EXIT_PROBLEMS : EXIT_READY;
}
