import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { buildCommand } from "@stricli/core";
import { REVIEW_EXTENSION } from "../../src/shared/review-file";
import { emitReviewArtifact } from "../../src/tools/review-emit";
import { describeProblem, type ValidationProblem } from "../../src/tools/review-validator";
import { capturePatch } from "../git";
import { reviewFileName, reviewsDir } from "../reviews-dir";
import { EXIT_CANNOT_RUN, EXIT_PROBLEMS, EXIT_READY, type LocalContext } from "../context";
import { errorMessage } from "../errors";

// `rvw emit` — captures the range's patch through the shared CLI runner (the same
// `capturePatch` `anchors`/`coverage --draft` use — one spawn posture, not a fork), folds in
// the agent's hand-authored draft, and hands the pieces to the pure `emitReviewArtifact` gate.
// The gate proves every anchor places against that captured diff, then writes a refs-only
// artifact (no embedded patch) the app re-derives live on open. Bytes reach disk only on a
// clean pass: a failing artifact has nothing to write, so a mis-anchored draft never becomes a
// file. `--out` is optional: without it the artifact lands in rvw's managed reviews dir
// (`cli/reviews-dir.ts`), never in the repo — the written path is printed either way, and
// `rvw open` reaches it wherever it is. Exit 2 = the shell could not run (bad flags, bad ref,
// git failure, unreadable draft, unwritable out); exit 1 = it ran and the gate refused (nothing
// written, each problem located); exit 0 = the artifact is written and ready to open.

/** What `--json` reports: the written path, or the gate's problems and the fact that nothing
 * was written. Named like every other verb's wire shape (`CoverageReport`, `CheckReport`) so an
 * agent parses one declared contract per verb, not an inline literal per branch. */
type EmitOutcome =
  | { readonly ok: true; readonly out: string }
  | { readonly ok: false; readonly problems: readonly ValidationProblem[] };

type EmitFlags = {
  readonly repo: string;
  readonly base: string;
  readonly head: string;
  readonly draft: string;
  readonly out?: string;
  readonly json?: boolean;
};

/** The two keys of an authored draft. Both stay `unknown` — untrusted hand-authored content
 * the single `emitReviewArtifact` authority schema-checks (parse-don't-trust); a shape check
 * here would be a drifting duplicate of `ReviewArtifact`. */
type EmitDraft = { comments?: unknown; layers?: unknown };

