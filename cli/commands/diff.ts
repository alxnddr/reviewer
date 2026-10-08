import { buildCommand } from "@stricli/core";
import { changedLineUniverse } from "../../src/tools/review-coverage";
import { capturePatch } from "../git";
import { resolveRange } from "../range";
import { EXIT_READY, type LocalContext } from "../context";
import { writeCannotRun, writeJson } from "../errors";

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
// `--json` answers the other two questions an author has, in the machine form: per file and
// per side, the contiguous changed spans (where the change is — what layers must cover) and the
// hunk extents (where an anchor is legal — context lines included, so the only place a
// `pre-existing` finding can be pinned), with the files that carry no anchorable line named as
// such. The extents came second: an author used to learn a hunk's boundary from the refusal's
// "nearest on that side", which meant failing once to find out where it could have succeeded.
// `pairs` came third: the same extents regrouped by hunk, both sides together, because `hunks`
// lists them per side and an author writing a range for each side of one hunk was matching the
// two lists up by position. Added beside `hunks`, not instead of it, so a consumer of the old
// shape reads on unchanged. Most layers need neither now — a whole-file range (`{ file }`)
// covers a file without naming a line.
//
// Read-only: nothing is written (that is `rvw emit`), and the range flags default exactly as
// `emit`'s do, so what you read here is what you are about to author against.
//
// A defaulted base is the one decision made here on the caller's behalf, and it used to be
// invisible: the patch carries no header, and on a pushed branch the base it picked could make
// the range a fraction of the work, or nothing. So the ref it was measured from is said — on
// **stderr**, in both modes, because stdout is a patch (or, under `--json`, a bare array an
// older consumer already parses) and must stay pipeable. Said only when the base was defaulted:
// a caller who named `--base` already knows.

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
      "`rvw emit` resolves them: committed history only, the base the fork point with the",
      "branch's upstream (unless that is its own pushed copy) or the default branch; the ref it",
      "was measured from is named on stderr. --json instead prints, per file, `spans`: the",
      "contiguous changed lines per side, which layers must cover; `hunks`: each hunk's extent",
      "per side, context lines included, which is where an anchor may sit (inside one hunk,",
      "never across two); and `pairs`: the same extents per hunk, `{ deletions, additions }`",
      "side by side (null where a hunk has no line on that side). A layer that owns a whole",
      'file needs none of these — `{ "file": path }` covers it. Binaries and pure renames are',
      "named non-coverable, with no hunks. Exit 0 on a captured range; 2 when the range cannot",
      "be resolved or git cannot produce the diff.",
    ].join("\n"),
    customUsage: ["", "--json", "--base main", "--repo . --base main --head feature --json"],
  },
  parameters: {
    flags: {
      repo: {
        kind: "parsed",
        placeholder: "path",
        parse: String,
        brief: "Path to the target git repo; default the cwd's work-tree toplevel",
        optional: true,
      },
      base: {
        kind: "parsed",
        placeholder: "ref",
        parse: String,
        brief: "Range base — any revision git resolves; default the fork point (named on stderr)",
        optional: true,
      },
      head: {
        kind: "parsed",
        placeholder: "ref",
        parse: String,
        brief: "Range head — any revision git resolves; default the current branch",
        optional: true,
      },
      json: {
        kind: "boolean",
        brief: "Print per file the changed spans and hunk extents (per side and paired) as JSON",
        optional: true,
      },
    },
    positional: { kind: "tuple", parameters: [] },
  },
  func(this: LocalContext, flags: DiffFlags): void {
    const resolved = resolveRange(this.env, flags, this.cwd);
    if (!resolved.ok) {
      writeCannotRun(this, flags.json, resolved.error);
      return;
    }
    const { repoPath, base, head, baseFrom } = resolved.range;

    const capture = capturePatch(this.env, repoPath, base, head);
    if (!capture.ok) {
      writeCannotRun(this, flags.json, { code: "gitFailed", message: capture.message });
      return;
    }

    if (baseFrom !== null) {
      this.process.stderr.write(
        `rvw diff: ${base}...${head} — base is the fork point with ${baseFrom}; pass --base to change it\n`,
      );
    }

    if (flags.json === true) {
      writeJson(this, changedLineUniverse(capture.patch));
    } else {
      // Verbatim, and nothing else on the channel — no header naming the range, because the
      // point of this verb is that its stdout *is* a patch, pipeable into anything that reads
      // one. The range it resolved is `rvw emit --json`'s to report.
      this.process.stdout.write(capture.patch);
    }
    this.process.exitCode = EXIT_READY;
  },
});
