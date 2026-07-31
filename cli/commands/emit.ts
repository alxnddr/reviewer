import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildCommand } from "@stricli/core";
import { errorMessage } from "../../src/shared/errors";
import { emitReviewArtifact } from "../../src/tools/review-emit";
import { describeProblem, type ValidationProblem } from "../../src/tools/review-validator";
import { capturePatch } from "../git";
import { launchReviewer } from "../launch";
import { resolveRange, type ResolvedRange } from "../range";
import { REVIEW_EXTENSION, reviewFileName, reviewsDir } from "../../src/shared/node/reviews-dir";
import { EXIT_PROBLEMS, EXIT_READY, type LocalContext } from "../context";
import { writeCannotRun, writeJson, type CliError } from "../errors";

// `rvw emit` — the one authoring verb, and the whole of "present this review". The calling
// agent has already done the review; everything this command asks of it beyond the findings
// themselves is friction, so everything that can be worked out is worked out:
//
//   - `--repo`/`--base`/`--head` default to the range the caller is standing in (`cli/range.ts`),
//     and the resolved three are echoed back so an auto-detected range is never silent;
//   - `--draft` defaults to **stdin**, because an agent holds its draft in memory and writing a
//     temp file into the repo it just reviewed is noise it then has to clean up;
//   - the artifact is **opened** on a clean write, so presenting a review is one call and there
//     is no path to capture and thread into a second one. `--no-open` is for a caller that
//     wants the file and not the window.
//
// What has not moved is the gate: the range's patch is captured through the shared runner, the
// draft is folded in, and the pure `emitReviewArtifact` proves every anchor places against that
// diff before a byte reaches disk. A refused draft is not a bad file, it is no file. On a clean
// pass the artifact is refs-only (no embedded patch) and lands in rvw's managed reviews dir
// unless `--out` says otherwise — never in the repo being reviewed. `--embed-patch` is the one
// exception, for the one case refs cannot serve: a review emitted somewhere the reader is not.
//
// Exit 2 = the shell could not run (bad flags, unresolvable ref, git failure, unreadable or
// empty draft, unwritable out); exit 1 = it ran and the gate refused (nothing written, each
// problem located); exit 0 = the artifact is written. A launch that fails *after* a clean write
// is still exit 0: the artifact is real, the window is not, and the caller is told which.

/** What `--json` reports. The success arm carries the resolved range as well as the path,
 * because the range is a decision this command made on the caller's behalf and a caller that
 * opted into JSON should not have to re-derive it. `opened` says whether the app was actually
 * asked to show it — false on `--no-open`, and false when the launch failed. */
type EmitOutcome =
  | {
      readonly ok: true;
      readonly out: string;
      readonly repo: string;
      readonly base: string;
      readonly head: string;
      readonly opened: boolean;
      /** Whether the diff rode along, so a CI job can assert it got the portable form
       * rather than discovering on the reader's machine that it did not. */
      readonly embedded: boolean;
    }
  | { readonly ok: false; readonly problems: readonly ValidationProblem[] };

type EmitFlags = {
  readonly repo?: string;
  readonly base?: string;
  readonly head?: string;
  readonly draft?: string;
  readonly out?: string;
  readonly open: boolean;
  readonly embedPatch?: boolean;
  readonly json?: boolean;
};

/** The keys of an authored draft, and the *only* ones: `emit` supplies `repo`/`base`/`head`
 * itself, so a draft that carries them is carrying decisions it does not own. All three stay
 * `unknown` — untrusted hand-authored content the single `emitReviewArtifact` authority
 * schema-checks (parse-don't-trust); a shape check here would be a drifting duplicate of
 * `ReviewArtifact`. */
type EmitDraft = { comments?: unknown; layers?: unknown; overview?: unknown };

/** stdin as a draft source, spelled the way every other tool spells it. Also the value
 * `--draft` takes when the caller wants to be explicit about piping. */
const STDIN = "-";

