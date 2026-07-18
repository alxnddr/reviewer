import { basename, join } from "node:path";
import { REVIEW_EXTENSION } from "../src/shared/review-file";

// Where `rvw emit` writes a review when it is given no `--out`. A refs-only artifact points at
// its repo by absolute path and the app re-derives the diff — so it does not belong *in* the
// repo, where it would be untracked clutter to gitignore and sweep up.
// It is a handoff file the app imports into its own session store; rvw therefore owns one
// user-level directory for it, outside every repo, and `rvw open` reaches it wherever it is.
// Both functions take their environment (env, home, timestamp) as arguments so the location
// and the derived name are proven without mutating `process.env` or reading the clock.

/** The reviews directory: `$RVW_HOME/reviews` when RVW_HOME is set — one override, for a user
 * who wants it elsewhere and for a test that must not touch the real home — else the default
 * `~/.rvw/reviews`. The caller creates it (mkdir -p) before writing; this only names it. */
export function reviewsDir(env: NodeJS.ProcessEnv, home: string): string {
  const override = env.RVW_HOME;
  if (override !== undefined && override.length > 0) {
    return join(override, "reviews");
  }
  return join(home, ".rvw", "reviews");
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
  const repo = slug(basename(repoPath)) || "review";
  return `${repo}-${slug(base)}-${slug(head)}-${stamp}${REVIEW_EXTENSION}`;
}

/** A ref or repo name reduced to a short, filesystem-safe token: runs of non-alphanumerics
 * (slashes, dots, spaces) collapse to a single `-`, the ends are trimmed of `-`, and the
 * result is capped. Empty in, empty out — the caller supplies the fallback. */
function slug(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 16);
}
