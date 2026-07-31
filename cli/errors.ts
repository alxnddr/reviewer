import { EXIT_CANNOT_RUN, type LocalContext } from "./context";

// How the CLI reports the failures that are not review verdicts. Exit 1 is a *review* answer
// and every verb renders it in its own shape; exit 2 is "the shell could not run", and there is
// exactly one shape for that, here, so a caller reads one contract whichever verb produced it.
//
// The load-bearing part is the channel split. An agent that passed `--json` opted out of prose,
// so a cannot-run must reach it as `{"ok":false,"error":{"code","message"}}` on stdout rather
// than as a stderr line it would have to parse anyway; without `--json` it stays a plain stderr
// message. Same failure, same code, two renderings — the decision lives in `writeCannotRun` and
// nowhere else, so no verb can forget half of it.
//
// `writeJson` is the other half of that: the envelope and every verb's own `--json` document —
// an exit-1 verdict as much as a clean pass — are one wire format to the caller reading them, so
// they are written by the same line here rather than by eleven hand-rolled
// `JSON.stringify(x, null, 2)` calls that can each drift.

/** Why the shell could not run — a closed set, because an agent branching on a failure needs
 * the reason to be a token it can switch on rather than a sentence it has to match. Each code
 * names a distinct thing for the caller to *do*:
 *
 * - `badRef` — a `--base`/`--head` this repo cannot resolve: fix the revision.
 * - `noBase` — nothing to default `--base` to: pass one.
 * - `gitFailed` — git ran and refused (absent repo, oversized diff): fix the range or the cwd.
 * - `draftUnreadable` — the draft could not be read or is not a JSON object: fix the input.
 * - `draftEmpty` — the draft is well-formed and presents nothing: there is no review to show.
 * - `badArtifactPath` — a path that is not a usable `.reviewer.json`.
 * - `artifactUnreadable` — the artifact file itself could not be read.
 * - `writeFailed` — the gate passed but the bytes could not land.
 * - `notInstalled` — the app could not be launched (usually: it is not installed).
 * - `noSuchSkill` / `skillsUnreadable` — the bundled skills could not be named or listed.
 * - `internal` — the cores contradicted each other; a bug, reported rather than asserted away.
 */
export type CliErrorCode =
  | "badRef"
  | "noBase"
  | "gitFailed"
  | "draftUnreadable"
  | "draftEmpty"
  | "badArtifactPath"
  | "artifactUnreadable"
  | "writeFailed"
  | "notInstalled"
  | "noSuchSkill"
  | "skillsUnreadable"
  | "internal";

/** One cannot-run failure: the machine-readable reason and the human sentence. Carried as a
 * value rather than written straight to a stream so the git/range/draft helpers can hand a
 * typed failure back up and let the command body pick the channel. */
export type CliError = { readonly code: CliErrorCode; readonly message: string };

/** The `--json` failure document. `ok: false` sits at the top level, matching the success
 * shapes, so one field decides whether to read the rest. */
export type CliErrorEnvelope = { readonly ok: false; readonly error: CliError };

/** The CLI's one `--json` rendering: pretty-printed on stdout with a trailing newline, so
 * every document a caller may pipe — a report, a resolved range, a skill, this module's error
 * envelope — arrives in the same shape. Two spaces because the output is read by agents *and*
 * by the humans watching them, and a single-line blob is neither. */
export function writeJson(context: LocalContext, value: unknown): void {
  context.process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Report a cannot-run on the channel the caller opted into, and set exit 2. The single
 * place the 2-with-a-reason contract is honored: every verb's exit-2 path routes through
 * here, so `--json` can never degrade to a bare stderr line. */
export function writeCannotRun(
  context: LocalContext,
  json: boolean | undefined,
  error: CliError,
): void {
  if (json === true) {
    const envelope: CliErrorEnvelope = { ok: false, error };
    writeJson(context, envelope);
  } else {
    context.process.stderr.write(`${error.message}\n`);
  }
  context.process.exitCode = EXIT_CANNOT_RUN;
}
