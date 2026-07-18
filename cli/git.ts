import { spawnSync } from "node:child_process";
import { MAX_PATCH_BYTES, rangeDiffArgs } from "../src/shared/git-diff";
import { ReviewRef } from "../src/shared/git";
import type { ReviewArtifact } from "../src/shared/review";

// The one hardened git runner the CLI shares: `rvw anchors`, `rvw coverage --draft`, and
// `rvw emit` all capture the range's diff through this module, so there is a single spawn
// posture and a single capture — not a forked one per verb. It returns a typed outcome
// rather than exiting: a command body owns the exit-code contract by setting
// `this.process.exitCode`, so the runner hands back success-or-message and lets the caller
// map a failure onto exit 2. The shell effect stays the command's; the runner is a thin
// adapter over `spawnSync`.

/** git stdout, or the reason the spawn could not produce it — the command maps a failure
 * onto exit 2 (shell-cannot-run). Never both, and never a thrown stack trace: every git
 * failure surfaces as an actionable message. */
export type GitCapture = { ok: true; stdout: string } | { ok: false; message: string };

/** The patch for a range plus the repo's canonical toplevel — the shared capture
 * `anchors`/`coverage --draft` read and `emit` also writes into `source.repo.path`. */
export type PatchCapture =
  | { ok: true; repoPath: string; patch: string }
  | { ok: false; message: string };

/** Run git in the target repo and return stdout, or a typed failure. Env is hardened like
 * the app runner (src/main/git/runner.ts): the `GIT_*` repo overrides are scrubbed — they
 * would redirect the diff to a different repo than `--repo`, whose internally-consistent
 * output would still look valid — and `LC_ALL=C` pins stderr to English so a failure
 * message is stable regardless of the agent's locale. */
export function git(repo: string, args: readonly string[]): GitCapture {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
  };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;

  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env,
    maxBuffer: MAX_PATCH_BYTES,
  });
  // A diff past the cap is an ENOBUFS error (not a non-zero exit); name it precisely so
  // "narrow the range" is actionable rather than a mislabeled "git failed".
  if (result.error !== undefined && "code" in result.error && result.error.code === "ENOBUFS") {
    return {
      ok: false,
      message: `git ${args.join(" ")} produced more than ${MAX_PATCH_BYTES} bytes — narrow the range and re-run`,
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
 * `DIFF_CONFIG`/`DIFF_ARGS` `emit` embeds and the app re-derives, so coverage and anchors
 * describe the exact diff a reviewer will see. A rev-expression like `HEAD~2` is rejected here
 * as an artifact ref: an anchors/coverage range pins to a branch or a full sha, never an
 * arbitrary revision the diff can't be reproduced from. `--show-toplevel` normalizes whatever
 * cwd was passed to the canonical repo root. */
export function capturePatch(repo: string, base: string, head: string): PatchCapture {
  const baseRef = ReviewRef.safeParse(base);
  if (!baseRef.success) {
    return { ok: false, message: `--base ${base} is not a valid ref (a branch name or full sha)` };
  }
  const headRef = ReviewRef.safeParse(head);
  if (!headRef.success) {
    return { ok: false, message: `--head ${head} is not a valid ref (a branch name or full sha)` };
  }

  const toplevel = git(repo, ["rev-parse", "--show-toplevel"]);
  if (!toplevel.ok) {
    return toplevel;
  }
  const patch = git(repo, rangeDiffArgs(base, head));
  if (!patch.ok) {
    return patch;
  }
  return { ok: true, repoPath: toplevel.stdout.trim(), patch: patch.stdout };
}

/** The diff a finished artifact's anchors place against. Refs-only is the common path
 * the CLI emits: no `patch` is stored, so the diff is re-derived live from the artifact's own
 * `source` (repo.path/base/head) — the same `base...head` capture the app renders from, so a
 * re-validation matches what a reviewer sees, but it needs the repo present. A rare imported
 * artifact that still carries a frozen `patch` is honored verbatim (no git), so it validates
 * offline exactly as the app renders it frozen. */
export function artifactDiff(artifact: ReviewArtifact): PatchCapture {
  if (artifact.patch !== undefined && artifact.patch.length > 0) {
    return { ok: true, repoPath: artifact.source.repo.path, patch: artifact.patch };
  }
  return capturePatch(artifact.source.repo.path, artifact.source.base, artifact.source.head);
}