export const emitCommand = buildCommand<EmitFlags, [], LocalContext>({
  docs: {
    brief: "Present a review: gate the draft against the range's diff, write it, open it",
    fullDescription: [
      "Resolves the range (each of --repo/--base/--head defaults to the repo you are standing",
      "in), captures its byte-stable patch, folds in the draft's overview/comments/layers, and",
      "gates the assembled artifact through the same pure validator the app anchors with —",
      "every anchor proven to place against that diff, every description link proven to resolve",
      "— before writing any bytes. On a clean pass it writes a refs-only artifact (no embedded",
      "patch, so the branch must remain available) and hands it to the installed Reviewer;",
      "--no-open writes it and stops. --embed-patch carries the diff inside the artifact so it",
      "opens on a machine without the repo (CI); the diff is then frozen, so the app cannot",
      "expand context around a hunk or narrow to a subrange of commits.",
      "Name branches on --base/--head: a local branch is recorded as written and the review",
      "follows it, while a tag, HEAD, a rev expression or a sha is pinned to the commit it named.",
      "The draft is read from stdin unless --draft names a file, and its only keys are overview,",
      "comments, and layers — at least one of which must be present, and layers (the reading order",
      "the app tours the diff in) unless the review was asked for as comments alone.",
      "--out is optional and must end .reviewer.json; without it the artifact lands in rvw's",
      "managed reviews dir (~/.rvw/reviews, or $RVW_HOME/reviews) rather than the repo.",
      "Exit 0 when written (even if the launch failed — the file is real either way); 1 when the",
      "gate refused, nothing written and each problem located; 2 when the shell could not run.",
    ].join("\n"),
    customUsage: [
      "< draft.json",
      "--draft draft.json",
      "--base main --draft draft.json --json",
      "--repo . --base main --head feature --draft draft.json --no-open --out change.reviewer.json",
      "--base main --embed-patch --no-open --out review.reviewer.json",
    ],
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
        brief: "Range base — a branch where one fits (recorded as written); default the fork point",
        optional: true,
      },
      head: {
        kind: "parsed",
        parse: String,
        brief:
          "Range head — a branch where one fits (recorded as written); default the branch you are on",
        optional: true,
      },
      draft: {
        kind: "parsed",
        parse: String,
        brief: "Draft JSON ({ overview?, comments?, layers? }); default stdin, `-` for stdin",
        optional: true,
      },
      out: {
        kind: "parsed",
        parse: String,
        brief:
          "Where to write the artifact (must end .reviewer.json); default ~/.rvw/reviews/<derived>",
        optional: true,
      },
      open: {
        kind: "boolean",
        brief: "Open the written artifact in Reviewer (--no-open to just write it)",
        default: true,
      },
      embedPatch: {
        kind: "boolean",
        brief: "Carry the diff in the artifact so it opens without the repo (CI handoff)",
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
    // A given --out is checked before anything else: an artifact the app cannot open is a usage
    // error, not work to do — surface it before reading a draft or capturing a diff we would
    // discard. An omitted --out needs no check: the default path is derived correct by
    // construction.
    if (flags.out !== undefined && !flags.out.endsWith(REVIEW_EXTENSION)) {
      writeCannotRun(this, flags.json, {
        code: "badArtifactPath",
        message: `--out must end with ${REVIEW_EXTENSION} so the artifact can be opened`,
      });
      return;
    }

    // The draft is read before git runs, because "you gave me nothing to present" is a fact
    // about the call and costs no spawn to establish.
    const draft = readDraft(this, flags.draft);
    if (!draft.ok) {
      writeCannotRun(this, flags.json, draft.error);
      return;
    }

    const resolved = resolveRange(this.env, flags, this.cwd);
    if (!resolved.ok) {
      writeCannotRun(this, flags.json, resolved.error);
      return;
    }
    const { repoPath, base, head } = resolved.range;

    const capture = capturePatch(this.env, repoPath, base, head);
    if (!capture.ok) {
      writeCannotRun(this, flags.json, { code: "gitFailed", message: capture.message });
      return;
    }

    const out = outPathFor(this, flags.out, resolved.range, Date.now());

    const result = emitReviewArtifact({
      repo: repoPath,
      base,
      head,
      patch: capture.patch,
      embedPatch: flags.embedPatch === true,
      comments: draft.content.comments,
      layers: draft.content.layers,
      overview: draft.content.overview,
    });

    if (!result.ok) {
      if (flags.json === true) {
        const outcome: EmitOutcome = { ok: false, problems: result.problems };
        writeJson(this, outcome);
      } else {
        // Name the *draft*. The output path is not a candidate here — nothing was written, and
        // an earlier version of this message printed a timestamped path that never existed,
        // sending the agent to look for a file no run had ever created.
        this.process.stderr.write(
          `${draft.label} refused: ${result.problems.length} problem(s) — nothing written\n`,
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
      writeCannotRun(this, flags.json, {
        code: "writeFailed",
        message: `cannot write ${out}: ${errorMessage(error)}`,
      });
      return;
    }

    // Past this point the artifact exists, so nothing below may change the exit code. A launch
    // that fails is reported and then let go: the review is on disk and `rvw open` can retry it.
    let opened = false;
    if (flags.open) {
      const launched = launchReviewer(this.platform, out);
      if (launched.ok) {
        opened = true;
      } else {
        this.process.stderr.write(`${launched.message}\n`);
        this.process.stderr.write(`the artifact is written — retry with: rvw open ${out}\n`);
      }
    }

    // An empty range cannot carry a diff, so `--embed-patch` over one silently produces the
    // refs-only file it was asked not to. Report what was written, never what was requested.
    const embedded = flags.embedPatch === true && capture.patch.length > 0;

    if (flags.json === true) {
      const outcome: EmitOutcome = {
        ok: true,
        out,
        repo: repoPath,
        base,
        head,
        opened,
        embedded,
      };
      writeJson(this, outcome);
    } else {
      // The range first: it is the one thing this command may have decided on the caller's
      // behalf, so a defaulted `--base` is never a surprise discovered later in the app.
      this.process.stdout.write(`${repoPath}: ${base}...${head}\n`);
      this.process.stdout.write(`${out}: written — every anchor places, every link resolves\n`);
      if (embedded) {
        this.process.stdout.write(`the diff is embedded — this artifact opens without the repo\n`);
      }
      if (opened) {
        this.process.stdout.write(`opening ${out} in Reviewer\n`);
      }
    }
    this.process.exitCode = EXIT_READY;
  },
});

/** Where the artifact lands: the given `--out`, or a unique name in rvw's managed reviews dir
 * when none was given. Resolved absolute — against the caller's cwd, the same directory their
 * shell would have resolved a relative `--out` against — because that is what the launcher
 * requires: an `open` launch does not control the working directory a relative path would
 * resolve against. The default's two halves are the context's too (`$RVW_HOME`, else
 * `~/.rvw/reviews` under `home`) and `stamp` is the command's `Date.now()`, so where an
 * `--out`-less emit writes is proven without a repo to emit from. */
export function outPathFor(
  context: LocalContext,
  out: string | undefined,
  range: ResolvedRange,
  stamp: number,
): string {
  return resolve(
    context.cwd,
    out ??
      join(
        reviewsDir(context.env, context.home),
        reviewFileName(range.repoPath, range.base, range.head, stamp),
      ),
  );
}

/** A draft that parsed, with the label an error message should call it by — the file's path,
 * or `stdin`, so a refusal names what the caller actually handed over. */
type DraftRead =
  | { readonly ok: true; readonly label: string; readonly content: EmitDraft }
  | { readonly ok: false; readonly error: CliError };

type DraftBytes =
  | { readonly ok: true; readonly bytes: string }
  | { readonly ok: false; readonly error: CliError };

/** The failure arm both draft steps share: reading the bytes and understanding them fail the
 * same way to a caller, so they carry the same code and only the sentence differs. */
function unreadable(message: string): { readonly ok: false; readonly error: CliError } {
  return { ok: false, error: { code: "draftUnreadable", message } };
}

/** The draft's bytes, from the file `--draft` names or from the context's stdin when it names
 * none (or names `-`).
 *
 * The "nothing was piped" arm is the one guard worth having, and it covers both spellings of
 * stdin — the defaulted one and the explicit `-`: with a terminal on fd 0 the caller has not
 * piped anything and never will, so the command would otherwise hang on a read that can never
 * complete. Naming both ways in is more useful than blocking. It is the reading of fd 0 that
 * lives in the context (`cli/context.ts`), not this decision: the two failures arrive
 * distinguished and this is where each becomes the sentence the caller reads. */
function readDraftBytes(context: LocalContext, source: string | undefined): DraftBytes {
  if (source !== undefined && source !== STDIN) {
    try {
      return { ok: true, bytes: readFileSync(source, "utf8") };
    } catch (error) {
      return unreadable(`cannot read draft ${source}: ${errorMessage(error)}`);
    }
  }

  const read = context.readStdin();
  if (read.ok) {
    return { ok: true, bytes: read.bytes };
  }
  return unreadable(
    read.reason === "tty"
      ? "no draft: pass --draft <file>, or pipe the draft JSON on stdin"
      : `cannot read draft from stdin: ${read.message}`,
  );
}

/** Bytes → the three authored keys, or the reason there is no review to present. Two failures
 * are distinguished on purpose: `draftUnreadable` means the input was malformed, while
 * `draftEmpty` means it parsed perfectly and said nothing — a well-formed `{}` is a caller
 * asking to present a review it did not write, and silently emitting an empty artifact would
 * open a window with nothing in it. */
function readDraft(context: LocalContext, source: string | undefined): DraftRead {
  const read = readDraftBytes(context, source);
  if (!read.ok) {
    return read;
  }
  const label = source === undefined || source === STDIN ? "stdin" : source;

  let json: unknown;
  try {
    json = JSON.parse(read.bytes);
  } catch (error) {
    return unreadable(`draft ${label} is not valid JSON: ${errorMessage(error)}`);
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return unreadable(
      `draft ${label} must be a JSON object with "overview", "comments", and/or "layers"`,
    );
  }

  const { comments, layers, overview } = json as EmitDraft;
  if (comments === undefined && layers === undefined && overview === undefined) {
    return {
      ok: false,
      error: {
        code: "draftEmpty",
        message: `draft ${label} presents nothing: it needs an "overview", "comments", or "layers" (see \`rvw schema\`)`,
      },
    };
  }
  return { ok: true, label: `draft ${label}`, content: { comments, layers, overview } };
}
