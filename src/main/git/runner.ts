import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import { statSync } from "node:fs";
import type { Readable } from "node:stream";
import { MAX_PATCH_BYTES, hardenedGitEnv } from "../../shared/node/git-diff";
import { errnoCode } from "../../shared/errors";

// Spawn wrapper for the system git binary: argument arrays only (never a shell),
// explicit output cap, timeout, and child tracking so quit can terminate
// in-flight processes. Electron-free so the whole git layer is testable under
// plain node.

export type GitRunRequest = {
  cwd: string;
  args: readonly string[];
  /** Exit codes that still mean success — `git diff --no-index` exits 1 on differences. */
  okExitCodes?: readonly number[];
  maxOutputBytes?: number;
  timeoutMs?: number;
  /** Run git in a session of its own, with no controlling terminal — for the operations that
   * reach a remote (fetch, clone, a partial clone's lazy blob fetch). `GIT_TERMINAL_PROMPT=0`
   * (`hardenedGitEnv`) stops *git* asking for a password, but not ssh: ssh asks for a key's
   * passphrase or to trust a new host key by opening `/dev/tty` itself, and a child of an app
   * started from a terminal (`bun dev`, a binary exec'd by hand) inherits that terminal and
   * would sit waiting on it until the timeout. Without a controlling terminal ssh cannot ask,
   * so it fails at once with an answer the caller can map ("Permission denied", "Host key
   * verification failed"). Chosen over pinning `GIT_SSH_COMMAND="ssh -o BatchMode=yes"`,
   * which would override the reader's own `core.sshCommand` (a 1Password or Secretive agent
   * wrapper, say) and so break the very credentials the fetch is meant to use.
   *
   * Detached, git leads its own process group, so the timeout, a cancel and quit signal the
   * group rather than git alone: the ssh or `git-remote-https` it started would otherwise outlive it. */
  detached?: boolean;
  /** Stops the run when aborted — Review Pull Request…'s Cancel, for a fetch or clone that may
   * take minutes. The child (and, detached, its group) is stopped the way a timeout stops it —
   * SIGTERM, then SIGKILL after `KILL_GRACE_MS` — and the run answers `cancelled`; a signal
   * already aborted spawns nothing. Never pass one to an operation that must not stop halfway
   * (a checkout: `addDetachedWorktree` in `ops.ts`). */
  signal?: AbortSignal;
};

export type GitRunFailure =
  | { code: "gitMissing" }
  | { code: "cwdMissing"; cwd: string }
  | { code: "outputOverflow"; limitBytes: number }
  | { code: "timeout" }
  | { code: "cancelled" }
  | { code: "exited"; exitCode: number | null; stderr: string };

export type GitRunResult = { ok: true; stdout: string } | { ok: false; failure: GitRunFailure };

export type GitRunnerDefaults = {
  gitBinary?: string;
  maxOutputBytes?: number;
  /** How long a timed-out or cancelled child has to exit on SIGTERM before it is SIGKILLed —
   * `KILL_GRACE_MS` unless a test wants to wait less. */
  killGraceMs?: number;
};

export type GitRunner = {
  run: (request: GitRunRequest) => Promise<GitRunResult>;
  /** Terminates every in-flight git child; wired to app quit. */
  terminateAll: () => void;
  /** The cap a per-request override would otherwise default to; callers that
   * concatenate multiple outputs enforce it on the combined size too. */
  maxOutputBytes: number;
};

/** The shared review-patch ceiling: the typed overflow failure tells the user to narrow the
 * selection instead of silently truncating. Re-exported so a runner's callers name
 * a runner constant, while the value stays single-sourced with the CLI's capture. */
export const DEFAULT_MAX_OUTPUT_BYTES = MAX_PATCH_BYTES;
export const DEFAULT_TIMEOUT_MS = 30_000;

/** The grace between SIGTERM and SIGKILL for a timeout or a cancel. git cleans up after itself
 * on SIGTERM — `worktree add` deletes the half-written worktree and its registration, `clone`
 * deletes the directory it was writing, a fetch releases its `.lock` files — and does none of
 * that on SIGKILL, which is what left a truncated worktree registered `locked initializing`,
 * a clone directory every retry then refused, and lock files in the reader's repository. A few
 * seconds is plenty for that cleanup, and short enough that a git ignoring the signal still
 * goes. The output cap still kills at once: it only ever stops a read. */
export const KILL_GRACE_MS = 3_000;

/** stderr is only ever logged in main, never sent to the renderer — a small window
 * onto the failure is enough. */
const MAX_STDERR_BYTES = 64 * 1024;

/** Signals a child — and, for one spawned `detached`, its whole process group (a negative
 * pid), so the ssh or `git-remote-https` a network operation started goes down with git. Falls
 * back to the child alone when the group cannot be signalled (it has already exited). */
function killChild(child: ChildProcess, signal: NodeJS.Signals, group: boolean): void {
  if (group && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // ESRCH: the group is gone; the plain kill below is then a harmless no-op.
    }
  }
  child.kill(signal);
}

