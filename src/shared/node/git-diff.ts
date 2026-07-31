// The git spawn config every caller shares: the diff wire-format (pinned config + flags
// that make `git diff` byte-stable regardless of the user's git config — no external diff
// drivers, no color, canonical a/-b/ prefixes, unescaped UTF-8 paths, and rename detection
// so the patch carries file-status information) and the child-process env hardening
// (`GIT_ENV_PINS`, `GIT_ENV_STRIP`, `hardenedGitEnv`). Shared so the app's git runner and
// the CLI's patch capture emit the *same* bytes and spawn with the *same* posture: a drift
// between the two would break anchor placement against an embedded patch (the reliability
// lever) or let one of the two spawn styles silently regress on prompts/locks/locale.
//
// Under `shared/node/` because both of those callers are node-side and nothing in the
// renderer spawns git. Nothing here imports `node:`, but the directory marks the audience:
// the renderer bundle has no business carrying an argv for a subprocess it cannot start.

export const DIFF_CONFIG = [
  "-c",
  "core.quotepath=false",
  "-c",
  "diff.noprefix=false",
  "-c",
  "diff.mnemonicPrefix=false",
] as const;

export const DIFF_ARGS = [
  "diff",
  "--no-color",
  "--no-ext-diff",
  "--find-renames",
  "--patch",
] as const;

/** A patch this large is beyond reviewable anyway; the app's runner and the CLI's both cap
 * git's output here so a range that overflows is refused with an actionable message rather
 * than silently truncated. One constant, so the two capture paths cannot drift. */
export const MAX_PATCH_BYTES = 32 * 1024 * 1024;

/** A review range as git spells it: three-dot (merge-base) semantics — only what `head`
 * adds over the common ancestor, the way a PR is read. Two-dot would include everything
 * `base` gained since the fork, a diff no reviewer asked for. */
export function rangeSpec(base: string, head: string): string {
  return `${base}...${head}`;
}

/** The full argument vector for a committed diff. Built here, once, because a drift
 * between the app's capture and the CLI's (a two-dot range, a dropped `--`) would produce
 * a patch whose line numbers no longer match the anchors authored against it, silently
 * invalidating every coverage number and anchor placement. */
export function committedDiffArgs(revs: readonly string[]): string[] {
  return [...DIFF_CONFIG, ...DIFF_ARGS, ...revs, "--"];
}

/** The argument vector for a review range's diff — shared by the CLI's capture and the
 * app's `reviewRefs` selection. */
export function rangeDiffArgs(base: string, head: string): string[] {
  return committedDiffArgs([rangeSpec(base, head)]);
}

/** The env vars every spawned git is pinned to: never let it hang on a credential prompt or
 * take an optional lock (all our operations are read-only), and pin stderr to English so a
 * failure message — including the `Binary files … differ` marker — parses the same regardless
 * of the caller's locale. */
export const GIT_ENV_PINS = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  LC_ALL: "C",
} as const;

/** The `GIT_*` repo overrides that must never leak into a spawned git: they would silently
 * redirect the operation to a different repository than the validated cwd/`--repo`, whose
 * internally-consistent output would still look valid. Adding `GIT_CONFIG_GLOBAL` later is one
 * edit here instead of one in each runner. */
export const GIT_ENV_STRIP = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"] as const;

/** Build a spawn env from `base` (normally `process.env`) with `GIT_ENV_PINS` applied and
 * `GIT_ENV_STRIP` removed. The one function both the CLI's sync `spawnSync` adapter
 * (cli/git.ts) and the app's async/streaming runner (src/main/git/runner.ts) build their
 * child's env from, so the two spawn styles can differ freely while the env posture — the
 * security-relevant part — cannot drift between them. */
export function hardenedGitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...GIT_ENV_PINS };
  for (const key of GIT_ENV_STRIP) {
    delete env[key];
  }
  return env;
}
