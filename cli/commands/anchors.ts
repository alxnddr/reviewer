import { buildCommand } from "@stricli/core";
import {
  changedLineUniverse,
  type ChangedSpan,
  type FileUniverse,
} from "../../src/tools/review-coverage";
import { describeReason } from "../coverage-report";
import { capturePatch } from "../git";
import { EXIT_CANNOT_RUN, EXIT_READY, type LocalContext } from "../context";

// `rvw anchors` — list a range's changed-line universe: the exact per-file, per-side spans
// an anchor may fall in, so anchors target real line numbers rather than guesses. Read-only
// — nothing is written (that is `rvw emit`). The spans are the same changed-line universe
// `rvw coverage` measures against, so an anchor authored from this listing lands inside what
// coverage will later score.

type AnchorsFlags = {
  readonly repo: string;
  readonly base: string;
  readonly head: string;
  readonly json?: boolean;
};

export const anchorsCommand = buildCommand<AnchorsFlags, [], LocalContext>({
  docs: {
    brief: "List the changed-line universe of a range so anchors target real line numbers",
    fullDescription: [
      "Captures the range's byte-stable patch and prints, per changed file and per side, the",
      "contiguous changed spans an anchor may fall in — the exact universe `rvw coverage`",
      "scores against. A file with no line to anchor into — a binary, a pure rename, a mode-only",
      "change — is listed non-coverable.",
      "Text mode is a readable listing; --json is the machine form an agent reads to author a",
      "draft's anchors. Exit 0 on a captured range; 2 when git cannot produce the diff.",
    ].join("\n"),
    customUsage: [
      "--repo . --base main --head feature",
      "--repo . --base main --head feature --json",
    ],
  },
  parameters: {
    flags: {
      repo: {
        kind: "parsed",
        parse: String,
        brief: "Path to the target git repo (any dir within it)",
      },
      base: { kind: "parsed", parse: String, brief: "Range base — a branch name or full sha" },
      head: { kind: "parsed", parse: String, brief: "Range head — a branch name or full sha" },
      json: {
        kind: "boolean",
        brief: "Emit the changed-line universe as JSON for an agent to author anchors from",
        optional: true,
      },
    },
    positional: { kind: "tuple", parameters: [] },
  },
  func(this: LocalContext, flags: AnchorsFlags): void {
    const capture = capturePatch(flags.repo, flags.base, flags.head);
    if (!capture.ok) {
      this.process.stderr.write(`${capture.message}\n`);
      this.process.exitCode = EXIT_CANNOT_RUN;
      return;
    }

    const universe = changedLineUniverse(capture.patch);

    if (flags.json) {
      this.process.stdout.write(`${JSON.stringify(universe, null, 2)}\n`);
    } else {
      writeTextListing(this, flags.base, flags.head, universe);
    }
    this.process.exitCode = EXIT_READY;
  },
});

/** The human listing: a header naming the range, then each changed file with its per-side
 * spans (or its non-coverable reason). A pure formatter so the command body stays a thin
 * capture-and-write. */
function writeTextListing(
  context: LocalContext,
  base: string,
  head: string,
  universe: FileUniverse[],
): void {
  if (universe.length === 0) {
    context.process.stdout.write(`anchors ${base}...${head}: no changed files\n`);
    return;
  }
  context.process.stdout.write(`anchors ${base}...${head}: ${universe.length} changed file(s)\n`);
  for (const file of universe) {
    if (!file.coverable) {
      context.process.stdout.write(
        `  non-coverable  ${file.file} (${describeReason(file.reason)})\n`,
      );
      continue;
    }
    context.process.stdout.write(`  ${file.status.padEnd(13)}  ${file.file}\n`);
    for (const span of file.spans) {
      context.process.stdout.write(`    ${describeSpan(span)}\n`);
    }
  }
}

function describeSpan(span: ChangedSpan): string {
  return `${span.side.padEnd(9)} ${span.startLine}-${span.endLine}`;
}
