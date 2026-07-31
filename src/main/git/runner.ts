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
};

export type GitRunFailure =
  | { code: "gitMissing" }
  | { code: "cwdMissing"; cwd: string }
  | { code: "outputOverflow"; limitBytes: number }
  | { code: "timeout" }
  | { code: "exited"; exitCode: number | null; stderr: string };

export type GitRunResult = { ok: true; stdout: string } | { ok: false; failure: GitRunFailure };

export type GitRunnerDefaults = {
  gitBinary?: string;
  maxOutputBytes?: number;
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

/** stderr is only ever logged in main, never sent to the renderer — a small window
 * onto the failure is enough. */
const MAX_STDERR_BYTES = 64 * 1024;

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
  const children = new Set<ChildProcess>();

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
      children.add(child);

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      // Set by the timeout/overflow kill paths so `close` reports the real cause,
      // not the kill's exit code.
      let killFailure: GitRunFailure | null = null;
      let settled = false;

      const settle = (result: GitRunResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        children.delete(child);
        resolve(result);
      };

      const timer = setTimeout(() => {
        killFailure = { code: "timeout" };
        child.kill("SIGKILL");
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxOutputBytes) {
          if (killFailure === null) {
            killFailure = { code: "outputOverflow", limitBytes: maxOutputBytes };
            child.kill("SIGKILL");
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
    for (const child of children) {
      child.kill("SIGTERM");
    }
    children.clear();
  }

  return { run, terminateAll, maxOutputBytes: defaultMaxOutputBytes };
}
