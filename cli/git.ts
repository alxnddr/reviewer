import { spawnSync } from "node:child_process";
import { MAX_PATCH_BYTES, hardenedGitEnv, rangeDiffArgs } from "../src/shared/node/git-diff";
import { ReviewRef } from "../src/shared/git";
import type { ReviewArtifact } from "../src/shared/review";

// The one hardened git runner the CLI shares: `rvw range` resolution, `rvw diff`, `rvw emit`
// and `rvw check` all reach git through this module, so there is a single spawn posture and a
// single capture — not a forked one per verb. It returns a typed outcome rather than exiting:
// a command body owns the exit-code contract by setting `this.process.exitCode`, so the runner
// hands back success-or-message and lets the caller map a failure onto exit 2. The shell effect
// stays the command's; the runner is a thin adapter over `spawnSync`.

/** git stdout, or the reason the spawn could not produce it — the command maps a failure
 * onto exit 2 (shell-cannot-run). Never both, and never a thrown stack trace: every git
 * failure surfaces as an actionable message. */
export type GitCapture = { ok: true; stdout: string } | { ok: false; message: string };

/** The bytes of a range's diff — the one thing every anchor is judged against, so `diff`
 * prints exactly this and `emit`/`check` validate against exactly this. */
export type PatchCapture = { ok: true; patch: string } | { ok: false; message: string };

/** The deadline a single git child gets, the same 30s the app runner enforces
 * (`DEFAULT_TIMEOUT_MS` in src/main/git/runner.ts). Read-only operations on a healthy repo
 * finish in milliseconds; the ones that do not — a stalled network mount, an `fsmonitor`, a
 * hook waiting on something — would otherwise hang `rvw` forever with nothing on either
 * stream, which is the one failure an agent cannot act on. */
const TIMEOUT_MS = 30_000;

/** Run git in the target repo and return stdout, or a typed failure. The environment is the
 * caller's (`context.env` — the CLI reads no global here, so a suite proves the spawn posture
 * against an env it chose) and is hardened by `hardenedGitEnv` (src/shared/node/git-diff.ts)
 * before the child sees it — the same posture the app runner spawns with, so the two spawn
 * styles (this one's sync `spawnSync`, the app's async/streaming one) cannot drift on the part
 * that must not: prompts, optional locks, locale, and the `GIT_*` repo overrides that would
 * redirect the diff to a different repo than `--repo`. */
export function git(env: NodeJS.ProcessEnv, repo: string, args: readonly string[]): GitCapture {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: hardenedGitEnv(env),
    maxBuffer: MAX_PATCH_BYTES,
    timeout: TIMEOUT_MS,
  });
  // Neither overflowing the cap nor running past the deadline is a non-zero exit: both kill
  // the child and arrive as a spawn error, so they are named here rather than falling through
  // to the generic "git failed" with no exit code and no stderr to explain it.
  const spawnErrorCode =
    result.error !== undefined && "code" in result.error ? result.error.code : undefined;
  // A diff past the cap is an ENOBUFS error; name it precisely so "narrow the range" is
  // the actionable thing the caller is told.
  if (spawnErrorCode === "ENOBUFS") {
    return {
      ok: false,
      message: `git ${args.join(" ")} produced more than ${MAX_PATCH_BYTES} bytes — narrow the range and re-run`,
    };
  }
  if (spawnErrorCode === "ETIMEDOUT") {
    return {
      ok: false,
      message: `git ${args.join(" ")} did not finish within ${TIMEOUT_MS / 1000}s — the repo may be on a stalled mount, or a hook or fsmonitor is holding it`,
    };
  }
  if (result.status !== 0) {
    // A missing git binary yields `status: null` and `stderr: undefined` with an `error`,
    // so guard both before surfacing a clean message instead of a stack trace.
    const detail =
      (result.stderr ?? "").trim() || result.error?.message || `exit ${result.status ?? "signal"}`;
    return { ok: false, message: `git ${args.join(" ")} failed: ${detail}` };
  }
  return { ok: true, stdout: result.stdout };
}

/** Validate the endpoints as artifact refs (before any spawn) then capture the byte-stable
 * patch for `base...head` — the same three-dot merge-base range and the same
 * `DIFF_CONFIG`/`DIFF_ARGS` the app re-derives, so `rvw diff`, the emit gate, and the rendered
 * review all describe the exact same bytes.
 *
 * The endpoints arriving here are already artifact-shaped: a live range came through
 * `cli/range.ts`, which turned whatever revision the agent typed into a branch name or a full
 * sha, and a finished artifact's came through the schema. The `ReviewRef` check is therefore
 * not a user-facing rejection but the spawn boundary itself — a hand-edited artifact must not
 * smuggle a flag or a rev expression into a `git` child, and validating before the spawn is
 * how every other ref-bearing path in this codebase behaves. */
export function capturePatch(
  env: NodeJS.ProcessEnv,
  repo: string,
  base: string,
  head: string,
): PatchCapture {
  if (!ReviewRef.safeParse(base).success) {
    return { ok: false, message: `base ${base} is not a valid ref (a branch name or full sha)` };
  }
  if (!ReviewRef.safeParse(head).success) {
    return { ok: false, message: `head ${head} is not a valid ref (a branch name or full sha)` };
  }
  const captured = git(env, repo, rangeDiffArgs(base, head));
  return captured.ok ? { ok: true, patch: captured.stdout } : captured;
}

/** The diff a finished artifact's anchors place against. Refs-only is the common path
 * the CLI emits: no `patch` is stored, so the diff is re-derived live from the artifact's own
 * `repo`/`base`/`head` — the same `base...head` capture the app renders from, so a
 * re-validation matches what a reviewer sees, but it needs the repo present. A rare imported
 * artifact that still carries a frozen `patch` is honored verbatim (no git), so it validates
 * offline exactly as the app renders it frozen. */
export function artifactDiff(env: NodeJS.ProcessEnv, artifact: ReviewArtifact): PatchCapture {
  if (artifact.patch !== undefined && artifact.patch.length > 0) {
    return { ok: true, patch: artifact.patch };
  }
  return capturePatch(env, artifact.repo, artifact.base, artifact.head);
}