export const emitCommand = buildCommand<EmitFlags, [], LocalContext>({
  docs: {
    brief: "Validate a draft against a range's diff, then write a refs-only .reviewer.json",
    fullDescription: [
      "Captures the range's byte-stable patch through the shared CLI git runner, folds in",
      "the authored draft's comments and layers, and gates the assembled artifact through the same",
      "pure validator the app anchors with — every anchor proven to place against the captured diff,",
      "every description link proven to resolve — before writing any bytes. On a clean pass it writes",
      "a refs-only artifact (no embedded patch) the app re-derives live from the branch on open, so",
      "the branch must remain available. The file is written only on a clean pass, so a failing",
      "artifact never reaches disk. --out is optional and must end .reviewer.json; without it the",
      "artifact lands in rvw's managed reviews dir (~/.rvw/reviews, or $RVW_HOME/reviews) rather than",
      "the repo, and the written path is printed. Exit 0 when written; 1 when the gate refused (nothing",
      "written, each problem located); 2 when the shell could not run (bad flags, invalid ref, git",
      "failure, unreadable draft, unwritable out).",
    ].join("\n"),
    customUsage: [
      "--repo . --base main --head feature --draft draft.json",
      "--repo . --base main --head feature --draft draft.json --out change.reviewer.json",
      "--repo . --base main --head feature --draft draft.json --json",
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
      draft: {
        kind: "parsed",
        parse: String,
        brief: "Path to the authored draft JSON ({ comments, layers })",
      },
      out: {
        kind: "parsed",
        parse: String,
        brief:
          "Where to write the artifact (must end .reviewer.json); default ~/.rvw/reviews/<derived>",
        optional: true,
      },
      json: {
        kind: "boolean",
        brief: "Emit the outcome as JSON on stdout for an agent to parse",
        optional: true,
      },
    },
    positional: { kind: "tuple", parameters: [] },
  },
  func(this: LocalContext, flags: EmitFlags): void {
    // A given --out is checked before any spawn: an artifact the app cannot open is a usage
    // error, not work to do — surface it as exit 2 before capturing a diff we would discard.
    // An omitted --out needs no check: the default path is derived correct by construction.
    if (flags.out !== undefined && !flags.out.endsWith(REVIEW_EXTENSION)) {
      this.process.stderr.write(
        `--out must end with ${REVIEW_EXTENSION} so the artifact can be opened\n`,
      );
      this.process.exitCode = EXIT_CANNOT_RUN;
      return;
    }

    const capture = capturePatch(flags.repo, flags.base, flags.head);
    if (!capture.ok) {
      this.process.stderr.write(`${capture.message}\n`);
      this.process.exitCode = EXIT_CANNOT_RUN;
      return;
    }

    // The destination: the given --out, or a unique name in rvw's managed reviews dir when
    // none was given. The canonical `capture.repoPath` names the derived file, so the
    // default is only known now — nothing to fast-fail on above, since the tool built it.
    const out =
      flags.out ??
      join(
        reviewsDir(process.env, homedir()),
        reviewFileName(capture.repoPath, flags.base, flags.head, Date.now()),
      );

    let json: unknown;
    try {
      json = JSON.parse(readFileSync(flags.draft, "utf8"));
    } catch (error) {
      this.process.stderr.write(`cannot read draft ${flags.draft}: ${errorMessage(error)}\n`);
      this.process.exitCode = EXIT_CANNOT_RUN;
      return;
    }
    if (typeof json !== "object" || json === null) {
      this.process.stderr.write(
        `draft ${flags.draft} must be a JSON object with "comments" and "layers"\n`,
      );
      this.process.exitCode = EXIT_CANNOT_RUN;
      return;
    }
    const { comments, layers } = json as EmitDraft;

    // `capture.repoPath` is the canonical work-tree toplevel, so `source.repo.path` is the same
    // absolute root whatever dir `--repo` named, and `name` is its basename (matches RepoInfo).
    const result = emitReviewArtifact({
      repo: { path: capture.repoPath, name: basename(capture.repoPath) },
      base: flags.base,
      head: flags.head,
      patch: capture.patch,
      comments,
      layers,
    });

    if (!result.ok) {
      if (flags.json) {
        const outcome: EmitOutcome = { ok: false, problems: result.problems };
        this.process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
      } else {
        this.process.stderr.write(
          `${out} refused: ${result.problems.length} problem(s) — nothing written\n`,
        );
        for (const problem of result.problems) {
          this.process.stderr.write(`  - ${describeProblem(problem)}\n`);
        }
      }
      this.process.exitCode = EXIT_PROBLEMS;
      return;
    }

    try {
      // rvw owns the default reviews dir, so it creates it; a given --out's parent is the
      // caller's to have made (mkdir'ing it would be creating dirs they did not ask for).
      if (flags.out === undefined) {
        mkdirSync(dirname(out), { recursive: true });
      }
      writeFileSync(out, result.bytes);
    } catch (error) {
      // A filesystem failure the shell cannot run is exit 2, not an uncaught stack trace
      // escaping the documented exit codes (same contract as the draft read above).
      this.process.stderr.write(`cannot write ${out}: ${errorMessage(error)}\n`);
      this.process.exitCode = EXIT_CANNOT_RUN;
      return;
    }

    if (flags.json) {
      const outcome: EmitOutcome = { ok: true, out };
      this.process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
    } else {
      this.process.stdout.write(`${out}: written — every anchor places, every link resolves\n`);
    }
    this.process.exitCode = EXIT_READY;
  },
});