/** Symlinks are followed on purpose — a link to a work tree is a usable cwd. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function createGitRunner(defaults: GitRunnerDefaults = {}): GitRunner {
  const gitBinary = defaults.gitBinary ?? "git";
  const defaultMaxOutputBytes = defaults.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const killGraceMs = defaults.killGraceMs ?? KILL_GRACE_MS;
  /** Every in-flight child, with whether it leads its own process group (`detached`). */
  const children = new Map<ChildProcess, boolean>();

  function run(request: GitRunRequest): Promise<GitRunResult> {
    const maxOutputBytes = request.maxOutputBytes ?? defaultMaxOutputBytes;
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const okExitCodes = request.okExitCodes ?? [0];

    // A vanished cwd also surfaces as spawn ENOENT; without this check a deleted
    // repo would be misdiagnosed as a missing git binary. A path that exists but
    // is not a directory is refused by the same gate: spawn rejects it with a
    // *synchronous* throw (ENOTDIR), which would escape the promise contract.
    if (!isDirectory(request.cwd)) {
      return Promise.resolve({ ok: false, failure: { code: "cwdMissing", cwd: request.cwd } });
    }
    if (request.signal?.aborted === true) {
      return Promise.resolve({ ok: false, failure: { code: "cancelled" } });
    }

    // Hardened by `hardenedGitEnv` (src/shared/node/git-diff.ts) — the same posture the
    // CLI's spawnSync adapter uses, so the two spawn styles cannot drift on prompts,
    // optional locks, or locale (LC_ALL=C; the failure mapping in ops.ts pattern-matches
    // its English stderr). The GIT_* repo overrides it strips must not leak in: they would
    // silently redirect every operation to a different repository than the validated cwd.
    const env = hardenedGitEnv(process.env);

    return new Promise((resolve) => {
      // The stdio triple above: no stdin, piped stdout/stderr.
      let child: ChildProcessByStdio<null, Readable, Readable>;
      try {
        child = spawn(gitBinary, request.args, {
          cwd: request.cwd,
          stdio: ["ignore", "pipe", "pipe"],
          env,
          detached: request.detached === true,
        });
      } catch (error) {
        // The directory gate above covers the known synchronous throw; this keeps
        // the "resolves, never rejects" contract if the cwd changes underneath it.
        // Logged rather than swallowed: the gate already ruled out every cause we
        // know of, so anything landing here is worth seeing in the main-process log.
        console.error("git spawn threw synchronously:", error);
        resolve({ ok: false, failure: { code: "cwdMissing", cwd: request.cwd } });
        return;
      }
      children.set(child, request.detached === true);
      const kill = (signal: NodeJS.Signals): void =>
        killChild(child, signal, request.detached === true);

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      // Set by the timeout/overflow kill paths so `close` reports the real cause,
      // not the kill's exit code.
      let killFailure: GitRunFailure | null = null;
      let settled = false;

      let graceTimer: ReturnType<typeof setTimeout> | undefined;

      const settle = (result: GitRunResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(graceTimer);
        request.signal?.removeEventListener("abort", onAbort);
        children.delete(child);
        resolve(result);
      };

      /** A timeout or a cancel: SIGTERM, so git can clean up (`KILL_GRACE_MS` says what it
       * cleans), then SIGKILL if it has not exited by the end of the grace. */
      const stop = (cause: GitRunFailure): void => {
        if (killFailure !== null) return;
        killFailure = cause;
        kill("SIGTERM");
        graceTimer = setTimeout(() => kill("SIGKILL"), killGraceMs);
      };

      const timer = setTimeout(() => stop({ code: "timeout" }), timeoutMs);

      const onAbort = (): void => stop({ code: "cancelled" });
      request.signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxOutputBytes) {
          if (killFailure === null) {
            killFailure = { code: "outputOverflow", limitBytes: maxOutputBytes };
            kill("SIGKILL");
          }
          return;
        }
        stdoutChunks.push(chunk);
      });

      child.stderr.on("data", (chunk: Buffer) => {
        if (stderrBytes >= MAX_STDERR_BYTES) return;
        stderrBytes += chunk.length;
        stderrChunks.push(chunk);
      });

      child.on("error", (error: NodeJS.ErrnoException) => {
        // Spawn ENOENT here is the git binary itself: a vanished or non-directory cwd was
        // already refused above, so this is the one remaining way to get it.
        settle({
          ok: false,
          failure:
            errnoCode(error) === "ENOENT"
              ? { code: "gitMissing" }
              : { code: "exited", exitCode: null, stderr: String(error) },
        });
      });

      child.on("close", (exitCode) => {
        if (killFailure !== null) {
          settle({ ok: false, failure: killFailure });
          return;
        }
        if (exitCode !== null && okExitCodes.includes(exitCode)) {
          settle({ ok: true, stdout: Buffer.concat(stdoutChunks).toString("utf8") });
          return;
        }
        settle({
          ok: false,
          failure: {
            code: "exited",
            exitCode,
            stderr: Buffer.concat(stderrChunks).toString("utf8"),
          },
        });
      });
    });
  }

  function terminateAll(): void {
    for (const [child, group] of children) {
      killChild(child, "SIGTERM", group);
    }
    children.clear();
  }

  return { run, terminateAll, maxOutputBytes: defaultMaxOutputBytes };
}
