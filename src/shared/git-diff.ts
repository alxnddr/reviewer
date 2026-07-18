// The diff wire-format: pinned config + flags that make `git diff` byte-stable
// regardless of the user's git config — no external diff drivers, no color, canonical
// a/-b/ prefixes, unescaped UTF-8 paths, and rename detection so the patch carries
// file-status information. Shared so the app's git runner and the CLI's patch capture
// emit the *same* bytes: a drift between the two would break anchor placement against
// an embedded patch, the reliability lever.

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
