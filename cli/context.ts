import type { StricliProcess } from "@stricli/core";

// The context Stricli threads into every command as `this`, plus the one place the
// CLI's exit-code contract is normalized. Stricli owns argument scanning, routing, and
// help; the command bodies own the review domain (reused, never re-derived) and their
// own stdout/stderr/exit code through this context. Keeping the process behind a
// narrow interface is also what lets the command tests drive `run(...)` against
// capturing streams instead of the real process.

/** The command context: just the process streams Stricli needs plus the settable
 * `exitCode` a command uses to declare its outcome. Extends nothing app-specific —
 * the CLI is a thin shell, so there is no session/db to carry. */
export interface LocalContext {
  readonly process: StricliProcess;
}

/** Adapt the real Node process to Stricli's minimal process interface for the shipped
 * entrypoint. The streams are the real ones (output reaches the terminal); `exitCode`
 * starts `null` so Stricli's `??=` fills it, and the entrypoint reads it back to set the
 * real `process.exitCode` — so this wrapper needs no write-through to `process`. `null`
 * (not `undefined`) because Stricli types the field `number | string | null`. */
export function buildContext(nodeProcess: NodeJS.Process): LocalContext {
  return {
    process: {
      stdout: nodeProcess.stdout,
      stderr: nodeProcess.stderr,
      exitCode: null,
    },
  };
}

// The CLI's entire public contract is these three codes: 0 ready, 1 ran and found problems,
// 2 the shell itself could not run. Commands declare their outcome by
// setting `this.process.exitCode` to one of these; the app wiring maps every other
// path onto them (see `normalizeExitCode` and the app's `determineExitCode`).
export const EXIT_READY = 0;
export const EXIT_PROBLEMS = 1;
export const EXIT_CANNOT_RUN = 2;

/** Collapse the raw `process.exitCode` left after a run into the 0/1/2 contract. A
 * command's own 0/1/2 passes through unchanged. Stricli's argument-scan and routing
 * failures (a bad verb, an unparseable/missing argument) surface as its *negative*
 * ExitCode values, which are not part of our contract and mean "could not run", so they
 * map to 2. A command body that *throws* is handled earlier by the app's
 * `determineExitCode` (Stricli's own `CommandRunError` is a positive 1 that must not be
 * read as our "problems"), so it never reaches here as a bare 1. Any other unexpected
 * value collapses to 2 rather than leaking out uncontained. */
export function normalizeExitCode(raw: number | string | null | undefined): number {
  if (raw === EXIT_PROBLEMS) return EXIT_PROBLEMS;
  if (raw === EXIT_CANNOT_RUN) return EXIT_CANNOT_RUN;
  if (raw === EXIT_READY || raw === null || raw === undefined) return EXIT_READY;
  return EXIT_CANNOT_RUN;
}
