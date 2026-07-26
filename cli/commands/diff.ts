import { buildCommand } from "@stricli/core";
import { changedLineUniverse } from "../../src/tools/review-coverage";
import { capturePatch } from "../git";
import { resolveRange } from "../range";
import { EXIT_READY, type LocalContext } from "../context";
import { writeCannotRun } from "../errors";

// `rvw diff` — the diff the gate will judge against, printed. That is the whole idea, and it
// exists because the alternative was prose: the authoring instructions used to spell out
//
//   git -C <repo> -c core.quotepath=false -c diff.noprefix=false -c diff.mnemonicPrefix=false \
//       diff --find-renames --patch <base>...<head> --
//
// for the agent to run by hand, so that it read the same path bytes and line numbers `emit`
// would later capture. That is `rangeDiffArgs` — the CLI's own private capture config — copied
// into a document, where any drift between the two silently invalidates every anchor authored
// from it. Here the two cannot drift: this verb captures through the same `capturePatch` the
// gate does and writes the bytes out unchanged.
//
// `--json` answers the other question an author has, in the machine form: per file and per
// side, the contiguous changed spans, with the files that carry no anchorable line named as
// such. Note that placement is *more* permissive than that listing — a line inside a hunk's
// context places too — so the spans are where the change is, not the boundary of what is legal.
//
// Read-only: nothing is written (that is `rvw emit`), and the range flags default exactly as
// `emit`'s do, so what you read here is what you are about to author against.

type DiffFlags = {
  readonly repo?: string;
  readonly base?: string;
  readonly head?: string;
  readonly json?: boolean;
};

export const diffCommand = buildCommand<DiffFlags, [], LocalContext>({
  docs: {
    brief: "Print the range's diff — the exact patch anchors are placed against",
    fullDescription: [
      "Writes the byte-stable patch for base...head to stdout, verbatim: the same capture `rvw",
      "emit` gates against and the app re-derives on open, so an anchor authored from this diff",
      "places. Each of --repo/--base/--head defaults to the repo you are standing in, exactly as",
      "`rvw emit` resolves them. --json instead prints the changed-line universe: per file and",
      "per side, the contiguous changed spans, with binaries and pure renames named",
      "non-coverable. (An anchor may also land on a context line inside a hunk, so those spans",
      "are where the change is, not the limit of what places.) Exit 0 on a captured range; 2",
      "when the range cannot be resolved or git cannot produce the diff.",
    ].join("\n"),
    customUsage: ["", "--json", "--base main", "--repo . --base main --head feature --json"],
  },
  parameters: {
    flags: {
      repo: {
        kind: "parsed",
        parse: String,
        brief: "Path to the target git repo; default the cwd's work-tree toplevel",
        optional: true,
      },
      base: {
        kind: "parsed",
        parse: String,
        brief: "Range base — any revision git resolves; default the fork point",
        optional: true,
      },
      head: {
        kind: "parsed",
        parse: String,
        brief: "Range head — any revision git resolves; default the current branch",
        optional: true,
      },
      json: {
        kind: "boolean",
        brief: "Emit the changed-line universe as JSON instead of the patch",
        optional: true,
      },
    },
    positional: { kind: "tuple", parameters: [] },
  },
  func(this: LocalContext, flags: DiffFlags): void {
    const resolved = resolveRange(flags, process.cwd());
    if (!resolved.ok) {
      writeCannotRun(this, flags.json, resolved.error);
      return;
    }
    const { repoPath, base, head } = resolved.range;

    const capture = capturePatch(repoPath, base, head);
    if (!capture.ok) {
      writeCannotRun(this, flags.json, { code: "gitFailed", message: capture.message });
      return;
    }

    if (flags.json === true) {
      this.process.stdout.write(`${JSON.stringify(changedLineUniverse(capture.patch), null, 2)}\n`);
    } else {
      // Verbatim, and nothing else on the channel — no header naming the range, because the
      // point of this verb is that its stdout *is* a patch, pipeable into anything that reads
      // one. The range it resolved is `rvw emit --json`'s to report.
      this.process.stdout.write(capture.patch);
    }
    this.process.exitCode = EXIT_READY;
  },
});
