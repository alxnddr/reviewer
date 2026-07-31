import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { StricliProcess } from "@stricli/core";
import { errorMessage } from "../src/shared/errors";

// The context Stricli threads into every command as `this`, plus the one place the
// CLI's exit-code contract is normalized. Stricli owns argument scanning, routing, and
// help; the command bodies own the review domain (reused, never re-derived) and their
// own stdout/stderr/exit code through this context. Keeping the process behind a
// narrow interface is also what lets the command tests drive `run(...)` against
// capturing streams instead of the real process.
//
// Which is why the interface carries the whole process surface a verb reads, not just the
// streams. The working directory a range defaults from, `$RVW_HOME`, the home directory under
// it, the platform the launcher branches on and the draft on fd 0 were each read from the
// global `process` inside a command body, so proving any of them meant mutating the real
// process — `chdir`, a redefined `isTTY`, a redefined `platform` — or building a git repo in a
// temp dir for an assertion that was never about git. They are fields now: the entrypoint fills
// them from the real process, a test fills them with what it is proving, and the command bodies
// read one interface either way.

/** What fd 0 had for us, or why it had nothing. The two failures stay distinct because they
 * mean opposite things to a caller: `tty` is a terminal on fd 0 — nothing was piped and nothing
 * ever will be, so the read would never complete — while `failed` is fd 0 refusing a read that
 * was legitimately attempted. The sentence each becomes is the command's to write. */
export type StdinRead =
  | { readonly ok: true; readonly bytes: string }
  | { readonly ok: false; readonly reason: "tty" }
  | { readonly ok: false; readonly reason: "failed"; readonly message: string };

/** The command context: the process streams Stricli needs, the settable `exitCode` a command
 * uses to declare its outcome, and the rest of the process a verb is allowed to know about.
 * Extends nothing app-specific — the CLI is a thin shell, so there is no session/db to carry. */
export interface LocalContext {
  readonly process: StricliProcess;
  /** Where the caller is standing: the directory an omitted `--repo` resolves its work-tree
   * toplevel from. A value rather than a getter because `rvw` runs one command and exits — the
   * directory it started in is the one it resolves against. */
  readonly cwd: string;
  /** The environment: `$RVW_HOME` (where an artifact lands when `--out` is omitted) and the
   * base every spawned git's hardened env is built from. Stricli's own `process.env` field is
   * deliberately left unset — those are its two `STRICLI_*` variables, and honoring them would
   * be a behaviour change nobody asked for; this is the CLI's own environment. */
  readonly env: NodeJS.ProcessEnv;
  /** The platform the launcher branches on: Reviewer ships for darwin, and everywhere else the
   * caller is told how to open the artifact by hand. */
  readonly platform: NodeJS.Platform;
  /** The home directory the default reviews dir hangs under (`~/.rvw/reviews`). */
  readonly home: string;
  /** The draft on stdin, read whole. A function rather than a field because reading fd 0 is an
   * effect, and one no verb performs unless the caller actually asked for a piped draft. */
  readonly readStdin: () => StdinRead;
}

/** Adapt the real Node process to the interface above for the shipped entrypoint. The streams
 * are the real ones (output reaches the terminal); `exitCode` starts `null` so Stricli's `??=`
 * fills it, and the entrypoint reads it back to set the real `process.exitCode` — so this
 * wrapper needs no write-through to `process`. `null` (not `undefined`) because Stricli types
 * the field `number | string | null`. `home` comes from `homedir()` rather than `$HOME`, which
 * is the one field the process object does not carry. */
export function buildContext(nodeProcess: NodeJS.Process): LocalContext {
  return {
    process: {
      stdout: nodeProcess.stdout,
      stderr: nodeProcess.stderr,
      exitCode: null,
    },
    cwd: nodeProcess.cwd(),
    env: nodeProcess.env,
    platform: nodeProcess.platform,
    home: homedir(),
    readStdin: () => readStdin(nodeProcess),
  };
}

/** fd 0, read synchronously — which is what lets a command body stay a plain synchronous
 * function, the same posture as every other read in the CLI, and what lets the entrypoint set
 * `process.exitCode` and let the loop drain with nothing holding it open. The TTY check comes
 * first and is the guard worth having: with a terminal on fd 0 the read can never complete, so
 * `rvw` would hang forever with nothing on either stream — the one failure an agent cannot act
 * on. */
function readStdin(nodeProcess: NodeJS.Process): StdinRead {
  if (nodeProcess.stdin.isTTY === true) {
    return { ok: false, reason: "tty" };
  }
  try {
    return { ok: true, bytes: readFileSync(0, "utf8") };
  } catch (error) {
    return { ok: false, reason: "failed", message: errorMessage(error) };
  }
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
