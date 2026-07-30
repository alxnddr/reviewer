import { REVIEW_EXTENSION } from "./review-file";

// Where `rvw emit` writes a review when it is given no `--out`, and — because it is the same
// place — where the app looks to list what has been reviewed before. A refs-only artifact
// points at its repo by absolute path and the app re-derives the diff, so it does not belong
// *in* the repo, where it would be untracked clutter to gitignore and sweep up. It is a handoff
// file the app imports into its own session store; rvw therefore owns one user-level directory
// for it, outside every repo, and `rvw open` reaches it wherever it is.
//
// This lives in shared rather than in `cli/` because it is now a *contract between two
// programs*: the CLI writes here and the app reads here, and a copy of the rule on each side is
// a feature that goes quietly empty the day one of them changes. Both functions take their
// environment (env, home, timestamp) as arguments so the location and the derived name are
// proven without mutating `process.env` or reading the clock.
//
// Node-free on purpose, like `review.ts` and for the same reason: shared is compiled into the
// renderer bundle, so `node:path` cannot be imported here. v1 is macOS-only and every path
// involved is absolute POSIX, so joining with `/` and taking the last segment is exactly what
// `join`/`basename` would have done.

/** The reviews directory: `$RVW_HOME/reviews` when RVW_HOME is set — one override, for a user
 * who wants it elsewhere and for a test that must not touch the real home — else the default
 * `~/.rvw/reviews`. The caller creates it (mkdir -p) before writing; this only names it. */
export function reviewsDir(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string {
  const override = env.RVW_HOME;
  const root = override !== undefined && override.length > 0 ? override : `${trimEnd(home)}/.rvw`;
  return `${trimEnd(root)}/reviews`;
}

/** A filename for a review of `repoPath`'s `base..head`. Every component is slugged to a
 * filesystem-safe token — a branch ref carries slashes a path separator would swallow, a sha
 * does not — and each ref is capped so a 40-char sha does not swamp the name. `stamp` (the
 * caller's `Date.now()`) makes each emit unique, so re-reviewing a range never silently
 * clobbers an earlier artifact the user has not opened yet; it is injected, not read here, so
 * the name is deterministic under test. */
export function reviewFileName(
  repoPath: string,
  base: string,
  head: string,
  stamp: number,
): string {
  const repo = slug(lastSegment(repoPath)) || "review";
  return `${repo}-${slug(base)}-${slug(head)}-${stamp}${REVIEW_EXTENSION}`;
}

/** A path's last non-empty segment — `basename`, for the absolute POSIX paths this module
 * deals in. `/` has no segment and yields the empty string, which `reviewFileName` reads as
 * "no name here" and replaces with its fallback. */
export function lastSegment(path: string): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments.at(-1) ?? "";
}

/** Trailing separators dropped, so a home or an `RVW_HOME` given with one does not produce a
 * doubled slash mid-path. A lone `/` trims to empty, which is the right root to join onto. */
function trimEnd(path: string): string {
  return path.replace(/\/+$/u, "");
}

/** A ref or repo name reduced to a short, filesystem-safe token: runs of non-alphanumerics
 * (slashes, dots, spaces) collapse to a single `-`, the ends are trimmed of `-`, and the
 * result is capped. Empty in, empty out — the caller supplies the fallback. */
function slug(value: string): string {
  return value
    .replaceAll(/[^a-zA-Z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 16);
}
